import { initLlama, type LlamaContext } from 'llama.rn';
import type { ChatMessage, CompletionRequest, CompletionResult, Embedder, LLM, TemplateOptions } from '@aura/core';

// llama.rn behind core's LLM / Embedder interfaces — the in-process equivalent of the
// llama-server adapters used on the laptop (same GGUF, grammars and KV-cache reuse).

const fileName = (path: string) => path.split('/').pop()!.replace(/\.gguf$/i, '');

/** One llama context runs one completion at a time; calls queue up behind each other. */
class Mutex {
  private tail: Promise<void> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export interface LoadOptions {
  /** Context length — from the device-fit check (never more than the safe maximum). */
  nCtx: number;
  /**
   * Use the GPU (OpenCL on Android). Off by default: on the S23 Ultra, long prompts kept llama.cpp's
   * OpenCL kernels on the Adreno GPU for so long that nothing else could draw: the app, System UI
   * and the recents screen all froze waiting on GPU fences (ANR traces, 2026-11-12), and it ran hot.
   * OpenCL also only supports Q4_0/Q6_K weights, not our Q4_K_M. The CPU path uses the fast
   * repacked (dotprod/i8mm) kernels and leaves the GPU to the UI.
   */
  gpu?: boolean;
  /** CPU threads. Default 4 = the fast cores on current phones (more threads land on slow efficiency cores and get slower). */
  nThreads?: number;
  onProgress?: (pct: number) => void;
}

export class LlamaRnLLM implements LLM {
  private mutex = new Mutex();

  private constructor(
    readonly ctx: LlamaContext,
    readonly id: string,
    readonly contextLength: number,
  ) {}

  static async load(path: string, opts: LoadOptions): Promise<LlamaRnLLM> {
    const ctx = await initLlama(
      {
        model: path,
        n_ctx: opts.nCtx,
        // ['CPU'] = no offload devices at all (n_gpu_layers 0 alone can still offload big batches).
        ...(opts.gpu ? { n_gpu_layers: 99 } : { n_gpu_layers: 0, devices: ['CPU'] }),
        n_threads: opts.nThreads ?? 4,
        n_batch: 512,
        use_mmap: true,
        use_mlock: false, // locking GB of weights in RAM is how phones get bricked
        ctx_shift: false, // the engine keeps prompts within budget itself
      },
      opts.onProgress,
    );
    return new LlamaRnLLM(ctx, fileName(path), opts.nCtx);
  }

  async countTokens(text: string): Promise<number> {
    return (await this.ctx.tokenize(text)).tokens.length;
  }

  async applyTemplate(messages: ChatMessage[], opts: TemplateOptions): Promise<string> {
    const r = await this.ctx.getFormattedChat(messages, null, {
      jinja: true, enable_thinking: opts.thinking, add_generation_prompt: true,
    });
    return r.prompt;
  }

  complete(req: CompletionRequest): Promise<CompletionResult> {
    return this.mutex.run(async () => {
      if (req.signal?.aborted) return empty('abort');
      const onAbort = () => void this.ctx.stopCompletion();
      req.signal?.addEventListener('abort', onAbort);
      const t0 = Date.now();
      let ttft = 0;
      try {
        const r = await this.ctx.completion(
          {
            prompt: req.prompt,
            n_predict: req.maxTokens,
            temperature: req.temperature ?? 0.7,
            grammar: req.grammar,
            stop: req.stop,
            seed: 42,
          },
          (data) => {
            if (!ttft) ttft = Date.now() - t0;
            if (data.token) req.onToken?.(data.token);
          },
        );
        const stopReason: CompletionResult['stopReason'] = req.signal?.aborted || r.interrupted ? 'abort'
          : r.stopped_limit ? 'length' : r.stopped_word ? 'stop' : 'eos';
        return {
          text: r.text, stopReason,
          promptTokens: r.timings.prompt_n + r.timings.cache_n,
          cachedTokens: r.timings.cache_n,
          completionTokens: r.timings.predicted_n,
          ttftMs: ttft, totalMs: Date.now() - t0,
        };
      } finally {
        req.signal?.removeEventListener('abort', onAbort);
      }
    });
  }

  release(): Promise<void> {
    return this.ctx.release();
  }
}

const empty = (stopReason: CompletionResult['stopReason']): CompletionResult =>
  ({ text: '', stopReason, promptTokens: 0, cachedTokens: 0, completionTokens: 0, ttftMs: 0, totalMs: 0 });

/** The small embedding model (bge-small, ~36 MB) in its own context. */
export class LlamaRnEmbedder implements Embedder {
  readonly maxTokens = 460; // 512-token context with headroom (core chunks text to fit)
  private mutex = new Mutex();

  private constructor(private ctx: LlamaContext, readonly id: string) {}

  static async load(path: string): Promise<LlamaRnEmbedder> {
    const ctx = await initLlama({ model: path, embedding: true, n_ctx: 512, n_batch: 512, n_gpu_layers: 0, devices: ['CPU'], n_threads: 2, use_mlock: false });
    return new LlamaRnEmbedder(ctx, fileName(path));
  }

  embed(texts: string[]): Promise<Float32Array[]> {
    return this.mutex.run(async () => {
      const out: Float32Array[] = [];
      for (const t of texts) out.push(Float32Array.from((await this.ctx.embedding(t)).embedding));
      return out;
    });
  }

  release(): Promise<void> {
    return this.ctx.release();
  }
}

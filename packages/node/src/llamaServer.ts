import type { ChatMessage, CompletionRequest, CompletionResult, Embedder, LLM, TemplateOptions } from '@aura/core';

// Adapters for llama.cpp's llama-server running on localhost. This is local
// inference over loopback, not a network call off the device.

async function post<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
  if (!res.ok) throw new Error(`${url} → ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

interface Props {
  model_path: string;
  default_generation_settings: { n_ctx: number };
  chat_template?: string;
  total_slots?: number;
}

const modelName = (path: string) => path.split('/').pop()!.replace(/\.gguf$/i, '');

export class LlamaServerLLM implements LLM {
  private constructor(
    readonly baseUrl: string,
    readonly id: string,
    readonly contextLength: number,
    readonly template: string,
    readonly slots: number,
  ) {}

  /** Reads model id, context length and the GGUF-embedded chat template from /props. */
  static async connect(baseUrl = 'http://127.0.0.1:8080'): Promise<LlamaServerLLM> {
    const res = await fetch(`${baseUrl}/props`);
    if (!res.ok) throw new Error(`llama-server at ${baseUrl} not ready (${res.status})`);
    const p = (await res.json()) as Props;
    return new LlamaServerLLM(baseUrl, modelName(p.model_path), p.default_generation_settings.n_ctx, p.chat_template ?? '', p.total_slots ?? 1);
  }

  async countTokens(text: string): Promise<number> {
    const r = await post<{ tokens: number[] }>(`${this.baseUrl}/tokenize`, { content: text, add_special: false });
    return r.tokens.length;
  }

  async applyTemplate(messages: ChatMessage[], opts: TemplateOptions): Promise<string> {
    // enable_thinking is read by Qwen3-style templates and ignored by the rest.
    const r = await post<{ prompt: string }>(`${this.baseUrl}/apply-template`, {
      messages, chat_template_kwargs: { enable_thinking: opts.thinking },
    });
    return r.prompt;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const t0 = performance.now();
    let ttft = 0;
    let text = '';
    let final: Record<string, unknown> | null = null;
    try {
      const res = await fetch(`${this.baseUrl}/completion`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: req.signal,
        body: JSON.stringify({
          prompt: req.prompt,
          n_predict: req.maxTokens,
          temperature: req.temperature ?? 0.7,
          grammar: req.grammar,
          stop: req.stop,
          stream: true,
          cache_prompt: true, // reuse the KV cache for the longest common prefix
          id_slot: req.slot ?? -1,
          // Seed fixed so temperature-0 eval runs are reproducible.
          seed: 42,
        }),
      });
      if (!res.ok || !res.body) throw new Error(`/completion → ${res.status} ${await res.text()}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const chunk = JSON.parse(line.slice(5)) as Record<string, unknown>;
          const piece = (chunk.content as string) ?? '';
          if (piece) {
            if (!ttft) ttft = performance.now() - t0;
            text += piece;
            req.onToken?.(piece);
          }
          if (chunk.stop) final = chunk;
        }
      }
    } catch (e) {
      if (req.signal?.aborted) return this.result(text, 'abort', null, ttft, t0);
      throw e;
    }
    const stopType = final?.stop_type as string | undefined;
    return this.result(text, stopType === 'limit' ? 'length' : stopType === 'word' ? 'stop' : 'eos', final, ttft, t0);
  }

  private result(text: string, stopReason: CompletionResult['stopReason'], final: Record<string, unknown> | null, ttft: number, t0: number): CompletionResult {
    const t = (final?.timings ?? {}) as { cache_n?: number; prompt_n?: number; predicted_n?: number };
    return {
      text, stopReason,
      promptTokens: (t.prompt_n ?? 0) + (t.cache_n ?? 0),
      cachedTokens: t.cache_n ?? 0,
      completionTokens: t.predicted_n ?? 0,
      ttftMs: Math.round(ttft),
      totalMs: Math.round(performance.now() - t0),
    };
  }
}

/** A second llama-server started with --embedding (e.g. bge-small). */
export class LlamaServerEmbedder implements Embedder {
  private constructor(
    readonly baseUrl: string,
    readonly id: string,
    readonly maxTokens: number,
  ) {}

  static async connect(baseUrl = 'http://127.0.0.1:8081'): Promise<LlamaServerEmbedder> {
    const res = await fetch(`${baseUrl}/props`);
    if (!res.ok) throw new Error(`embedding server at ${baseUrl} not ready (${res.status})`);
    const p = (await res.json()) as Props;
    // Leave headroom: our chunker estimates tokens from characters.
    return new LlamaServerEmbedder(baseUrl, modelName(p.model_path), Math.floor(p.default_generation_settings.n_ctx * 0.9));
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const r = await post<{ data: { index: number; embedding: number[] }[] }>(`${this.baseUrl}/v1/embeddings`, { input: texts });
    return r.data.sort((a, b) => a.index - b.index).map((d) => Float32Array.from(d.embedding));
  }
}

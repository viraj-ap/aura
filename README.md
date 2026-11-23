<p align="center">
  <img src="docs/assets/logo.png" alt="AURA" width="120" />
</p>

<h1 align="center">AURA</h1>

<p align="center">
  <b>On-device AI assistant with long-term memory.</b><br/>
  Runs any GGUF model fully on your phone, and adds a memory layer so small models (0.6B–8B) recall far beyond their context window — with fewer tokens. Nothing leaves the device.
</p>

<p align="center">
  React Native (Expo) · TypeScript · llama.cpp (llama.rn) · SQLite (FTS5) · LongMemEval
</p>

---

## Why

Small on-device models have small context windows. Chat apps usually just keep the latest messages that fit (truncation), so anything older is forgotten. AURA stores **everything**, indexes it cheaply, and picks what to put in the prompt at query time.

On LongMemEval (~115K tokens of chat history per question, 8K context):

- **3–5× the accuracy of truncation** with **6.6× fewer prompt tokens** (1,148 vs 7,606) and **10–15× faster first token**.
- **89% recall@5** for hybrid retrieval (470 questions), **7.7 ms** median search over 10K messages.
- Retrieval is close to an oracle that gets only the true evidence, at every model size tested.

## Features

- **Any GGUF model, on-device:** download from Hugging Face, with a **"can this phone run it?"** check *before* download, computed from the model's GGUF header and the phone's RAM (within ~4% of measured memory).
- **Long-term memory shared across chats:** hybrid BM25 + vector search, extracted facts, session summaries and a feedback-driven "playbook" of rules.
- **Token-budgeted, KV-cache-friendly prompts:** a stable prefix is reused across turns, so only the end of the prompt is reprocessed.
- **Files and photos:** PDFs (pdf.js, fully offline) and photos (OS OCR) become searchable memory.
- **Opt-in web search** per message; results are used for that turn only and never stored.
- **Privacy controls:** see what AURA remembers, and forget a fact, file, chat or everything (deletes cascade to everything derived from it).

## How the memory works

| Layer | Job |
|---|---|
| **L1 Event log** | Append-only record of every message; the source of truth |
| **L2 Indexes** | Messages → 256-token chunks → keyword (FTS5/BM25) + vector index, instantly, no LLM call. Plus session summaries and facts |
| **L3 Selection** | A router skips small talk; otherwise hybrid search → Reciprocal Rank Fusion → rerank. Optional *Scroll-lite*: the model plans grammar-constrained lookups |
| **L4 Assembly** | Exact token budget split into sections, best memories at the prompt's edges, cache-friendly layout |
| **L5 Compression** | Old turns are summarized in batches; originals stay in the log |
| **L6 Playbook** | 👍/👎 on a reply edits a short list of learned rules |

```
system:  system prompt + playbook rules + rolling summary         ← stable, served from the KV cache
turns:   recent user/assistant messages                           ← append-only between compactions
user:    facts + retrieved memories + current time + question     ← changes every turn, so it goes last
```

Details: [`docs/architecture.md`](docs/architecture.md).

## Results

LongMemEval_s, 8K context, temperature 0, judged by a fixed Qwen3-8B, embeddings from bge-small-en-v1.5. Full write-up with confidence intervals, ablations and negative results: [`docs/report.md`](docs/report.md).

**Memory vs truncation** (n=60, stratified)

| Config | Qwen3-0.6B | Qwen3-1.7B | Prompt tokens |
|---|---|---|---|
| (a) truncation (what most chat apps do) | 11.7% | 10.0% | 7,606 |
| (b) plain vector top-k | 28.3% | 46.7% | 1,800 |
| **(c) AURA + snippets (default)** | **38.3%** | **53.3%** | **1,148** |
| oracle (only the true evidence) | 43.3% | 51.7% | 4,799 |

**Across model sizes** (dev split, n=151)

| Model | (b) vector | (c) AURA | oracle |
|---|---|---|---|
| Qwen3-0.6B | 29.8% | 35.1% | 35.8% |
| Qwen3-1.7B | 43.0% | 45.7%\* | 45.7% |
| Llama-3.2-3B | 47.7% | 47.7% | 49.0% |
| Qwen3-8B | 57.6% | 64.9% | 64.2% |

\* with snippets. Honest takeaways:

- AURA ≈ oracle at every size, so retrieval isn't the bottleneck; **model size is** (35% → 65% from 0.6B to 8B).
- Against plain vector search the accuracy gap is small and mostly within noise; the clear wins are tokens and latency.
- **Scroll-lite (model-planned lookups) hurt** at every size where it ran (−18 points at 8B), so it is off by default.
- Counting and date questions fail even with perfect evidence; that is a model-reasoning limit.
- Qwen3-8B is also the judge, so its own scores may be inflated. The held-out test split (349 questions) has not been run yet.

## Repository layout

```
apps/mobile/       Expo (React Native) app: llama.rn + op-sqlite adapters, chat / models / memory / settings screens
packages/core/     the memory engine: plain TypeScript, no platform imports (layers L1–L6)
packages/node/     laptop adapters (llama-server, better-sqlite3), terminal chat, smoke test, `fit` CLI
packages/eval/     LongMemEval harness: configs (a)–(d) + oracle, cached ingestion, fixed judge, recall@k, Wilson CIs
docs/              architecture.md · report.md
results/           eval result tables (markdown)
```

`packages/core` only reaches the outside world through small interfaces (`LLM`, `Embedder`, `SqlDb`, `Clock`), so the laptop eval runs exactly the code the phone runs.

## Getting started

Requirements: Node.js 22+, npm.

```bash
npm install          # installs all workspaces and bundles pdf.js for the app
npm test             # core + eval tests (no model needed)
npm run typecheck
```

### Run the app on an Android phone

The app uses native modules (`llama.rn`, `op-sqlite`), so it **does not run in Expo Go**. Build a development client once:

```bash
cd apps/mobile

# Option A: build in Expo's cloud (no Android Studio needed)
npx eas-cli@latest login
npx eas-cli@latest build --profile development --platform android
# install the APK from the link EAS gives you

# Option B: build locally (Android SDK + JDK 17/21, phone connected over USB)
npx expo run:android --device

# then start the dev server and open the app on the phone
npx expo start --dev-client
```

A Docker-based Android build is also available: `apps/mobile/docker/build-android.sh`.

**First run:** Models → download **bge-small** (36 MB, used for memory search) → download a chat model marked *Runs well on this phone* (Qwen3 1.7B on 6 GB+ phones, Qwen3 0.6B otherwise) → **Load** → chat.

iOS should work the same way (`npx expo run:ios`) but needs Xcode and an Apple developer team for the increased-memory entitlement; it has not been tested.

### Terminal chat on a laptop

```bash
brew install llama.cpp
mkdir -p models
curl -L -o models/Qwen3-0.6B-Q4_K_M.gguf https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q4_K_M.gguf
curl -L -o models/bge-small-en-v1.5-q8_0.gguf https://huggingface.co/CompendiumLabs/bge-small-en-v1.5-gguf/resolve/main/bge-small-en-v1.5-q8_0.gguf

llama-server -m models/Qwen3-0.6B-Q4_K_M.gguf --port 8080 -c 8192 --jinja
llama-server -m models/bge-small-en-v1.5-q8_0.gguf --port 8081 --embedding --pooling cls -c 512 -ub 512

npm run chat         # type /help; /debug shows what went into each prompt
npm run smoke        # live end-to-end memory check
npm run bench        # retrieval latency at 10K events
```

Check whether a model fits a phone, from a local file or a Hugging Face URL (reads only the header):

```bash
npm run fit -- models/Qwen3-0.6B-Q4_K_M.gguf
npm run fit -- https://huggingface.co/unsloth/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf
```

### Reproduce the evaluation

Download LongMemEval (`longmemeval_s_cleaned.json`, `longmemeval_oracle.json` from [`xiaowu0162/longmemeval-cleaned`](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned)) into `data/longmemeval/`, then start the model under test on `:8080`, the embedder on `:8081` and the judge (Qwen3-8B) on `:8082`:

```bash
npm run recall                                           # retrieval-only recall sweep, no LLM needed
npm run eval -- --configs a,b,c,oracle --run main-0.6b   # accuracy on the 60-question stratified subset
npm run eval -- --split dev --configs b,c,d,oracle --run dev-0.6b --prefix phase5-
```

Results are written to `results/`. Ingestion and judge calls are cached in `.cache/eval.db`, and runs are resumable.

## Limitations

- Tested on one Android phone (Samsung Galaxy S23 Ultra); the LLM runs CPU-only there, because GPU (OpenCL) offload froze the UI on long prompts.
- Accuracy numbers are from the n=60 subset, the full 500 questions (0.6B only) and the 151-question dev split; the held-out test split is still unrun.
- Judge agreement with human labels hasn't been measured yet.

## Acknowledgements

Built on [llama.cpp](https://github.com/ggml-org/llama.cpp) / [llama.rn](https://github.com/mybigday/llama.rn), [op-sqlite](https://github.com/OP-Engineering/op-sqlite), [pdf.js](https://github.com/mozilla/pdf.js) and [LongMemEval](https://github.com/xiaowu0162/LongMemEval). Design ideas from MemoryOS, Scroll, ACON, ACE and *Lost in the Middle* (see [`docs/report.md`](docs/report.md) §13).

## License

[MIT](LICENSE)

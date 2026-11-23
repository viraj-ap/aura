# AURA — Architecture

Fully on-device chat with any GGUF model, plus a memory engine that lets 0.6B–4B models recall far beyond their context window.
Results and benchmarks: [`report.md`](report.md).

## Repo

```
packages/core/   platform-free TypeScript engine (no RN/Node imports), 78 unit tests
packages/node/   desktop adapters: llama-server (loopback HTTP) + better-sqlite3; terminal chat, bench, `npm run fit`
packages/eval/   LongMemEval harness: replayed timestamps, cached ingestion, fixed 8B judge, recall@k, Wilson CIs
apps/mobile/     Expo SDK 58 dev build: llama.rn + op-sqlite adapters, screens, model manager
```

Core only talks to the outside through interfaces (`LLM`, `Embedder`, `SqlDb`, `Clock`, `HostHooks`), so the eval runs
the exact code the phone runs.

| Interface | Laptop | Phone |
|---|---|---|
| `LLM` | `llama-server` over loopback | `llama.rn` (llama.cpp in-process, GPU offload, one completion at a time via a mutex) |
| `Embedder` | `llama-server --embedding` | `llama.rn` bge-small (36 MB, 384-dim, CPU, own context) |
| `SqlDb` | better-sqlite3 | op-sqlite with FTS5 |

## Memory layers

| Layer | What it does | Where |
|---|---|---|
| **L1 Event log** | Append-only `events` table; source of truth. Injectable clock. Token counts cached per (event, model) | `log/` |
| **L2 Indexes** | Every event is chunked (256 tok) → FTS5 row + vector, instantly, no LLM call. Session summaries (episodic), facts (semantic), working turns | `indexes/` |
| **L3 Selection** | Router skips retrieval for small talk. Otherwise hybrid search, or Scroll-lite when the model passes the probe | `selection/` |
| **L4 Assembly** | Token budget split into sections, ranking, edge ordering, cache-friendly layout | `context/` |
| **L5 Compression** | Rolling summary of old turns, in batches; originals stay in the log | `compression/` |
| **L6 Playbook** | 👍/👎 → reflection proposes one ADD/UPDATE/REMOVE rule; capped at 200 tokens | `playbook/` |

Plus `jobs/` (resumable background queue) and `privacy/` (cascade delete).

## One message, end to end

```
user text ─► pause jobs ─► append to log ─► index (FTS + vector) ─► compress if recent turns overflow
          ─► route ─► select: hybrid search  |  Scroll-lite plan → run ops → results (fallback: hybrid)
          ─► facts lookup ─► assemble prompt within budget ─► generate (reuses KV prefix) ─► strip <think>
          ─► append reply ─► resume jobs (summaries, facts, embeddings, reflection run when idle)
```

**Retrieval:** FTS5 BM25 (porter) and brute-force cosine over Float32 BLOBs (7.7 ms at 10K events) → Reciprocal Rank Fusion
(k=60) → rerank `0.9·relevance + 0.1·importance` (recency weight 0, from the recall sweep) → top k=8. **Snippets:** long items are cut
to their best-matching chunk (half the tokens, same accuracy).

**Budget:** `min(context, RAM-safe context) − 512 output` tokens, split system 10% · playbook 5% · facts 10% · retrieved 35% · recent 40%.
Unused share flows to the other sections.

**Prompt layout:** this keeps the KV cache valid across turns.
```
[system prompt + playbook rules + rolling summary]   ← stable prefix, KV-cached
[recent turns]                                       ← grows by one turn per message
[final user block: facts · memories (best at both edges, dated) · current time · question]   ← volatile, last
```
Volatile memory goes last, so the cache only re-processes the tail, and the memories sit next to the question (Lost in the Middle).

**Scroll-lite:** the model emits GBNF-constrained JSON operations (`search`, `keyword`, `filter_by_time`, `get_session`,
`get_event`, `get_facts`, `count`), max 2 rounds × 3 ops. The planning prompt is the chat prompt with a different final block, so it shares
the KV prefix. A capability probe at model load decides whether it's used. Invalid output → hybrid fallback, never a crash.

**Background jobs:** embeddings, session summaries, fact extraction, reflection. They run only while the app is open, idle, and either at ≥20% battery
or charging, and they abort the moment the user sends a message. Facts come only from user messages, through a gate grammar and a
grounding filter (the value must appear in the message). A conflicting fact keeps both and marks the newest as current.

**Privacy:** every derived row (chunks, vectors, FTS, summaries, facts, rules) stores its source event ids, so deleting a message,
file, fact, chat or everything cascades to all of them. Network use: model downloads (HF API, GGUF header reads, files) and,
only when the user turns the globe on for a message, web search. Nothing else leaves the phone.

## Files and web search (Phase 4)

```
photo ─► OS text recognizer (ML Kit / Apple Vision) ─┐
PDF   ─► pdf.js in a hidden WebView (text layer;      ├─► aura.attach() ─► event type 'attachment' ─► chunk + FTS + vectors
         scanned pages → canvas → OCR, ≤20 pages)    ─┘                      (searchable in every later chat; forget = cascade)

globe on ─► hidden WebView: Brave Search (→ DuckDuckGo) results page ─► fetch top 2 pages, strip to text (≤2,500 chars) + 3 snippets ─► send({ web })
```

- **Core stays platform-free:** it receives text only. Extraction lives in the app (`src/attachments`, `src/web`).
- **Attached section:** files and web results go into a new `attached` budget share (35%), placed in the final user block after memories,
  closest to the question. The share only exists on turns that have attachments, so other turns (and all Phase 2 eval numbers) split the
  budget exactly as before.
- **Long files:** a file is split into the same 256-token chunks it was embedded with. Chunks are ranked by cosine to the question (stored vectors)
  plus keyword hits, the best that fit are kept, then shown in page order under the file name. A 100-page PDF costs no more than the budget.
- **Sources are interleaved by rank**, so one big file can't crowd out a second file or the web results.
- **Web results are per turn:** cited as [1], [2] and saved on the reply only as {title, url} for the source chips. Their text is never
  stored or indexed.
- **One WebView host** (`HiddenWeb`) runs jobs one at a time, is mounted only while a job runs, uses incognito mode, and has a timeout per job.
  It is the phone's own browser engine, so there is no API key and no server of ours. When an engine shows a captcha, the next one is tried.


## Storage (SQLite)

`events` · `sessions` · `models` · `token_counts` · `episodes` · `facts` (subject, attribute, value, is_current, sources, heat) ·
`playbook` · `jobs` (dedupe key, attempts) · `compactions` · `embeddings(item_type, item_id, chunk, embedder_id, vector)` ·
`fts(content, item_type, item_id)` (one FTS table for every memory type) · `kv` (app state). A changed embedder triggers
re-embedding.

## Choosing a model for a phone

1. **Shape.** Read the GGUF header: layers, KV heads, key/value dims, max context. Catalog models ship their shapes; custom ones are read
   with HTTP Range requests (a few MB, no full download).
2. **Memory needed** at context *C*:
   `weights (file size, mmapped) + KV cache (layers × C × KV heads × (k_dim + v_dim) × 2 bytes) + compute (100 MB + 3% of weights) + 250 MB app/embedder overhead`.
3. **Usable** = 55% of total RAM (Android's low-memory killer and iOS jetsam kill apps well before RAM is full).
4. **Verdict:** **ok** under 80% of usable · **tight** under 100% (needs confirmation, loads at a smaller context) · **no** = download and
   load both blocked.
5. **Run context** = the largest context that stays "ok", capped at 8K (what we evaluated). It becomes `ramSafeTokens`, so the prompt
   budget follows the device.

Calibrated against the measured 2.09 GB RSS of Qwen3-1.7B at 8K (estimate 2.17 GB, 4% conservative). Architecture matters:
SmolLM2-1.7B (32 KV heads) needs far more KV memory than Gemma 3 1B (1 KV head).

Output of `npm run fit` at a requested 8K context (the app then loads at the largest safe context shown):

| | 4 GB | 6 GB | 8 GB | 12 GB (S23 Ultra) |
|---|---|---|---|---|
| Qwen3 0.6B (1.6 GB) | ✓ 8K | ✓ 8K | ✓ 8K | ✓ 8K |
| Qwen3 1.7B (2.3 GB) | shrinks to 3.3K | ✓ 8K | ✓ 8K | ✓ 8K |
| Qwen3 4B (3.9 GB) | ✕ | ✕ | tight, 5.6K | ✓ 8K |
| Qwen3 8B (6.3 GB) | ✕ | ✕ | ✕ | tight, only 768 tokens → not useful |

**Which one we recommend:** the verdict decides what *can* run. The eval decides what *should* run. The catalog labels Qwen3-1.7B as
"Recommended" (53.3% vs 38.3% for 0.6B, and it can plan Scroll-lite lookups). 0.6B is the fast choice for 4 GB phones, and 4B is offered
only where it fits. Known gap: "tight" can mean a uselessly small context (8B → 768 tokens on 12 GB), so a minimum useful context
(~2K) should also block a model.

## App (apps/mobile)

- `AuraProvider` owns the engine. Native adapters load lazily, so a missing native module shows a "needs a dev build" screen instead of
  crashing. The fit gate runs before every load, and the old model is freed before the next one loads.
- The model manager downloads to `.part`, checks the size and the `GGUF` magic, then renames it. It checks free space first, and pause/resume works within a session.
- **UI (frosted glass on a grainy gradient):**
  - Chat is the home screen: round menu and new-chat buttons, and a frosted model pill.
  - The composer is a frosted card: the text field on top, then a chip row with ＋ (photo / camera / PDF), Tools (search the web, think
    longer, change model), active-mode chips (Web, Think) or the model chip, and a dark round send/stop button. Menus pop up above it.
  - Replies render as Markdown without bubbles, with copy, 👍/👎, source chips, and stats and the exact prompt on long-press. User messages
    are frosted bubbles.
  - A drawer (new chat, chat list, Models, Memory, Settings) replaces the tabs. Pushed screens use their own header on the shared backdrop.
    The Memory screen adds Files.
- **Themes:** Dusk, Mist, Paper and Midnight, chosen in Settings and stored in `theme.json`, which is read synchronously at startup,
  so the wrong theme never flashes. Gradients use React Native's own CSS `backgroundImage` (radial and linear layers), with a tiled 31 KB
  grain PNG on top: no gradient or blur library and no native rebuild. Changing theme cross-fades the backdrop.
- **Motion** (`ui/motion.tsx`, native driver only, so it stays smooth while a reply streams):
  - Buttons and chips dip and spring back.
  - New messages fade and rise in; history doesn't animate.
  - Menus pop in with a scale and fade.
  - Three breathing dots while the model works.
  - The send button springs in when there's something to send.
  - Copy flashes a checkmark.
  - The drawer springs open (clamped) and its chat list cascades in.
  - Empty-state suggestions stagger in.
- **Performance:**
  - Tokens are buffered outside React state and published at most every 60 ms to the one streaming row.
  - Messages are memoized rows in an inverted list, so there is no `scrollToEnd` per token.
  - The composer owns its text, so typing doesn't re-render the list.
  - The provider value is memoized and load progress has its own context.
  - Download progress is throttled to 4 updates a second.
  - llama.rn runs **CPU-only** with 4 threads: GPU offload (OpenCL) froze the whole phone on long prompts, because the UI
    couldn't get GPU time, and it doesn't support Q4_K_M anyway. The embedder uses 2 threads.
  - Web result pages are downloaded and stripped to text (`web/readable.ts`), not rendered; at most 2,500 chars per page.
  - Native-backed modules load lazily, so an outdated build shows a fix-it screen instead of crashing.

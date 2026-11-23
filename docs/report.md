# A Layered Memory Architecture for Small Language Models: Design, Benchmarks and Negative Results

**Scope.** This report covers only the LLM memory-management architecture: how conversation history is stored, indexed, selected,
compressed and put into a fixed-size prompt so that small models (0.6B–8B parameters) can answer questions about conversations far
longer than their context window. It also covers how that architecture was evaluated. Product features (user interface, model download,
attachments, web search, device packaging) are out of scope and left out on purpose.

**Status (as of 2026-11-18).** The engine is implemented and benchmarked on the LongMemEval_s benchmark [6]. All numbers below come from
result files in the project repository (listed in Appendix A). Nothing is estimated or extrapolated unless it says so. Some planned
measurements have **not** been run; §11 lists them. The 349-question held-out test split has **not** been run yet, so every Phase 5 number
is a development-set number.

---

## Contents

1. Summary of results
2. Background and related work
3. Architecture overview
4. The six memory layers in detail
5. Per-message pipeline
6. Prompt layout and KV-cache reuse
7. Memory maintenance: background jobs and deletion
8. Default parameters
9. Evaluation method
10. Results
11. What did not work, limitations and open items
12. Threats to validity
13. References
14. Appendix A: where each number comes from

---

## 1. Summary of results

| Claim | Evidence | Strength |
|---|---|---|
| Retrieval-based memory beats truncating the history by 3–5× in accuracy | n=60, two models: 36.7–53.3% vs 10.0–11.7% (§10.3) | Strong (confidence intervals don't overlap) |
| ...with 6.6× fewer prompt tokens and ~10–15× lower time to first token (TTFT) | 1,148 vs 7,606 tokens; 254 vs 3,856 ms (0.6B), 745 vs 7,093 ms (1.7B) | Strong |
| Hybrid keyword + vector search recalls more evidence than vector-only search | n=470: R_all@5 89.1% vs 84.6%; turn R@10 85.3% vs 78.6% (§10.2) | Strong (n=470, no LLM involved) |
| The full engine is about as accurate as plain vector top-k search | n=500: 33.6% vs 31.4% (CIs overlap); dev n=151: no significant difference at any model size (§10.4, §10.6) | Holds: "same or slightly better, not significantly" |
| Retrieval is no longer the bottleneck | The oracle (perfect evidence) beats the engine by ≤ 5.3 points at every size, never significantly (§10.6) | Strong |
| Model size is the biggest lever | Engine accuracy 35.1 → 40.4 → 47.7 → 64.9% from 0.6B to 8B (dev n=151) | Strong, with a judge caveat for 8B |
| Model-planned retrieval ("Scroll-lite") **hurts** | −3.3 (1.7B), −2.6 (3B), **−17.9 (8B, p<0.001)** (§10.6) | Strong negative result |
| Counting and date questions fail even with perfect evidence | Oracle multi-session 16–57%, temporal 13–40% (§10.7) | Strong |

---

## 2. Background and related work

The design combines ideas from six published works. Each layer borrowed one idea and adapted it to the constraints of a 0.6B–4B model.

| Source | Idea taken | How it was adapted here |
|---|---|---|
| **Scroll** (Lin et al., 2026) [1] | Keep an append-only *Event Log* as lossless ground truth; let the model manage its own context by writing code that searches the log | Kept the append-only log (L1). Replaced free-form Python with a **fixed set of 7 operations emitted as grammar-constrained JSON** ("Scroll-lite", L3), because small models write unreliable code. Scroll reports 94.8% on LongMemEval_S with a very large backbone model [1]; this project asks whether a constrained version works at 0.6B–8B. |
| **MemoryOS** (Kang et al., 2025) [2] | Tiered memory (short-, mid- and long-term), with "heat" deciding what gets promoted | Working memory (recent turns), episodic memory (per-session summaries) and semantic memory (facts) in L2, each with a heat score |
| **Lost in the Middle** (Liu et al., 2023) [3] | Models use information at the start and end of a long context better than information in the middle | L4 places the strongest memories at **both edges** of the memory block and puts the block right next to the question |
| **ACON** (Kang et al., 2025) [4] | Optimise what context compression keeps, guided by failures | L5's summary prompt has an explicit "must keep" list (names, numbers, dates, decisions, changes), meant to be tuned against eval failures |
| **ACE** (Zhang et al., 2025) [5] | Grow a "playbook" with small incremental deltas instead of rewriting it, which avoids "context collapse" | L6 reflection may make **exactly one** ADD / UPDATE / REMOVE change per piece of feedback |
| **LongMemEval** (Wu et al., ICLR 2025) [6] | Benchmark of 500 questions over long multi-session chat histories, with evidence labels and per-type judge prompts | The whole evaluation (§9). The judge prompts are adapted from its evaluation script. |

Supporting techniques: BM25 ranking [7] through SQLite FTS5 [15] with the Porter stemmer [8]; Reciprocal Rank Fusion [9]; the
bge-small-en-v1.5 embedding model [10]; GBNF grammar-constrained decoding and prompt (KV) caching in llama.cpp [14]; Qwen3 [11] and
Llama 3.2 [12] as the models under test; Wilson score intervals [16], McNemar's test [17] and Cohen's kappa [18] for statistics; and
LLM-as-a-judge, including its known self-enhancement bias [13]. CodeAct [19] is the "code as actions" approach that Scroll builds on
and that Scroll-lite deliberately avoids.

**Research question (fixed at the start of the project):** does Scroll-style, query-time selection of memory work with small models
when the model can only call grammar-constrained operations instead of writing free-form code? **Answer so far: no** (§10.6).

---

## 3. Architecture overview

**Strategy: store everything, index cheaply, choose context late, assemble carefully.**

Nothing is thrown away at write time. Every message goes into an append-only log and is indexed at once (keyword + vector, no LLM call).
Choices about *what the model sees* are made only when a question arrives, against an exact token budget.

| Layer | Job | Inspired by |
|---|---|---|
| **L1 Event log** | Append-only record of every message and feedback event; the source of truth | Scroll [1] |
| **L2 Indexes** | Keyword (FTS5/BM25) and vector index for every item, written instantly; working, episodic and semantic memory | MemoryOS [2] |
| **L3 Selection** | Router + hybrid retrieval (default), or model-planned operations (Scroll-lite, off by default) | Scroll [1], RRF [9] |
| **L4 Assembly** | Token budget split into sections, ranking, edge ordering, cache-friendly layout | Lost in the Middle [3] |
| **L5 Compression** | Batched rolling summary of old turns; originals stay in the log | ACON [4], Scroll [1] |
| **L6 Playbook** | Learned answer-style rules, edited one delta at a time from 👍/👎 feedback | ACE [5] |

### 3.1 Platform-free core and interfaces

The engine is plain TypeScript with no platform imports. It reaches the outside world only through four interfaces, so the benchmark
runs **exactly the same code** as the deployed engine:

| Interface | Contract |
|---|---|
| `LLM` | count tokens, apply the model's own chat template, complete (with an optional GBNF grammar, abort signal, and a `purpose` tag: chat / plan / job) |
| `Embedder` | text → vectors; exposes an id and a max token length |
| `SqlDb` | minimal SQL surface (run / get / all / exec / transaction) |
| `Clock` | injectable time source, so the benchmark can replay historical timestamps |

In the benchmark the LLM and embedder are llama.cpp's `llama-server` over loopback HTTP, and the database is SQLite through better-sqlite3.

### 3.2 Data model (SQLite)

| Table | Contents | Role |
|---|---|---|
| `events` | id, session_id, ts, type (message / feedback), role, content, model_id, meta | L1, the source of truth |
| `sessions` | id, title, created/updated | conversation grouping |
| `token_counts` | (event_id, model_id) → count | token cache per tokenizer |
| `fts` (FTS5 virtual table) | content, item_type, item_id; tokenizer `porter unicode61` | one keyword index for events, episodes and facts |
| `embeddings` | (item_type, item_id, chunk, embedder_id) → Float32 BLOB | vector index, one row per chunk per embedder |
| `episodes` | one summary per session, source_event_ids, heat, uses, last_used | episodic memory |
| `facts` | subject, attribute, value, confidence, is_current, source_event_ids, first_seen, last_seen, heat, uses, last_used | semantic memory |
| `compactions` | session_id, upto_event_id, summary, source_event_ids | L5 rolling summaries |
| `playbook` | rule, helpful, harmful, source_event_ids | L6 rules |
| `jobs` | type, payload, status, dedupe_key, attempts, error | resumable background queue |
| `models`, `kv` | per-model probe result; current embedder id | bookkeeping |

Three invariants hold across the schema:

1. **Every derived row stores the ids of the events it came from** (`source_event_ids`). That makes deletion cascade correctly (§7.2).
2. **Every vector records the embedder that made it.** If the embedder changes, old vectors are dropped and re-embedded in the background.
3. **Ids are small integers on purpose**: Scroll-lite asks the model to emit ids (`get_event 12`), and short numbers are much easier for a 0.6B model than UUIDs.

---

## 4. The six memory layers in detail

### 4.1 L1 — Event log

- Append-only: the system never edits or deletes an event. Deletion by the user is the only exception (§7.2).
- Each event has an id, session, timestamp (from the injectable clock), role, content and the id of the model that produced it.
- Token counts depend on the tokenizer, so they are cached per **(event, model)** in `token_counts`. Arbitrary strings (formatted
  memories, summaries) use a bounded in-memory cache of 5,000 entries. Switching chat models therefore never invalidates memory; only the
  token counts are recomputed lazily.
- Model reasoning tokens (`<think>…</think>`) are stripped from replies before they are logged.

### 4.2 L2 — Indexes

**Chunking.** Text is split into chunks of at most `chunkTokens` = 256 tokens, measured as ~3 characters per token (768 characters), so
the embedder is never overflowed without a tokenizer round-trip per chunk. Chunks overlap by 24 tokens (72 characters, capped at ¼ of
the chunk) so that a fact spanning a boundary is whole in at least one chunk. A cut prefers a sentence end, then a newline, then a word
boundary, as long as the cut falls past the chunk's midpoint.

**Instant indexing (no LLM).** On every append, the item is written to the FTS5 table and each chunk is embedded. Measured cost:
**0.33 ms per event** (§10.1). If embedding fails, the keyword index is still written and an `embed` job is queued to retry.

**Vector index.** Vectors are L2-normalised Float32 arrays stored as BLOBs and searched by brute-force dot product (= cosine) over an
in-memory cache per embedder. An item's score is its **best chunk's** score, and the best chunk's index is kept for snippets. At 10K
events × 384 dimensions that is about 15 MB and a scan of a few milliseconds, so the planned `sqlite-vec` extension was deferred.

**Working memory.** The current session's messages since the last compaction (§4.5).

**Episodic memory.** One running summary per session, updated incrementally by a background job: previous summary + new messages → new
summary, in batches of at most max(2,000, 2 × context length) characters, 300 output tokens. Summaries are indexed in the same FTS and
vector indexes as messages, so whole-conversation context can be retrieved.

**Semantic memory (facts).**

- Extracted **from user messages only**, never from model output, so the model's own hallucinations can't become facts.
- **Gate grammar.** The output is constrained to `{"states_personal_facts": false}` or `{"states_personal_facts": true, "facts": [1–4 facts]}`,
  each fact being `{subject, attribute, value}`. A plain array grammar made Qwen3-0.6B return `[]` for every message; asking a yes/no
  question first and then requiring a non-empty list got the obvious facts out (§10.8).
- **Grounding filter.** A fact is kept only if at least one content word of its value (≥ 3 characters or containing a digit, excluding
  "user", "the", "and") appears in the source message. This removes placeholder values such as "User" or "User's home city".
- **No model-reported confidence.** Small models don't calibrate it. A fixed default (0.8) is stored instead.
- **Normalisation.** Subjects like "I", "me", "my" → `user`; "my dog" → `user's dog`; attributes → snake_case.
- **Conflicts keep history.** Same subject + attribute + value → reinforce (merge sources, update last_seen). Different value → insert
  a new row; the newest by timestamp becomes `is_current`, the older one stays as history. Restating an old value makes it current again.
- **Heat.** When a fact is placed in a prompt, `uses` is incremented and heat = ln(uses + 1). Recency is applied at ranking time, so heat never goes stale.

### 4.3 L3 — Selection

**Router.** A cheap rule-based check skips retrieval only for obvious small talk (a regular expression covering greetings, thanks,
"ok", "lol", "bye" and similar) or when nothing is stored yet. Anything ambiguous retrieves, because skipping when memory was needed
costs more than a wasted search.

**Hybrid retrieval (default path).** For a query:

1. **Exclusions.** Items already in the prompt's recent turns are excluded.
2. **Vector search.** Embed the query; take the top 3k items (8k when a time filter is set) by best-chunk cosine; drop hits below
   `minVectorScore` = 0.15.
3. **Keyword search.** Turn the query into a safe FTS5 expression: lower-case word tokens, length > 1, minus a stop-word list, at most 16
   unique terms, each quoted and joined with `OR` (this can never be an FTS syntax error). Rank by `bm25(fts)` and take up to 2 × 3k rows.
4. **Fusion.** Reciprocal Rank Fusion [9]: score(item) = Σ over lists of 1 / (60 + rank), with ranks starting at 1, then normalised by
   the maximum so relevance lies in (0, 1]. If only one list returned hits, its own score is used (cosine, or 1/(1+rank) for keyword).
5. **Hydration.** Load text and metadata; assign an *importance* prior: user message 0.6, assistant message 0.4, episode
   0.5 + min(0.5, heat/10), fact = confidence × (1 if current, 0.3 if outdated).
6. **Snippets** (on by default): a message longer than one chunk is cut to its best-matching chunk (the best vector chunk, or for
   keyword-only hits the chunk with the most query terms), with "…" marking cuts.
7. **Rerank.** score = 0.9 · relevance + 0 · recency + 0.1 · importance, where recency = 0.5^(age in days / 30). **The recency weight
   is 0** because a weight of 0.2 lowered recall (§10.2).
8. Keep the top k.

**Facts selection.** Separately, facts are retrieved by the same search restricted to facts (12 candidates), plus the 5 hottest current
facts (by heat, then confidence, then recency), so facts such as the user's name are present in every prompt. Only current facts are used.

**Scroll-lite (model-planned retrieval; off by default).** The model writes a lookup plan as JSON constrained by a GBNF grammar, so the
output is always well-formed. Operations:

| Operation | Effect |
|---|---|
| `search(query)` | hybrid search over messages and summaries |
| `keyword(terms)` | keyword-only search over messages |
| `filter_by_time(from, to, query?)` | messages between two dates, optionally searched |
| `get_session(id)` | summary of chat #id (or its first messages if no summary exists) |
| `get_event(id)` | message #id with its neighbours |
| `get_facts(subject?)` | stored facts, including outdated values |
| `count(query)` | number of past messages that match a keyword query |

- At most **2 rounds × 3 operations**, 4 results per operation. In round 2 the model sees up to 12 results found so far and may ask for
  more or stop with `{"ops":[]}`.
- The planning prompt is the chat prompt with a different final block, so planning and answering share the KV-cached prefix (§6).
- The planning prompt includes **3 worked examples** (topics deliberately different from the probe's). Without them both 0.6B and 1.7B
  produced 0/6 sensible plans; with them 5/6 and 4/6 (§10.8).
- A **capability probe** runs when a model is loaded: two questions that clearly need a lookup ("What was the name of the restaurant I told
  you about last week?", "How many times have I mentioned going to the gym?"). It passes only if both plans contain a real lookup (search,
  keyword, filter_by_time or count). If the probe fails, or a round-1 plan fails validation, retrieval falls back to hybrid search. Bad
  model output can never crash the engine.

### 4.4 L4 — Assembly

**Budget.** prompt budget = min(model context, RAM-safe context) − output reserve. It is split into section shares:

| Section | Share |
|---|---|
| system prompt | 10% |
| playbook rules | 5% |
| facts | 10% |
| retrieved memories | 35% |
| recent turns (+ rolling summary + the query) | 40% |

**Allocation.** Each section first gets min(need, share × budget). Whatever is left over (sections that needed less than their share) is
handed out in priority order, recent → retrieved → facts → playbook → system, to sections that still need more. So an empty facts table
doesn't waste 10% of the context.

**Ranked filling.** Within a section, items are added in rank order and filling stops at the first item that doesn't fit: a better item
is never skipped for a cheaper, worse one. Recent turns are kept newest-first, and the window is adjusted so it starts with a user turn.

**Exact fit.** Sizes are first planned with estimates (e.g. 8 tokens of template overhead per message). Then the prompt is rendered with
the model's own chat template and counted with its own tokenizer. If it is over budget, the budget is shrunk by the overage + 16 tokens
and the prompt re-planned, up to 12 attempts. The final prompt is always within budget by real token count.

**Edge ordering.** Given memories ranked best-first, even ranks go to the back in reverse and odd ranks to the front. For six memories the
order in the prompt is **2, 4, 6, 5, 3, 1**: the best memory sits right before the question, the second best opens the block, and the
weakest ones sit in the middle [3].

**Memory format.** Every memory carries its date and source chat, e.g. `(2023-05-20 02:21, chat #12) User: …`. Summaries are labelled
`summary of chat #N`, and facts `(as of DATE)`. An optional `relativeTime` mode adds "N days before now", because small models can't do
date arithmetic; it is implemented but **not yet measured**.

**System prompt (version 2).** Quoted from the code, with only the assistant's product name replaced by a placeholder:

> "You are [assistant], a private assistant on the user's device with long-term memory. Messages may include memories: real excerpts from
> your earlier conversations with this same user, with dates. Treat them as things you know about the user and answer from them directly.
> If memories conflict, trust the most recent one. If the answer is not in the memories or the conversation, say you don't know. Be concise."

Version 1 did not say that memories are real excerpts. With it, small models sometimes replied "I don't have access to your personal
information" with the evidence in the prompt (§10.5).

### 4.5 L5 — Compression (rolling summary)

- **Trigger.** When summary + recent turns + query reach **100%** of the recent-turns budget, and there are at least 3 turns.
- **Target.** The oldest turns are folded into the summary until what remains, plus a summary allowance of 25% of the recent budget, is
  at most **60%** of that budget. The last 2 turns are never folded, and an assistant reply is never left orphaned at the front.
- **Why batched.** Between compactions the prompt prefix only grows, so llama.cpp's KV-cache reuse keeps working for many turns. Compressing
  a little on every turn would change the prefix every turn.
- **"Must keep" prompt** (ACON-style [4]): keep names of people, pets, places and things; numbers, amounts, prices, quantities; dates,
  times, deadlines; decisions; plans and commitments; stated preferences; changes ("moved from X to Y"); unanswered questions. Drop
  greetings, filler and generic advice. Never invent anything. Merge into the earlier summary, keeping the newest value of anything that changed.
- **Lossless underneath.** The summary records the ids of the events it folded, and the originals stay in the log and stay searchable.
- **Failure behaviour.** If summarisation fails or is aborted, the turn proceeds without compaction and the assembler simply truncates the
  oldest turns.

### 4.6 L6 — Playbook (procedural memory)

- Rules about answer style (e.g. "Keep answers under 5 sentences"), each with helpful/harmful counters and source event ids.
- 👍/👎 on an answer credits or blames the rules that were in that answer's prompt, then queues a reflection job.
- **Reflection** proposes at most **one** delta: `ADD`, `UPDATE id`, `REMOVE id` or `NONE` (ACE [5]). The grammar is built per call and
  can only express ids that exist; Qwen3-0.6B tried to `UPDATE id 1` on an empty playbook before this was added.
- Rules are hidden from the prompt once harmful − helpful ≥ 3. The rules in a prompt are capped at **200 tokens**, best-rated first.
  Duplicate ADDs are ignored, and a rule is truncated to 200 characters.
- Rules live in the stable, cached part of the prompt (§6).
- **Not benchmarked**: LongMemEval has no feedback signal, so L6 is switched off in every benchmark configuration.

---

## 5. Per-message pipeline

```
user message
 ─► pause background jobs (the user always comes first)
 ─► append to event log (L1)
 ─► index: chunk → FTS5 row + embeddings (L2, no LLM call, ~0.33 ms/event)
 ─► compute budget; compress if recent turns reached 100% of their share (L5, usually a no-op)
 ─► router: skip retrieval for small talk / empty memory (L3)
 ─► select: Scroll-lite plan → run ops (if enabled and probe passed) | otherwise hybrid search → rerank (L3)
 ─► select facts: relevant + hottest current facts
 ─► assemble within the exact token budget, edge-ordered (L4)
 ─► generate on the KV-cached prefix
 ─► strip <think> tokens; append reply to log; index it
 ─► heat: touch facts and summaries that were in the prompt
 ─► queue background jobs: fact extraction (user message), episode update
```

---

## 6. Prompt layout and KV-cache reuse

```
system : system prompt + playbook rules + rolling summary                  ← stable; changes rarely
turns  : recent user/assistant messages                                    ← append-only between compactions
user   : facts + memories (edge-ordered, dated) + current time + question   ← volatile, so it goes last
```

This layout settles a real conflict between **caching** and **attention ordering**. Per-query memories change on every turn. Putting them
in the system prompt would invalidate the whole KV cache every turn. Putting them in the final user message keeps everything before it
cacheable (good for TTFT), and places them right next to the question (good for attention [3]). In a live run, the system prompt and earlier
turns were served from llama.cpp's prompt cache, e.g. 451 of ~600 prompt tokens. The current time is always stated in the final block, in
every configuration, because temporal questions need it.

---

## 7. Memory maintenance: background jobs and deletion

### 7.1 Background job queue

- Job types: `facts` (extract from one user message), `episode` (update a session summary), `reflect` (playbook), `embed` (fill in missing vectors in batches of 32).
- **Persistent and resumable.** Jobs live in SQLite. Anything left `running` after a crash is reset to `pending` on start.
- **Interruptible.** When the user sends a message, the running job is aborted mid-generation and put back to `pending`. Handlers are
  idempotent, so re-running is safe. One model can't chat and run jobs at the same time.
- **Retries.** A failing job is retried up to 3 times, then marked `failed`. Jobs with a dedupe key (e.g. one pending episode update per
  session) are never queued twice.
- Measured cost on a laptop: facts + episode jobs for one exchange took ~0.5–1.5 s with Qwen3-0.6B.

### 7.2 Deletion cascade

Deleting a message is the only way anything leaves the log. Because every derived row lists its source events:

- the message's FTS rows, vectors and token counts are deleted, along with feedback that pointed at it;
- **episodes** that used it are dropped and re-queued to be rebuilt from the remaining messages;
- **compactions** that used it are dropped (they are cumulative, so later ones go too); the next turn re-compacts from the log;
- **facts** lose that source; a fact with no sources left is deleted, and if it was current, the previous value becomes current again;
- **playbook rules** learned only from deleted feedback are deleted;
- a session with no messages left is deleted.

---

## 8. Default parameters

| Parameter | Default | Note |
|---|---|---|
| Output reserve | 512 tokens | the benchmark uses 256 |
| Section shares | system 10 · playbook 5 · facts 10 · retrieved 35 · recent 40 (%) | |
| Retrieval mode | hybrid (FTS5 BM25 + vectors, RRF) | |
| RRF constant | 60 | standard value from [9] |
| Rerank weights | relevance 0.9 · recency 0 · importance 0.1 | recency changed 0.2 → 0 from the recall sweep |
| Recency half-life | 30 days | unused while the weight is 0 |
| `minVectorScore` | 0.15 | see §11: picked for a hash embedder, not tuned for bge-small |
| Snippets | on | token and latency choice, not an accuracy win (§10.4) |
| Chunk size / overlap | 256 / 24 tokens (≈3 chars per token) | |
| Compression trigger / target | 100% / 60% of the recent-turns share | |
| Scroll-lite | **off**; 2 rounds × 3 ops, 4 results per op | off at every model size (§10.6) |
| Playbook cap | 200 tokens; rule retired at harmful − helpful ≥ 3 | |
| Fact extraction | gate grammar, 1–4 facts per message, grounding filter, user messages only | |
| Job retries | 3 | |

---

## 9. Evaluation method

### 9.1 Benchmark

**LongMemEval_s** [6], cleaned release (Hugging Face `xiaowu0162/longmemeval-cleaned`). It has 500 questions; each comes with its own
history of about 50 past sessions, roughly 115K tokens. Question types (counts in the full set): single-session-user (64),
single-session-assistant (56), single-session-preference (30), multi-session (121), knowledge-update (72), temporal-reasoning (127), plus
30 abstention questions spread across types, whose correct answer is "I don't know." Each question has evidence labels: the sessions that
hold the answer, and turns marked `has_answer`.

### 9.2 Harness

- **Fresh state per question.** A new in-memory SQLite database. The history is ingested with **timestamps replayed** from the
  benchmark, via the injectable clock (session dates parsed as UTC; turns one minute apart inside a session).
- **Two layouts.** In *sessions* layout, each history session is its own chat and the question opens a **new** chat, so memory must bring
  the past back. In *thread* layout, the whole history is one chat and the question is its next message: whatever fits in the context survives.
- **Same model, same budget for every configuration.** Context 8,192 tokens − 256 output reserve = **7,936-token prompt budget**,
  temperature 0, thinking mode off.
- **Judge.** Qwen3-8B Q4_K_M at temperature 0, output constrained by the grammar `root ::= "yes" | "no"` (max 3 tokens), using
  LongMemEval's per-type judge prompts [6] (off-by-one days allowed on temporal questions; an updated answer that also mentions the old
  value counts as correct on knowledge-update; a rubric for preference questions; an "identifies as unanswerable" prompt for abstention).
- **Caching.** Everything deterministic (embeddings, token counts, background-job outputs, judge verdicts) is cached by content in a
  SQLite cache. Answers are never cached. Runs resume where they stopped.

### 9.3 Configurations

| Config | What goes into the prompt |
|---|---|
| **a** truncation | thread layout; all memory layers off; the latest history that fits, oldest turns dropped |
| **b** vector top-k | sessions layout; vector search only, no rerank, no edge ordering, no snippets, same k as c |
| **c** memory engine | sessions layout; hybrid search + rerank + edge ordering; no LLM-built summaries or facts; snippets off |
| **c/snip** | c with snippets on (the current default) |
| **c/k20** | c with k = 20 |
| **c+** | c + episodic summaries + facts, built by the model under test during ingestion |
| **d** | c + Scroll-lite; falls back to c if the probe fails |
| **d!** | Scroll-lite forced on, ignoring the probe |
| **oracle** | only the evidence sessions exist; every turn is retrieved (k = 200, no score floor) and presented **exactly like c**: the model's ceiling |
| **oracle-thread** | only the evidence sessions, presented as one chat (thread layout) |

Modifiers can be stacked (e.g. `c/snip/k20`). `sp1` swaps in the version-1 system prompt, `user` excludes assistant messages from
retrieval, and `rec` restores the old recency weight.

### 9.4 Metrics

- **Accuracy**: the share of questions judged correct, with **95% Wilson score intervals** [16].
- **Paired comparisons** on the same questions: **McNemar exact test** [17].
- **Evidence in prompt**: whether *all* evidence sessions (session level: any of their turns, or their summary) reached the final prompt,
  and the share of evidence turns that did. This works for every configuration, including truncation.
- **Retrieval recall** of the ranked list before budgeting (no LLM involved):
  - **R_all@k** = the mean *fraction* of a question's evidence sessions found in the top k. Note: this is a fractional average, not the
    stricter binary "all found" form.
  - **R_any@k** = the share of questions with at least one evidence session in the top k.
  - **Turn R@k** = the share of evidence turns found in the top k.
- **Prompt tokens** (exact, with the model's tokenizer), **TTFT** and latency (medians), and peak server RSS.

### 9.5 Samples and splits

| Sample | n | Used for |
|---|---|---|
| Stratified subset (10 per type, picked by SHA-1 hash of the question id) | 60 | Phase 2 main runs |
| All questions | 500 | Phase 2 "wide" run, Qwen3-0.6B |
| All non-abstention questions | 470 | retrieval-recall sweep |
| **Dev split**: per type, the first max(10, 30%) by id hash | **151** | Phase 5 tuning and model-size comparison |
| **Test split** (held out, guarded by a `--final-test` flag) | **349** | **not yet run** |

All 60 Phase 2 questions are inside dev. The Phase 2 n=500 run did touch test questions; it predates the split.

### 9.6 Hardware and models

MacBook (Apple M5, 24 GB), llama.cpp `llama-server`. All chat models in GGUF Q4_K_M: Qwen3-0.6B, Qwen3-1.7B, Qwen3-8B [11],
Llama-3.2-3B-Instruct [12]. Embedder: bge-small-en-v1.5 [10], Q8_0, 384 dimensions, CLS pooling. The llama.cpp build version was not recorded.

---

## 10. Results

### 10.1 Speed of the memory layer (laptop)

| Metric | Value | Model |
|---|---|---|
| Hybrid search + rerank at 10K events | **7.7 ms median**, 18 ms max (target was ≤ 300 ms) | 384-dim vectors |
| Indexing (FTS + vector) | 0.33 ms per event | bge-small |
| Decode | ~160–200 tok/s | Qwen3-0.6B |
| Prefill | ~3,000 tok/s (0.6B); ~1,250–1,750 tok/s (1.7B) | |
| Peak RAM, 8K context, no host prompt cache | ~2.1 GB (2.09 GB measured) | Qwen3-1.7B |
| Background jobs per exchange (facts + episode) | ~0.5–1.5 s | Qwen3-0.6B |
| Live end-to-end memory checks | 13/13 pass (1 model warning: the Scroll-lite probe fails) | Qwen3-0.6B |

### 10.2 Retrieval recall (n=470 non-abstention questions, no LLM)

| Variant | R_all@5 | R_all@10 | R_all@20 | R_any@5 | R_any@10 | R_any@20 | Turn R@5 | Turn R@10 | Turn R@20 |
|---|---|---|---|---|---|---|---|---|---|
| b: vector only | 84.6% | 93.3% | 97.1% | 95.5% | 98.5% | 99.1% | 61.9% | 78.6% | 89.1% |
| b, user messages only | 88.3% | 94.7% | 97.4% | 95.7% | 97.9% | 98.7% | 65.8% | 76.4% | 82.3% |
| keyword only (FTS5/BM25) | 85.5% | 92.5% | 95.6% | 94.7% | 97.4% | 98.3% | 69.2% | 80.2% | 86.3% |
| hybrid (RRF) | 88.0% | 94.6% | 97.9% | 96.8% | 98.3% | 99.8% | 69.5% | 84.4% | 91.0% |
| hybrid + rerank, recency 0.2 | 86.7% | 94.7% | 97.9% | 97.0% | 98.7% | 99.8% | 71.3% | 85.0% | 91.0% |
| **hybrid + rerank, recency 0 (default)** | **89.1%** | **94.9%** | **97.9%** | **97.0%** | 98.5% | **99.8%** | **72.4%** | **85.3%** | **91.0%** |
| hybrid + rerank, user messages only | 90.7% | 95.7% | 98.1% | 97.0% | 98.5% | 99.1% | 71.9% | 80.4% | 85.0% |

R_all@10 by question type:

| Type | b | b-user | keyword | hybrid | c (rec 0.2) | c (rec 0) | c-user |
|---|---|---|---|---|---|---|---|
| single-session-user | 98.4% | 98.4% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% |
| single-session-assistant | 100.0% | 94.6% | 100.0% | 100.0% | 100.0% | 100.0% | 94.6% |
| single-session-preference | 90.0% | 96.7% | 80.0% | 96.7% | 96.7% | 96.7% | 93.3% |
| multi-session | 92.5% | 93.2% | 88.6% | 92.2% | 93.0% | 92.2% | 95.4% |
| knowledge-update | 97.9% | 99.3% | 99.3% | 99.3% | 96.5% | 99.3% | 100.0% |
| temporal-reasoning | 86.6% | 91.2% | 88.1% | 88.8% | 89.7% | 89.7% | 92.4% |

Readings:
- **Hybrid beats either list alone** on R_all@5 (88.0 vs 84.6 / 85.5) and on turn recall at every k.
- **A recency boost hurts**: 89.1 → 86.7 on R_all@5. In LongMemEval the evidence is not biased toward recent sessions.
- **User-only retrieval** has the best session recall, but it **loses assistant-side turns** (turn R@10 80.4 vs 85.3; single-session-assistant 94.6 vs 100), so it was not adopted.

### 10.3 Accuracy, n=60 (stratified, ±~12-point CIs)

Qwen3-0.6B:

| Config | Accuracy (95% CI) | All evidence sessions in prompt | Evidence turns in prompt | Prompt tokens | TTFT (median) |
|---|---|---|---|---|---|
| a truncation | 11.7% (5.8–22.2) | 10.3% | 13.3% | 7,606 | 3,856 ms |
| oracle-thread | 31.7% (21.3–44.2) | 94.8% | 96.4% | 4,442 | 1,960 ms |
| **oracle** | **43.3%** (31.6–55.9) | 100.0% | 97.9% | 4,799 | 2,104 ms |
| b vector top-k | 28.3% (18.5–40.8) | 89.7% | 75.6% | 1,800 | 555 ms |
| c memory engine | 36.7% (25.6–49.3) | 89.7% | 81.4% | 2,183 | 579 ms |
| **c/snip** | **38.3%** (27.1–51.0) | 89.7% | 81.4% | **1,148** | **254 ms** |
| c/k20 | 41.7% (30.1–54.3) | 98.3% | 93.9% | 5,611 | 1,990 ms |
| c/snip/k20 | 35.0% (24.2–47.6) | 98.3% | 93.9% | 2,670 | 781 ms |
| d (probe failed → same as c) | 36.7% (25.6–49.3) | 89.7% | 81.4% | 2,183 | 463 ms |
| d! Scroll-lite forced | **6.7%** (2.6–15.9) | 3.4% | 3.4% | 212 | 31 ms |

Qwen3-1.7B:

| Config | Accuracy (95% CI) | All evidence sessions in prompt | Evidence turns in prompt | Prompt tokens | TTFT (median) |
|---|---|---|---|---|---|
| a truncation | 10.0% (4.7–20.1) | 10.3% | 13.3% | 7,606 | 7,093 ms |
| oracle-thread | 43.3% (31.6–55.9) | 94.8% | 96.4% | 4,442 | 3,892 ms |
| **oracle** | **51.7%** (39.3–63.8) | 100.0% | 97.9% | 4,799 | 4,532 ms |
| b vector top-k | 46.7% (34.6–59.1) | 89.7% | 75.6% | 1,800 | 1,432 ms |
| c memory engine | 45.0% (33.1–57.5) | 89.7% | 81.4% | 2,183 | 1,594 ms |
| **c/snip** | **53.3%** (40.9–65.4) | 89.7% | 81.4% | **1,148** | **745 ms** |
| c/k20 | 48.3% (36.2–60.7) | 98.3% | 93.9% | 5,611 | 3,933 ms |
| c/snip/k20 | 43.3% (31.6–55.9) | 98.3% | 93.9% | 2,670 | 1,856 ms |
| d Scroll-lite (probe passed) | 48.3% (36.2–60.7) | 87.9% | 71.6% | 1,848 | 1,290 ms |
| d! forced | 48.3% (36.2–60.7) | 87.9% | 71.6% | 1,848 | 33 ms* |

\* d!'s TTFT is low because the d run had just processed identical prompts, so they were served from the prompt cache. It is not a real speed difference.

Accuracy by type, n=60 (10 per type; 8 temporal; 2 abstention):

| Type | 0.6B a | 0.6B oracle | 0.6B b | 0.6B c | 0.6B c/snip | 1.7B a | 1.7B oracle | 1.7B b | 1.7B c | 1.7B c/snip | 1.7B d |
|---|---|---|---|---|---|---|---|---|---|---|---|
| single-session-user | 0 | 70 | 20 | 50 | 50 | 0 | 60 | 40 | 40 | 60 | 70 |
| single-session-assistant | 20 | 90 | 80 | 80 | 90 | 20 | 100 | 100 | 100 | 90 | 100 |
| single-session-preference | 10 | 50 | 20 | 30 | 20 | 20 | 80 | 60 | 60 | 40 | 60 |
| multi-session | 0 | 0 | 10 | 20 | 30 | 0 | 0 | 10 | 20 | 50 | 0 |
| knowledge-update | 20 | 20 | 30 | 20 | 20 | 0 | 50 | 60 | 40 | 50 | 50 |
| temporal-reasoning | 0 | 12.5 | 0 | 0 | 0 | 12.5 | 12.5 | 0 | 0 | 25 | 0 |
| abstention | 100 | 100 | 50 | 100 | 100 | 50 | 50 | 50 | 50 | 50 | 50 |

Derived comparisons (c/snip vs the others, n=60):
- vs truncation: 3.3× (0.6B) and 5.3× (1.7B) the accuracy, with 7,606 / 1,148 = **6.6× fewer tokens** and 15.2× / 9.5× lower TTFT.
- vs oracle: 38.3 / 43.3 = **88%** (0.6B) and 53.3 / 51.7 = **103%** (1.7B) of the ceiling, with 1,148 / 4,799 = **24% of its tokens**.
- **Presentation matters**: the same evidence as dated memory notes (oracle) scores +11.6 (0.6B) and +8.4 (1.7B) points over the same evidence as chat turns (oracle-thread).

**Warning:** at n=60 every CI is about ±12 points. Several n=60 gains did **not** hold at larger n (§10.4, §10.6).

### 10.4 Accuracy, all 500 questions, Qwen3-0.6B

| Config | Accuracy (95% CI) | All evidence sessions in prompt | Evidence turns in prompt | R_any / R_all (ranked list) | Prompt tokens | TTFT |
|---|---|---|---|---|---|---|
| b vector top-k | 31.4% (27.5–35.6) | 83.4% | 73.6% | 97.2% / 91.0% | 1,977 | 589 ms |
| **c memory engine** | **33.6%** (29.6–37.9) | 85.5% | 79.5% | 98.3% / 92.7% | 2,305 | 770 ms |
| c/snip | 32.6% (28.6–36.8) | 85.5% | 79.5% | 98.3% / 92.7% | **1,165** | **364 ms** |

| Type (n) | b | c | c/snip |
|---|---|---|---|
| single-session-user (64) | 37.5% | 51.6% | 56.3% |
| single-session-assistant (56) | 75.0% | 73.2% | **57.1%** |
| single-session-preference (30) | 30.0% | 23.3% | 23.3% |
| multi-session (121) | 10.7% | 14.0% | 14.0% |
| knowledge-update (72) | 34.7% | 27.8% | 30.6% |
| temporal-reasoning (127) | 16.5% | 21.3% | 22.0% |
| abstention (30) | 76.7% | 76.7% | 70.0% |

Readings:
- c beats b by +2.2 points with 17% more tokens. That is consistent with the recall advantage, **but the CIs overlap**. The gain is
  concentrated in single-session-user (+14.1) and temporal (+4.8). b is better on knowledge-update (+6.9).
- **Snippets are a wash overall** (32.6 vs 33.6) at half the tokens and TTFT. They help user-side questions (+4.7) and **hurt
  assistant-side questions (−16.1)**: a long assistant answer gets cut to one chunk, often not the part being asked about. The n=60 run
  had suggested +1.6 / +8.3 points for snippets; that did not hold.

### 10.5 Small ablations (n=12, Qwen3-0.6B; indicative only)

**System prompt v1 vs v2** (`results/phase2-ab-sysprompt-0.6b.md`):

| Config | v2 (current) | v1 |
|---|---|---|
| oracle | 58.3% | 58.3% |
| c | 50.0% | 41.7% |

A tie on the oracle and one question better for v2 on c. It was adopted because it removed the "I don't have access to your personal
information" refusals seen in Phase 1, not because of a measured accuracy gain.

**c+ (model-written summaries and facts during ingestion)** (`results/phase2-cplus-0.6b.md`): **41.7% (5/12)**. For plain c on
comparable 12-question runs, the project log records 7/12, and the system-prompt A/B file shows 6/12 (50.0%). Either way, at 0.6B
model-written summaries and facts **added no accuracy**, and they cost about **4 minutes of LLM ingestion per question** (uncached).
c+ has not been run with a larger summariser or at larger n.

### 10.6 Accuracy across model sizes (dev split, n=151, ±7–8-point CIs)

All rows use the same retrieval and judge. Snippets are off in b, c, d and oracle.

| Model | b vector | c engine | c/snip | d Scroll-lite | oracle |
|---|---|---|---|---|---|
| Qwen3-0.6B | 29.8% (23.1–37.5) | 35.1% (27.9–43.0) | 33.1% (26.1–41.0) | 34.4%¹ (27.3–42.3) | 35.8% (28.6–43.7) |
| Qwen3-1.7B | 43.0% (35.4–51.0) | 40.4% (32.9–48.4) | 45.7% (38.0–53.6) | 37.1% (29.8–45.0) | 45.7% (38.0–53.6) |
| Llama-3.2-3B | 47.7% (39.9–55.6) | 47.7% (39.9–55.6) | 46.4% (38.6–54.3) | 45.0% (37.3–53.0) | 49.0% (41.2–56.9) |
| Qwen3-8B² | 57.6% (49.6–65.2) | 64.9% (57.0–72.1) | 62.3% (54.3–69.6) | **47.0%** (39.2–55.0) | 64.2% (56.3–71.4) |

¹ The probe fails at 0.6B, so d gets prompts identical to c. The one-question gap is noise from KV-cache reuse (6/151 answers differed).
² Qwen3-8B is also the judge, so self-preference bias [13] may inflate its scores.

**Prompt tokens (mean):**

| Model | b | c | c/snip | d | oracle |
|---|---|---|---|---|---|
| Qwen3 (0.6B / 1.7B / 8B) | 1,953 | 2,288 | 1,174 | 2,288 / 1,953 / 1,438 | 5,513 |
| Llama-3.2-3B | 1,895 | 2,225 | 1,120 | 1,539 | 5,394 |

**Paired tests (same questions, McNemar exact).** Only one difference is significant:

| Comparison | 0.6B | 1.7B | Llama 3B | 8B |
|---|---|---|---|---|
| c vs b | +5.3 (p=.24) | −2.6 (p=.57) | 0.0 | +7.3 (p=.09) |
| c/snip vs c | −2.0 | +5.3 (p=.23) | −1.3 | −2.6 |
| d vs c | (= c) | −3.3 (p=.44) | −2.6 | **−17.9 (p<.001)** |
| oracle vs c | +0.7 | +5.3 (p=.22) | +1.3 | −0.7 |

**Evidence reaching the prompt:**

| | b | c / c/snip | d (1.7B / 3B / 8B) | oracle |
|---|---|---|---|---|
| All evidence sessions in prompt | 86.0% | 88.1% | 81.1 / 71.3 / 69.2% | 99.3–100% |
| Evidence turns in prompt | 73.6% | 78.2% | 66.2 / 62.4 / 57.1% | 98.3–98.7% |
| R_any / R_all of ranked list | 95.8 / 91.6% | 97.9 / 94.0% | 97.2/89.7 · 94.4/83.2 · 88.8/80.0% | 100 / 100% |

**Median TTFT:**

| Model | b | c | c/snip | d | oracle |
|---|---|---|---|---|---|
| Qwen3-0.6B | 839 ms | 873 ms | **350 ms** | 61 ms³ | 3,682 ms |
| Qwen3-1.7B | 1,624 ms | 1,695 ms | **775 ms** | 1,253 ms | 5,352 ms |
| Llama-3.2-3B | 2,898 ms | 3,110 ms | **1,381 ms** | 1,765 ms | 9,328 ms |
| Qwen3-8B | 6,517 ms | 7,454 ms | **3,329 ms** | 4,199 ms | 23,417 ms |

³ Same prompts as c, served from the prompt cache; not a real speed-up.

Scroll-lite's lower TTFT at 1.7B–8B comes from smaller answer prompts, but its **total latency is the highest** of the retrieval configs
(e.g. 8B: 11,216 ms vs 9,829 ms for c), because planning adds extra generation passes.

### 10.7 Accuracy by question type (dev, n=151)

Each cell is accuracy for that config; oracle shown for comparison.

| Type (n) | 0.6B c | 0.6B oracle | 1.7B c/snip | 1.7B oracle | Llama 3B c | Llama 3B oracle | 8B c | 8B oracle |
|---|---|---|---|---|---|---|---|---|
| single-session-user (20) | 55.0 | 55.0 | 65.0 | 70.0 | 75.0 | 75.0 | 95.0 | 90.0 |
| single-session-assistant (17) | 88.2 | 88.2 | 76.5 | 94.1 | 94.1 | 94.1 | 100.0 | 100.0 |
| single-session-preference (10) | 30.0 | 50.0 | 40.0 | 80.0 | 40.0 | 40.0 | 70.0 | 80.0 |
| multi-session (37) | 18.9 | 16.2 | 32.4 | 16.2 | 29.7 | 24.3 | 48.6 | 56.8 |
| knowledge-update (21) | 23.8 | 19.0 | 47.6 | 52.4 | 47.6 | 47.6 | 81.0 | 61.9 |
| temporal-reasoning (38) | 13.2 | 13.2 | 26.3 | 23.7 | 21.1 | 31.6 | 42.1 | 39.5 |
| abstention (8) | 87.5 | 100.0 | 87.5 | 62.5 | 100.0 | 100.0 | 50.0 | 62.5 |

Full per-type tables for every config (dev):

<details><summary>Qwen3-0.6B</summary>

| Type | b | c | c/snip | d | oracle |
|---|---|---|---|---|---|
| single-session-user | 35.0 | 55.0 | 55.0 | 55.0 | 55.0 |
| single-session-assistant | 88.2 | 88.2 | 70.6 | 88.2 | 88.2 |
| single-session-preference | 20.0 | 30.0 | 20.0 | 30.0 | 50.0 |
| multi-session | 16.2 | 18.9 | 21.6 | 18.9 | 16.2 |
| knowledge-update | 38.1 | 23.8 | 28.6 | 19.0 | 19.0 |
| temporal-reasoning | 5.3 | 13.2 | 7.9 | 13.2 | 13.2 |
| abstention | 62.5 | 87.5 | 100.0 | 87.5 | 100.0 |
</details>

<details><summary>Qwen3-1.7B</summary>

| Type | b | c | c/snip | d | oracle |
|---|---|---|---|---|---|
| single-session-user | 60.0 | 45.0 | 65.0 | 65.0 | 70.0 |
| single-session-assistant | 94.1 | 94.1 | 76.5 | 94.1 | 94.1 |
| single-session-preference | 60.0 | 60.0 | 40.0 | 60.0 | 80.0 |
| multi-session | 16.2 | 21.6 | 32.4 | 5.4 | 16.2 |
| knowledge-update | 52.4 | 38.1 | 47.6 | 42.9 | 52.4 |
| temporal-reasoning | 18.4 | 18.4 | 26.3 | 10.5 | 23.7 |
| abstention | 87.5 | 87.5 | 87.5 | 75.0 | 62.5 |
</details>

<details><summary>Llama-3.2-3B-Instruct</summary>

| Type | b | c | c/snip | d | oracle |
|---|---|---|---|---|---|
| single-session-user | 75.0 | 75.0 | 75.0 | 75.0 | 75.0 |
| single-session-assistant | 88.2 | 94.1 | 64.7 | 88.2 | 94.1 |
| single-session-preference | 40.0 | 40.0 | 40.0 | 60.0 | 40.0 |
| multi-session | 29.7 | 29.7 | 40.5 | 27.0 | 24.3 |
| knowledge-update | 47.6 | 47.6 | 47.6 | 47.6 | 47.6 |
| temporal-reasoning | 23.7 | 21.1 | 21.1 | 10.5 | 31.6 |
| abstention | 100.0 | 100.0 | 87.5 | 100.0 | 100.0 |
</details>

<details><summary>Qwen3-8B (also the judge)</summary>

| Type | b | c | c/snip | d | oracle |
|---|---|---|---|---|---|
| single-session-user | 90.0 | 95.0 | 85.0 | 75.0 | 90.0 |
| single-session-assistant | 100.0 | 100.0 | 82.4 | 100.0 | 100.0 |
| single-session-preference | 80.0 | 70.0 | 80.0 | 50.0 | 80.0 |
| multi-session | 37.8 | 48.6 | 48.6 | 29.7 | 56.8 |
| knowledge-update | 66.7 | 81.0 | 76.2 | 38.1 | 61.9 |
| temporal-reasoning | 28.9 | 42.1 | 39.5 | 34.2 | 39.5 |
| abstention | 62.5 | 50.0 | 75.0 | 25.0 | 62.5 |
</details>

### 10.8 Qualitative findings from live runs

| Observation | Model | Change made |
|---|---|---|
| Fact extraction returned `[]` for every message, even without a grammar | Qwen3-0.6B | Gate grammar + grounding filter; no confidence asked. Afterwards dog, city and name were extracted, and questions were rejected |
| Reflection emitted `UPDATE id 1` with an empty playbook | Qwen3-0.6B | The grammar only allows ids that exist |
| Vector search always returned the nearest neighbours, even unrelated ones | bge-small | Added `minVectorScore`; with bge-small, unrelated texts score around 0.5 cosine, so 0.15 filters little (§11) |
| The model **copied retrieved assistant replies verbatim** ("Keep Biscuit in mind for recipes" kept coming back) | Qwen3-0.6B | Led to the `user`-only retrieval experiment (rejected; §10.2) and to presenting memories as dated notes rather than transcript lines |
| Scroll-lite plans without examples: 0/6 sensible (e.g. `get_session 1` for "restaurant last week", `get_facts gym` for a count question) | 0.6B and 1.7B | 3 worked examples → 5/6 (0.6B) and 4/6 (1.7B) sensible plans. Qwen3-8B produced clean plans without examples |
| Forced Scroll-lite on 0.6B mostly planned "no lookup" | Qwen3-0.6B | Accuracy 6.7%, so the probe + fallback are essential |
| The model said "I don't have access to your personal information" with evidence in the prompt | 0.6B / 1.7B | System prompt v2 |

---

## 11. What did not work, limitations and open items

### 11.1 Negative results

1. **Scroll-lite (model-planned, grammar-constrained retrieval) does not help at any size tested, and gets worse as models grow.**
   On dev n=151: −3.3 (1.7B), −2.6 (Llama 3B), −17.9 points at 8B (p<0.001). Its plans put less evidence into the prompt (8B: 69.2% of
   questions with all evidence sessions vs 88.1% for hybrid search). At 0.6B it fails the probe, and forced on it scores 6.7%. Phase 2's
   +3.3 at 1.7B (n=60) did not replicate (−3.3 at n=151). It is **off by default at every size**. This answers the research question in §2
   negatively for 0.6B–8B with this operation set.
2. **Model-written summaries and facts (c+) did not improve accuracy at 0.6B** (5/12, versus 6–7/12 for plain c on comparable runs) and
   cost ~4 minutes of ingestion per question.
3. **Snippets cost 16–29 points on assistant-side questions** (n=500: −16.1; dev: −17.6 / −17.6 / −29.4 / −17.6 from 0.6B to 8B). They are
   kept as a token and latency choice (≈ half the tokens and TTFT), not an accuracy win. The planned fix (keep whole assistant messages, or
   two chunks, when the question asks what the assistant said) is not built.
4. **A recency boost in reranking lowers recall** (R_all@5 89.1 → 86.7).
5. **User-only retrieval** improves session recall but loses assistant-side evidence, so it was rejected.
6. **Knowledge updates with small models.** Below 8B, plain vector search is equal to or better than the engine on knowledge-update
   (0.6B 38.1 vs 23.8; 1.7B 52.4 vs 38.1), even though the system prompt says to trust the newest memory. Small models don't reliably pick
   the newer of two conflicting memories. At 8B the engine wins (81.0 vs 66.7).
7. **Counting and temporal questions fail even with perfect evidence.** Oracle multi-session accuracy is 16.2 / 16.2 / 24.3 / 56.8% and
   temporal 13.2 / 23.7 / 31.6 / 39.5% (0.6B → 8B). Retrieval can't fix this; it is the model's reasoning.
8. **No retrieval setting moves accuracy by more than ~5 points at a fixed model size.** The largest effect in the whole study is model size.

### 11.2 Known limitations and untested parts

- **The held-out test split (349 questions) has not been run.** All Phase 5 numbers are dev numbers, and Phase 2 tuned on the same 60
  questions it reported (they are inside dev).
- **The judge has not been audited.** 50 judged answers were sampled for human labelling (`results/judge-audit.md`), but no labels exist
  yet, so judge agreement and Cohen's kappa [18] are **unknown**.
- **Qwen3-8B is both judge and one of the models under test**, so its scores may carry self-preference bias [13].
- **Qwen3-4B is missing** from the model-size table (the download failed at 1.89 of 2.5 GB).
- **`minVectorScore` = 0.15** was chosen for the model-free hash embedder used in tests. With bge-small, unrelated texts score ~0.5, so the
  floor filters almost nothing. It was flagged for tuning in Phase 2; no tuning result is recorded.
- **`relativeTime`** ("N days before now" on each memory, aimed at temporal questions) is implemented but not measured.
- **Episodic summaries, facts, compression and the playbook are not exercised by the main benchmark configs** (b, c, d run with those
  layers off, so they need no LLM at ingestion). Only c+ (n=12) tested summaries and facts. Compression and the playbook have unit tests and
  live checks, but no benchmark numbers.
- **Facts are extracted only from user messages**, by design. Anything only the assistant said can't become a fact.
- **The vector index is a brute-force scan.** It is measured to 10K events (7.7 ms); behaviour at much larger scale is not measured.
- **Run-level uncertainty about rerank weights.** The n=60 runs and the recall sweep happened on the same day the recency default changed
  from 0.2 to 0. The run files don't record which weights each n=60 accuracy run used. The dev (n=151) runs are after the change.
- A code comment in the config file still cites the n=60 snippet gains (+1.6 / +8.3); the n=500 result supersedes it.

### 11.3 Open items (planned, not done)

Judge-audit labels → agreement and kappa · Qwen3-4B run · Phase 5 Part B: six engine changes tested one flag at a time on dev
(including computed answers for counting/temporal questions, a "(latest)" tag for knowledge updates, and the assistant-snippet fix) ·
Part C: the winning configuration run once on the 349-question test split · c+ with a larger summariser · `relativeTime` on temporal
questions · cache-cold timing runs.

---

## 12. Threats to validity

- **Sample size.** n=60 gives ~±12-point CIs, and n=151 gives ~±7–8 points. Differences under ~10 points at n=60 and ~5 points at n=151 should be read as noise unless McNemar says otherwise.
- **Noise floor from KV-cache reuse.** Identical prompts at temperature 0 gave different greedy answers on 6/151 questions (4%), because
  reusing a cached prefix changes floating-point arithmetic. Gaps under ~3 points are treated as zero.
- **Selection on the same data.** Phase 2 defaults were tuned on questions later reported. The dev/test split fixes this going forward, but the test split is still unrun.
- **LLM judge.** Not human-validated (§11.2). One judge model, no ensemble.
- **Single hardware platform and quantisation** (Apple M5, Q4_K_M). Peak RSS values in the run tables include llama-server's default 8 GiB host prompt cache, so they are **not** model memory.
- **One benchmark.** LongMemEval_s only. Other memory benchmarks (e.g. LoCoMo, used by MemoryOS [2]) were not run.

---

## 13. References

[1] Y. Lin, E. Ang, E. Zhu, B. Ding, J. Zhou. *Context as an Environment: Programmatic Context Management for Long-Horizon Agents* (the system is named "Scroll"). arXiv:2608.21690, 2026. https://arxiv.org/abs/2608.21690

[2] J. Kang, M. Ji, Z. Zhao, T. Bai. *Memory OS of AI Agent.* arXiv:2506.06326, 2025. https://arxiv.org/abs/2506.06326

[3] N. F. Liu, K. Lin, J. Hewitt, A. Paranjape, M. Bevilacqua, F. Petroni, P. Liang. *Lost in the Middle: How Language Models Use Long Contexts.* Transactions of the ACL, 2024 (arXiv:2307.03172, 2023). https://arxiv.org/abs/2307.03172

[4] M. Kang, W.-N. Chen, D. Han, H. A. Inan, L. Wutschitz, Y. Chen, R. Sim, S. Rajmohan. *ACON: Optimizing Context Compression for Long-horizon LLM Agents.* arXiv:2510.00615, 2025. https://arxiv.org/abs/2510.00615

[5] Q. Zhang, C. Hu, S. Upasani, B. Ma, F. Hong, V. Kamanuru, J. Rainton, C. Wu, M. Ji, H. Li, U. Thakker, J. Zou, K. Olukotun. *Agentic Context Engineering: Evolving Contexts for Self-Improving Language Models.* arXiv:2510.04618, 2025. https://arxiv.org/abs/2510.04618

[6] D. Wu, H. Wang, W. Yu, Y. Zhang, K.-W. Chang, D. Yu. *LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory.* ICLR 2025 (arXiv:2410.10813). https://arxiv.org/abs/2410.10813 · Cleaned data: https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned

[7] S. Robertson, H. Zaragoza. *The Probabilistic Relevance Framework: BM25 and Beyond.* Foundations and Trends in Information Retrieval 3(4):333–389, 2009.

[8] M. F. Porter. *An algorithm for suffix stripping.* Program 14(3):130–137, 1980.

[9] G. V. Cormack, C. L. A. Clarke, S. Büttcher. *Reciprocal Rank Fusion outperforms Condorcet and individual rank learning methods.* SIGIR 2009.

[10] S. Xiao, Z. Liu, P. Zhang, N. Muennighoff, D. Lian, J.-Y. Nie. *C-Pack: Packed Resources For General Chinese Embeddings* (the BGE embedding models). arXiv:2309.07597, 2023. https://arxiv.org/abs/2309.07597 · Model: https://huggingface.co/BAAI/bge-small-en-v1.5

[11] A. Yang et al. (Qwen Team). *Qwen3 Technical Report.* arXiv:2505.09388, 2025. https://arxiv.org/abs/2505.09388

[12] A. Grattafiori et al. (Llama Team, AI @ Meta). *The Llama 3 Herd of Models.* arXiv:2407.21783, 2024. https://arxiv.org/abs/2407.21783

[13] L. Zheng, W.-L. Chiang, Y. Sheng, S. Zhuang, Z. Wu, Y. Zhuang, Z. Lin, Z. Li, D. Li, E. P. Xing, H. Zhang, J. E. Gonzalez, I. Stoica. *Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena.* NeurIPS 2023 Datasets and Benchmarks (arXiv:2306.05685). Discusses position, verbosity and self-enhancement bias. https://arxiv.org/abs/2306.05685

[14] ggml-org. *llama.cpp* (inference engine, `llama-server`, GBNF grammars, prompt caching). https://github.com/ggml-org/llama.cpp · GBNF: https://github.com/ggml-org/llama.cpp/blob/master/grammars/README.md

[15] SQLite. *FTS5 Extension* (full-text search, `bm25()`, porter tokenizer). https://www.sqlite.org/fts5.html

[16] E. B. Wilson. *Probable inference, the law of succession, and statistical inference.* Journal of the American Statistical Association 22(158):209–212, 1927.

[17] Q. McNemar. *Note on the sampling error of the difference between correlated proportions or percentages.* Psychometrika 12(2):153–157, 1947.

[18] J. Cohen. *A coefficient of agreement for nominal scales.* Educational and Psychological Measurement 20(1):37–46, 1960.

[19] X. Wang, Y. Chen, L. Yuan, Y. Zhang, Y. Li, H. Peng, H. Ji. *Executable Code Actions Elicit Better LLM Agents* (CodeAct). ICML 2024 (arXiv:2402.01030). https://arxiv.org/abs/2402.01030

arXiv titles, authors and dates for [1]–[6], [10]–[13] and [19] were checked against arxiv.org on 2026-11-18. [7]–[9] and [16]–[18] are
standard citations and were not re-fetched.

---

## 14. Appendix A: where each number comes from

All paths are relative to the project repository.

| Section | Source file |
|---|---|
| §4, §8 parameters and algorithms | `packages/core/src/config.ts`, `selection/retriever.ts`, `selection/router.ts`, `selection/scrollLite.ts`, `context/budget.ts`, `context/assembler.ts`, `compression/rolling.ts`, `compression/summarize.ts`, `indexes/*.ts`, `playbook/playbook.ts`, `jobs/queue.ts`, `privacy/forget.ts`, `store/schema.ts`, `engine.ts` |
| §9 harness | `packages/eval/src/configs.ts`, `runner.ts`, `judge.ts`, `dataset.ts`, `recall.ts`, `report.ts` |
| §10.1 speed | Phase 1–2 build log (not published) |
| §10.2 recall | `results/phase2-recall-full.md` |
| §10.3 n=60 | `results/phase2-main-0.6b.md`, `results/phase2-main-1.7b.md` |
| §10.4 n=500 | `results/phase2-wide-0.6b.md` |
| §10.5 ablations | `results/phase2-ab-sysprompt-0.6b.md`, `results/phase2-cplus-0.6b.md` |
| §10.6–10.7 dev n=151 | `results/phase5-dev-0.6b.md`, `phase5-dev-1.7b.md`, `phase5-dev-llama3.2-3b.md`, `phase5-dev-qwen3-8b.md`, `results/phase5-partA.md` (McNemar tests) |
| §10.8 qualitative | Phase 1–2 build log (not published) |
| §11.2 judge audit | `results/judge-audit.md` |
| Raw per-question records | `results/raw/*.jsonl` (kept locally, not committed) |

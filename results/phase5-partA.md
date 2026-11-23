# Phase 5 · Part A — trustworthy eval + dev baselines (2026-11-14)

Everything here is on the **dev split** (151 questions). The 349 test questions have not been run. Per-model tables:
`results/phase5-dev-0.6b.md`, `phase5-dev-1.7b.md`, `phase5-dev-llama3.2-3b.md`, `phase5-dev-qwen3-8b.md`; side by side: `phase5-dev-models.md`.
Settings identical for every row: 8,192-token context, temperature 0, bge-small embedder, judge Qwen3-8B Q4_K_M.

## What was built

| Item | Command | Notes |
|---|---|---|
| Dev/test split | `npm run eval -- --split dev …` | Per type, by id hash: first max(10, 30%) → dev. **151 dev / 349 test.** All 60 Phase 2 tuning questions are in dev. `--split test` refuses to run without `--final-test` |
| Judge audit | `npm run judge-audit -- --export` / `--score` | 50 seeded-random rows in `results/judge-audit.md`. **Not labeled yet: no agreement number exists** |
| Model-size runner | `npm run bench-models -- start <models…>` · `watch` · `stop` · `summary` · `download` | Detached, keeps the Mac awake, resumable, one server per model, never overlaps another eval |

## Accuracy, dev split (n=151, ±7–8 points 95% CI each)

| Model | b: vector | c: AURA | c + snippets | d: Scroll-lite | oracle |
|---|---|---|---|---|---|
| Qwen3-0.6B | 29.8% | 35.1% | 33.1% | 34.4%¹ | 35.8% |
| Qwen3-1.7B | 43.0% | 40.4% | 45.7% | 37.1% | 45.7% |
| Llama-3.2-3B | 47.7% | 47.7% | 46.4% | 45.0% | 49.0% |
| Qwen3-8B² | 57.6% | 64.9% | 62.3% | **47.0%** | 64.2% |
| Prompt tokens (Qwen) | 1,953 | 2,288 | 1,174 | 1,438–2,288 | 5,513 |

¹ The probe fails at 0.6B, so d = c with identical prompts; the 1-question gap is noise from KV-cache reuse (6/151 answers differed).
² Qwen3-8B is also the judge, so self-preference may inflate its scores. It doesn't fit the S23 Ultra (the device-fit check says it needs 16 GB).
Qwen3-4B is missing: its download failed at 1.89 of 2.5 GB (`npm run bench-models -- start qwen3-4b` resumes it).

**Paired tests (same questions, McNemar exact).** Only one difference is significant:

| Comparison | 0.6B | 1.7B | Llama 3B | 8B |
|---|---|---|---|---|
| c vs b | +5.3 (p=.24) | −2.6 (p=.57) | 0.0 | +7.3 (p=.09) |
| c/snip vs c | −2.0 | +5.3 (p=.23) | −1.3 | −2.6 |
| d vs c | (= c) | −3.3 (p=.44) | −2.6 | **−17.9 (p<.001)** |
| oracle vs c | +0.7 | +5.3 (p=.22) | +1.3 | −0.7 |

## What the numbers say

1. **Model size is the biggest lever.** c goes 35 → 40 → 48 → 65% from 0.6B to 8B. No engine setting moved accuracy more than ~5 points.
2. **Retrieval is not the bottleneck.** The oracle (all evidence, nothing else) beats c by 5 points at most, never significantly. c already gets 88% of evidence sessions into the prompt. The gap is the model *using* the evidence, which is what Part B targets.
3. **Scroll-lite hurts, and hurts more as models get bigger.** At 8B it loses 18 points: plans fetch less (evidence in prompt 69% vs 88%, recall 89 vs 98%). Phase 2's +3.3 at 1.7B (n=60) didn't hold up (−3.3 at n=151). Keep it off by default.
4. **Counting and dates fail even with perfect evidence.** Oracle multi-session: 16 / 16 / 24 / 57%; temporal: 13 / 24 / 32 / 40% (0.6B → 8B). This is the case for Part B.1 (computed answers).
5. **Snippets cost assistant-side questions at every size**: −18, −18, −29, −18 points on single-session-assistant. Overall it's a wash, at half the tokens and TTFT. This is Part B.3's target.
6. **Knowledge-update:** b ≥ c at 0.6B (38 vs 24) and 1.7B (52 vs 38), but c > b at 8B (81 vs 67). Small models don't resolve conflicting memories. This is Part B.2's target ("(latest)" tag).
7. **Noise floor:** identical prompts gave different greedy answers on 4% of questions (KV-cache reuse). Treat gaps under ~3 points as zero. Timing comparisons (Part B.5) need cache-cold runs.

## Still open

- **Judge audit:** label `results/judge-audit.md`, then `npm run judge-audit -- --score`.
- **Qwen3-4B:** resume the download and run (`npm run bench-models -- start qwen3-4b`, about 2 h).
- Part B starts after your review.

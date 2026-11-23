# Eval run cplus-0.6b

- **run:** cplus-0.6b
- **date:** 2026-11-11
- **questions:** 12 (LongMemEval_s, 2 per type, stratified by hashed id)
- **model:** Qwen3-0.6B-Q4_K_M
- **embedder:** bge-small-en-v1.5-q8_0
- **judge:** Qwen3-8B-Q4_K_M
- **prompt budget:** 8192 tokens ctx − 256 output reserve

| Config | N | Accuracy (95% CI) | All evidence sessions in prompt | Evidence turns in prompt | Recall any / all (ranked list) | Prompt tokens | TTFT (median) | Latency (median) | Peak server RSS |
|---|---|---|---|---|---|---|---|---|---|
| c+ | 12 | **41.7%** (19.3%–68.0%) | 100.0% | 90.0% | 100.0% / 100.0% | 2,189 | 826 ms | 1,223 ms | 8,179 MB |

**Accuracy by question type**

| Type | c+ |
|---|---|
| single-session-user | 50.0% (2) |
| single-session-assistant | 100.0% (2) |
| single-session-preference | 0.0% (2) |
| multi-session | 0.0% (2) |
| knowledge-update | 0.0% (2) |
| temporal-reasoning | – |
| abstention | 100.0% (2) |

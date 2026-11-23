# Eval run smoke-nojudge

- **run:** smoke-nojudge
- **date:** 2026-11-11
- **questions:** 6 (LongMemEval_s, 1 per type, stratified by hashed id)
- **model:** Qwen3-0.6B-Q4_K_M
- **embedder:** bge-small-en-v1.5-q8_0
- **judge:** none
- **prompt budget:** 8192 tokens ctx − 256 output reserve

| Config | N | Accuracy | All evidence in prompt | Evidence turns in prompt | Recall any / all (ranked list) | Prompt tokens | TTFT (median) | Latency (median) | Peak server RSS |
|---|---|---|---|---|---|---|---|---|---|
| a | 6 | **–** | 0.0% | 0.0% | – | 7,557 | 2,769 ms | 4,363 ms | 4,912 MB |
| oracle | 6 | **–** | 100.0% | 100.0% | – | 4,200 | 1,598 ms | 3,175 ms | 4,730 MB |
| b | 6 | **–** | 80.0% | 80.0% | 100.0% / 100.0% | 1,740 | 455 ms | 1,020 ms | 5,188 MB |
| c | 6 | **–** | 80.0% | 80.0% | 100.0% / 100.0% | 2,203 | 546 ms | 1,155 ms | 5,238 MB |

**Accuracy by question type**

| Type | a | oracle | b | c |
|---|---|---|---|---|
| single-session-user | – | – | – | – |
| single-session-assistant | – | – | – | – |
| single-session-preference | – | – | – | – |
| multi-session | – | – | – | – |
| knowledge-update | – | – | – | – |
| temporal-reasoning | – | – | – | – |
| abstention | – | – | – | – |

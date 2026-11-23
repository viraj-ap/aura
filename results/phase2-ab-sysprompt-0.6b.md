# Eval run ab-sysprompt-0.6b

- **run:** ab-sysprompt-0.6b
- **date:** 2026-11-11
- **questions:** 12 (LongMemEval_s, 2 per type, stratified by hashed id)
- **model:** Qwen3-0.6B-Q4_K_M
- **embedder:** bge-small-en-v1.5-q8_0
- **judge:** Qwen3-8B-Q4_K_M
- **prompt budget:** 8192 tokens ctx − 256 output reserve

| Config | N | Accuracy | All evidence sessions in prompt | Evidence turns in prompt | Recall any / all (ranked list) | Prompt tokens | TTFT (median) | Latency (median) | Peak server RSS |
|---|---|---|---|---|---|---|---|---|---|
| oracle | 12 | **58.3%** | 100.0% | 100.0% | 100.0% / 100.0% | 4,797 | 2,629 ms | 3,704 ms | 2,835 MB |
| oracle/sp1 | 12 | **58.3%** | 100.0% | 100.0% | 100.0% / 100.0% | 4,769 | 2,008 ms | 3,359 ms | 3,095 MB |
| c | 12 | **50.0%** | 100.0% | 90.0% | 100.0% / 100.0% | 2,204 | 883 ms | 1,312 ms | 3,064 MB |
| c/sp1 | 12 | **41.7%** | 100.0% | 90.0% | 100.0% / 100.0% | 2,176 | 1,189 ms | 1,809 ms | 3,064 MB |

**Accuracy by question type**

| Type | oracle | oracle/sp1 | c | c/sp1 |
|---|---|---|---|---|
| single-session-user | 100.0% (2) | 50.0% (2) | 50.0% (2) | 50.0% (2) |
| single-session-assistant | 100.0% (2) | 100.0% (2) | 100.0% (2) | 50.0% (2) |
| single-session-preference | 50.0% (2) | 100.0% (2) | 50.0% (2) | 50.0% (2) |
| multi-session | 0.0% (2) | 0.0% (2) | 0.0% (2) | 0.0% (2) |
| knowledge-update | 0.0% (2) | 0.0% (2) | 0.0% (2) | 0.0% (2) |
| temporal-reasoning | – | – | – | – |
| abstention | 100.0% (2) | 100.0% (2) | 100.0% (2) | 100.0% (2) |

# Eval run dev-llama3.2-3b

- **run:** dev-llama3.2-3b
- **date:** 2026-11-14
- **questions:** 151 (LongMemEval_s **dev** split)
- **model:** Llama-3.2-3B-Instruct-Q4_K_M
- **embedder:** bge-small-en-v1.5-q8_0
- **judge:** Qwen3-8B-Q4_K_M
- **prompt budget:** 8192 tokens ctx − 256 output reserve

| Config | N | Accuracy (95% CI) | All evidence sessions in prompt | Evidence turns in prompt | Recall any / all (ranked list) | Prompt tokens | TTFT (median) | Latency (median) | Peak server RSS |
|---|---|---|---|---|---|---|---|---|---|
| b | 151 | **47.7%** (39.9%–55.6%) | 86.0% | 73.6% | 95.8% / 91.6% | 1,895 | 2,898 ms | 3,906 ms | 6,760 MB |
| c | 151 | **47.7%** (39.9%–55.6%) | 88.1% | 78.2% | 97.9% / 94.0% | 2,225 | 3,110 ms | 3,977 ms | 6,958 MB |
| c/snip | 151 | **46.4%** (38.6%–54.3%) | 88.1% | 78.2% | 97.9% / 94.0% | 1,120 | 1,381 ms | 2,028 ms | 7,149 MB |
| d | 151 | **45.0%** (37.3%–53.0%) | 71.3% | 62.4% | 94.4% / 83.2% | 1,539 | 1,765 ms | 4,599 ms | 7,293 MB |
| oracle | 151 | **49.0%** (41.2%–56.9%) | 100.0% | 98.7% | 100.0% / 100.0% | 5,394 | 9,328 ms | 11,179 ms | 7,431 MB |

**Accuracy by question type**

| Type | b | c | c/snip | d | oracle |
|---|---|---|---|---|---|
| single-session-user | 75.0% (20) | 75.0% (20) | 75.0% (20) | 75.0% (20) | 75.0% (20) |
| single-session-assistant | 88.2% (17) | 94.1% (17) | 64.7% (17) | 88.2% (17) | 94.1% (17) |
| single-session-preference | 40.0% (10) | 40.0% (10) | 40.0% (10) | 60.0% (10) | 40.0% (10) |
| multi-session | 29.7% (37) | 29.7% (37) | 40.5% (37) | 27.0% (37) | 24.3% (37) |
| knowledge-update | 47.6% (21) | 47.6% (21) | 47.6% (21) | 47.6% (21) | 47.6% (21) |
| temporal-reasoning | 23.7% (38) | 21.1% (38) | 21.1% (38) | 10.5% (38) | 31.6% (38) |
| abstention | 100.0% (8) | 100.0% (8) | 87.5% (8) | 100.0% (8) | 100.0% (8) |

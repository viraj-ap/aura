# Eval run dev-1.7b

- **run:** dev-1.7b
- **date:** 2026-11-14
- **questions:** 151 (LongMemEval_s **dev** split)
- **model:** Qwen3-1.7B-Q4_K_M
- **embedder:** bge-small-en-v1.5-q8_0
- **judge:** Qwen3-8B-Q4_K_M
- **prompt budget:** 8192 tokens ctx − 256 output reserve

| Config | N | Accuracy (95% CI) | All evidence sessions in prompt | Evidence turns in prompt | Recall any / all (ranked list) | Prompt tokens | TTFT (median) | Latency (median) | Peak server RSS |
|---|---|---|---|---|---|---|---|---|---|
| b | 151 | **43.0%** (35.4%–51.0%) | 86.0% | 73.6% | 95.8% / 91.6% | 1,953 | 1,624 ms | 2,835 ms | 5,161 MB |
| c | 151 | **40.4%** (32.9%–48.4%) | 88.1% | 78.2% | 97.9% / 94.0% | 2,288 | 1,695 ms | 3,049 ms | 4,962 MB |
| c/snip | 151 | **45.7%** (38.0%–53.6%) | 88.1% | 78.2% | 97.9% / 94.0% | 1,174 | 775 ms | 1,916 ms | 5,052 MB |
| d | 151 | **37.1%** (29.8%–45.0%) | 81.1% | 66.2% | 97.2% / 89.7% | 1,953 | 1,253 ms | 3,728 ms | 5,246 MB |
| oracle | 151 | **45.7%** (38.0%–53.6%) | 99.3% | 98.3% | 100.0% / 100.0% | 5,513 | 5,352 ms | 7,596 ms | 5,246 MB |

**Accuracy by question type**

| Type | b | c | c/snip | d | oracle |
|---|---|---|---|---|---|
| single-session-user | 60.0% (20) | 45.0% (20) | 65.0% (20) | 65.0% (20) | 70.0% (20) |
| single-session-assistant | 94.1% (17) | 94.1% (17) | 76.5% (17) | 94.1% (17) | 94.1% (17) |
| single-session-preference | 60.0% (10) | 60.0% (10) | 40.0% (10) | 60.0% (10) | 80.0% (10) |
| multi-session | 16.2% (37) | 21.6% (37) | 32.4% (37) | 5.4% (37) | 16.2% (37) |
| knowledge-update | 52.4% (21) | 38.1% (21) | 47.6% (21) | 42.9% (21) | 52.4% (21) |
| temporal-reasoning | 18.4% (38) | 18.4% (38) | 26.3% (38) | 10.5% (38) | 23.7% (38) |
| abstention | 87.5% (8) | 87.5% (8) | 87.5% (8) | 75.0% (8) | 62.5% (8) |

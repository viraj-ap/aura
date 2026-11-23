# Eval run dev-qwen3-8b

- **run:** dev-qwen3-8b
- **date:** 2026-11-14
- **questions:** 151 (LongMemEval_s **dev** split)
- **model:** Qwen3-8B-Q4_K_M
- **embedder:** bge-small-en-v1.5-q8_0
- **judge:** Qwen3-8B-Q4_K_M
- **prompt budget:** 8192 tokens ctx − 256 output reserve

| Config | N | Accuracy (95% CI) | All evidence sessions in prompt | Evidence turns in prompt | Recall any / all (ranked list) | Prompt tokens | TTFT (median) | Latency (median) | Peak server RSS |
|---|---|---|---|---|---|---|---|---|---|
| b | 151 | **57.6%** (49.6%–65.2%) | 86.0% | 73.6% | 95.8% / 91.6% | 1,953 | 6,517 ms | 8,810 ms | 9,728 MB |
| c | 151 | **64.9%** (57.0%–72.1%) | 88.1% | 78.2% | 97.9% / 94.0% | 2,288 | 7,454 ms | 9,829 ms | 9,679 MB |
| c/snip | 151 | **62.3%** (54.3%–69.6%) | 88.1% | 78.2% | 97.9% / 94.0% | 1,174 | 3,329 ms | 5,295 ms | 9,258 MB |
| d | 151 | **47.0%** (39.2%–55.0%) | 69.2% | 57.1% | 88.8% / 80.0% | 1,438 | 4,199 ms | 11,216 ms | 9,422 MB |
| oracle | 151 | **64.2%** (56.3%–71.4%) | 99.3% | 98.3% | 100.0% / 100.0% | 5,513 | 23,417 ms | 26,080 ms | 9,306 MB |

**Accuracy by question type**

| Type | b | c | c/snip | d | oracle |
|---|---|---|---|---|---|
| single-session-user | 90.0% (20) | 95.0% (20) | 85.0% (20) | 75.0% (20) | 90.0% (20) |
| single-session-assistant | 100.0% (17) | 100.0% (17) | 82.4% (17) | 100.0% (17) | 100.0% (17) |
| single-session-preference | 80.0% (10) | 70.0% (10) | 80.0% (10) | 50.0% (10) | 80.0% (10) |
| multi-session | 37.8% (37) | 48.6% (37) | 48.6% (37) | 29.7% (37) | 56.8% (37) |
| knowledge-update | 66.7% (21) | 81.0% (21) | 76.2% (21) | 38.1% (21) | 61.9% (21) |
| temporal-reasoning | 28.9% (38) | 42.1% (38) | 39.5% (38) | 34.2% (38) | 39.5% (38) |
| abstention | 62.5% (8) | 50.0% (8) | 75.0% (8) | 25.0% (8) | 62.5% (8) |

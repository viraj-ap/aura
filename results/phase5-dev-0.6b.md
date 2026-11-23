# Eval run dev-0.6b

- **run:** dev-0.6b
- **date:** 2026-11-13
- **questions:** 151 (LongMemEval_s **dev** split)
- **model:** Qwen3-0.6B-Q4_K_M
- **embedder:** bge-small-en-v1.5-q8_0
- **judge:** Qwen3-8B-Q4_K_M
- **prompt budget:** 8192 tokens ctx − 256 output reserve

| Config | N | Accuracy (95% CI) | All evidence sessions in prompt | Evidence turns in prompt | Recall any / all (ranked list) | Prompt tokens | TTFT (median) | Latency (median) | Peak server RSS |
|---|---|---|---|---|---|---|---|---|---|
| b | 151 | **29.8%** (23.1%–37.5%) | 86.0% | 73.6% | 95.8% / 91.6% | 1,953 | 839 ms | 1,250 ms | 7,121 MB |
| c | 151 | **35.1%** (27.9%–43.0%) | 88.1% | 78.2% | 97.9% / 94.0% | 2,288 | 873 ms | 1,281 ms | 6,980 MB |
| c/snip | 151 | **33.1%** (26.1%–41.0%) | 88.1% | 78.2% | 97.9% / 94.0% | 1,174 | 350 ms | 641 ms | 7,134 MB |
| d | 151 | **34.4%** (27.3%–42.3%) | 88.1% | 78.2% | 97.9% / 94.0% | 2,288 | 61 ms | 367 ms | 7,121 MB |
| oracle | 151 | **35.8%** (28.6%–43.7%) | 99.3% | 98.3% | 100.0% / 100.0% | 5,513 | 3,682 ms | 4,771 ms | 7,121 MB |

**Accuracy by question type**

| Type | b | c | c/snip | d | oracle |
|---|---|---|---|---|---|
| single-session-user | 35.0% (20) | 55.0% (20) | 55.0% (20) | 55.0% (20) | 55.0% (20) |
| single-session-assistant | 88.2% (17) | 88.2% (17) | 70.6% (17) | 88.2% (17) | 88.2% (17) |
| single-session-preference | 20.0% (10) | 30.0% (10) | 20.0% (10) | 30.0% (10) | 50.0% (10) |
| multi-session | 16.2% (37) | 18.9% (37) | 21.6% (37) | 18.9% (37) | 16.2% (37) |
| knowledge-update | 38.1% (21) | 23.8% (21) | 28.6% (21) | 19.0% (21) | 19.0% (21) |
| temporal-reasoning | 5.3% (38) | 13.2% (38) | 7.9% (38) | 13.2% (38) | 13.2% (38) |
| abstention | 62.5% (8) | 87.5% (8) | 100.0% (8) | 87.5% (8) | 100.0% (8) |

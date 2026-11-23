# Eval run wide-0.6b

- **run:** wide-0.6b
- **questions:** 500 (LongMemEval_s, stratified by type)
- **model:** Qwen3-0.6B-Q4_K_M
- **embedder:** bge-small-en-v1.5-q8_0
- **judge:** Qwen3-8B-Q4_K_M
- **prompt budget:** 7936 tokens

| Config | N | Accuracy (95% CI) | All evidence sessions in prompt | Evidence turns in prompt | Recall any / all (ranked list) | Prompt tokens | TTFT (median) | Latency (median) | Peak server RSS |
|---|---|---|---|---|---|---|---|---|---|
| b | 500 | **31.4%** (27.5%–35.6%) | 83.4% | 73.6% | 97.2% / 91.0% | 1,977 | 589 ms | 1,002 ms | 6,771 MB |
| c | 500 | **33.6%** (29.6%–37.9%) | 85.5% | 79.5% | 98.3% / 92.7% | 2,305 | 770 ms | 1,167 ms | 7,057 MB |
| c/snip | 500 | **32.6%** (28.6%–36.8%) | 85.5% | 79.5% | 98.3% / 92.7% | 1,165 | 364 ms | 651 ms | 7,057 MB |

**Accuracy by question type**

| Type | b | c | c/snip |
|---|---|---|---|
| single-session-user | 37.5% (64) | 51.6% (64) | 56.3% (64) |
| single-session-assistant | 75.0% (56) | 73.2% (56) | 57.1% (56) |
| single-session-preference | 30.0% (30) | 23.3% (30) | 23.3% (30) |
| multi-session | 10.7% (121) | 14.0% (121) | 14.0% (121) |
| knowledge-update | 34.7% (72) | 27.8% (72) | 30.6% (72) |
| temporal-reasoning | 16.5% (127) | 21.3% (127) | 22.0% (127) |
| abstention | 76.7% (30) | 76.7% (30) | 70.0% (30) |

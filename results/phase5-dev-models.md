# Model sizes on the dev split

Accuracy on the dev split (151 questions; (n) = still running)

| Model | b | c | c/snip | d | oracle |
|---|---|---|---|---|---|
| qwen3-1.7b | 43.0% | 40.4% | 45.7% | 37.1% | 45.7% |
| llama3.2-3b | 47.7% | 47.7% | 46.4% | 45.0% | 49.0% |
| qwen3-8b | 57.6% | 64.9% | 62.3% | 47.0% | 64.2% |

## qwen3-1.7b

- **model:** Qwen3-1.7B-Q4_K_M
- **judge:** Qwen3-8B-Q4_K_M
- **run:** dev-1.7b

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

## llama3.2-3b

- **model:** Llama-3.2-3B-Instruct-Q4_K_M
- **judge:** Qwen3-8B-Q4_K_M
- **run:** dev-llama3.2-3b

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

## qwen3-8b

- **model:** Qwen3-8B-Q4_K_M
- **judge:** Qwen3-8B-Q4_K_M
- **run:** dev-qwen3-8b

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

Note: Qwen3-8B is also the judge, so its scores may carry self-preference bias.

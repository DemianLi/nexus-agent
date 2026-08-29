# NVIDIA 端點的模型盤點

[#85](https://github.com/DemianLi/nexus-agent/issues/85) 的第一步。**這份結果有保鮮期** ——
可用的集合綁在帳號上，也綁在時間上（見底下「兩次的差異」）。

## 這一輪怎麼跑的

- **日期**：2026-08-29
- **key 的來源**：`.env` 的 `NVIDIA_API_KEY`（就是 Phase 0 接線用的那一把；`.env` 不進版控，帳號識別字也不抄進來）
- **端點**：`https://integrate.api.nvidia.com/v1`
- **方法**：`GET /models` 拿**全部** id，逐一送一個 `POST /chat/completions`，帶一個 `write_file`
  工具定義與一句要求呼叫它的話，`max_tokens: 512`、`temperature: 1`、90 秒逾時、循序、每個之間隔 300ms
- **判準**：回得出 `finish_reason: tool_calls` **而且**真的帶回至少一筆 `tool_calls` —— 不是 `GET /models` 列得到

**入場判準是一句話一個工具，它證不了完整基準任務跑得完。** 端點拒收平行呼叫、撞上單次執行的
迴圈或時鐘上限、被限流 —— 這三種都在探測的射程外，會在 `eval:survey` 那一輪才現形。

## 結果

`GET /models` 列 **83** 個。分類：

| 類別 | 個數 | 意思 |
| --- | --- | --- |
| 可用 | 16 | 回得出 `finish_reason: tool_calls` |
| 叫不動 | 55 | `404` —— **清單是型錄，不是權限** |
| 不支援工具 | 8 | `400`，端點明著說這個模型沒開工具呼叫 |
| 逾時 | 2 | 90 秒不回來，就是 [#57](https://github.com/DemianLi/nexus-agent/issues/57) 那個失敗模式 |
| 端點自己壞了 | 1 | `500 Internal error` |
| 叫得動但沒叫工具 | 1 | `200` 且 `finish_reason: stop` |

### 可用（16 個）

毫秒是那一次探測的往返時間。**它不是效能數據** —— 唯一的用途是：快的那幾個限流風險最高。

| model id | 短名 | 探測 |
| --- | --- | --- |
| `deepseek-ai/deepseek-v4-flash-0731` | `ds-flash` | 21397 ms |
| `deepseek-ai/deepseek-v4-pro-0813` | `ds-pro` | 6405 ms |
| `google/diffusiongemma-26b-a4b-it` | `diffgemma-26b` | 620 ms |
| `google/gemma-4-31b-it` | `gemma-4-31b` | 1404 ms |
| `meta/llama-3.2-11b-vision-instruct` | `llama-11b` | 916 ms |
| `meta/llama-3.2-90b-vision-instruct` | `llama-90b` | 11053 ms |
| `meta/muse-glimmer-30b` | `muse-30b` | 26143 ms |
| `minimaxai/minimax-m3` | `minimax-m3` | 1415 ms |
| `moonshotai/kimi-k3` | `kimi-k3` | 18849 ms |
| `nvidia/nemotron-3-nano-30b-a3b` | `nano` | 1949 ms |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` | `nano-omni` | 1250 ms |
| `nvidia/nemotron-3-super-120b-a12b` | `super` | 1104 ms |
| `nvidia/nemotron-3-ultra-550b-a55b` | `ultra` | 1767 ms |
| `openai/gpt-oss-120b` | `oss-120b` | 779 ms |
| `openai/gpt-oss-20b` | `oss-20b` | 516 ms |
| `poolside/laguna-xs-2.1` | `laguna-xs` | 6155 ms |

**全部 16 個的參數都寫對了**（`file_path` 與 `content` 都是字串），而且都只叫了一次。

### 不支援工具（8 個）

這一類跟「叫不動」分開列，因為端點給的理由不一樣 —— 它們**叫得動**，只是沒開工具呼叫。

| model id | 端點說什麼 |
| --- | --- |
| `meta/llama-guard-4-12b` | "auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set |
| `nvidia/llama-3.1-nemoguard-8b-content-safety` | {"error":"Tool use has not been enabled, because it is unsupported by nvidia/llama-3.1-nemoguard-8b- |
| `nvidia/llama-3.1-nemoguard-8b-topic-control` | {"error":"Tool use has not been enabled, because it is unsupported by nvidia/llama-3.1-nemoguard-8b- |
| `nvidia/llama-3.1-nemotron-safety-guard-8b-v3` | "auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set |
| `nvidia/nemotron-3.5-content-safety` | "auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set |
| `nvidia/nemotron-parse` | Content cannot be a plain string. The model does not support text input. Content cannot be a plain s |
| `nvidia/riva-translate-4b-instruct-v1.1` | "auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set |
| `nvidia/riva-translate-4b-instruct-v2` | "auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set |

### 逾時（2 個）

- `mistralai/mistral-nemotron` —— 90 秒不回來
- `nvidia/nemotron-3.5-lightning-30b-a3b` —— 90 秒不回來

### 端點自己壞了（1 個）

- `nvidia/ai-synthetic-video-detector` —— `500 Internal error while making inference request`

### 叫得動但沒叫工具（1 個）

- `nvidia/ising-calibration-1.5-31b` —— `200`，`finish_reason: stop`，一筆 `tool_calls` 都沒有

### 叫不動（55 個）

一律 `404`，訊息是 `Not found for account '<帳號識別字>'`（`bigcode/starcoder2-15b` 是純 `404 page not found`）。

<details>
<summary>展開清單</summary>

- `01-ai/yi-large`
- `adept/fuyu-8b`
- `ai21labs/jamba-1.5-large-instruct`
- `aisingapore/sea-lion-7b-instruct`
- `bigcode/starcoder2-15b`
- `databricks/dbrx-instruct`
- `deepseek-ai/deepseek-coder-6.7b-instruct`
- `google/codegemma-1.1-7b`
- `google/codegemma-7b`
- `google/deplot`
- `google/gemma-2b`
- `google/gemma-3-12b-it`
- `google/gemma-3-4b-it`
- `google/recurrentgemma-2b`
- `ibm/granite-3.0-3b-a800m-instruct`
- `ibm/granite-3.0-8b-instruct`
- `ibm/granite-34b-code-instruct`
- `ibm/granite-8b-code-instruct`
- `meta/codellama-70b`
- `meta/llama2-70b`
- `microsoft/kosmos-2`
- `microsoft/phi-3-vision-128k-instruct`
- `microsoft/phi-3.5-moe-instruct`
- `mistralai/codestral-22b-instruct-v0.1`
- `mistralai/mistral-7b-instruct-v0.3`
- `mistralai/mistral-large`
- `mistralai/mistral-large-2-instruct`
- `mistralai/mixtral-8x22b-v0.1`
- `moonshotai/kimi-k2.6`
- `nv-mistralai/mistral-nemo-12b-instruct`
- `nvidia/cosmos-reason2-8b`
- `nvidia/embed-qa-4`
- `nvidia/llama-3.1-nemotron-51b-instruct`
- `nvidia/llama-3.1-nemotron-70b-instruct`
- `nvidia/llama-3.1-nemotron-ultra-253b-v1`
- `nvidia/llama-3.2-nemoretriever-1b-vlm-embed-v1`
- `nvidia/llama-3.2-nv-embedqa-1b-v1`
- `nvidia/llama-nemotron-embed-vl-1b-v2`
- `nvidia/llama3-chatqa-1.5-70b`
- `nvidia/mistral-nemo-minitron-8b-8k-instruct`
- `nvidia/nemotron-3-embed-1b`
- `nvidia/nemotron-4-340b-instruct`
- `nvidia/nemotron-4-340b-reward`
- `nvidia/nemotron-nano-3-30b-a3b`
- `nvidia/neva-22b`
- `nvidia/nv-embedqa-mistral-7b-v2`
- `nvidia/nvclip`
- `nvidia/riva-translate-4b-instruct`
- `nvidia/vila`
- `snowflake/arctic-embed-l`
- `writer/palmyra-creative-122b`
- `writer/palmyra-fin-70b-32k`
- `writer/palmyra-med-70b`
- `writer/palmyra-med-70b-32k`
- `zyphra/zamba2-7b-instruct`

</details>

## 兩次的差異 —— 這是「集合會變」的直接證據

| | 2026-08-28 | 2026-08-29 |
| --- | --- | --- |
| `GET /models` 列出 | 84 | **83** |
| 叫得動（非 404） | 29 | **28** |
| 可用（回得出 `tool_calls`） | 14 | **16** |

**同一把 key，隔一天。** 成員也換了：

- **新出現在可用清單裡的**：`google/gemma-4-31b-it`、`google/diffusiongemma-26b-a4b-it`、
  `meta/muse-glimmer-30b`、`minimaxai/minimax-m3`、`moonshotai/kimi-k3`、`poolside/laguna-xs-2.1`、
  `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning`
- **從型錄上消失的**：`google/gemma-3-12b-it`、`google/gemma-3-4b-it` 之類前一天記過的候選

兩個推翻了記在案的結論，兩個都寫成「量到什麼」而不是「狀態變了」：

1. **`deepseek-ai/deepseek-v4-flash-0731` 這次 21.4 秒回得出 `tool_calls`。**
   [#57](https://github.com/DemianLi/nexus-agent/issues/57) 記的是「它不回應，所以換成同系列的 pro」，
   當時的結論是「端點沒修好，是我們換了 id」。現在它回應了 —— 但那個失敗模式本來就是斷續的，
   一次成功不會讓 #57 退休。
2. **`meta/llama-3.2-90b-vision-instruct` 這次 11.1 秒回得出 `tool_calls`。**
   `tiers.ts` 記的是「三次探測全部 90 秒逾時」，而那正是 `SCORER_CONTROL`
   「沒有同家族對照、所以它的分數不准讀成尺寸效應」的理由。這個理由現在鬆動了，
   但 `tiers.ts` **刻意不動** —— 探測跑得動不代表基準任務跑得完。

## 對 #85 的意思

**16 ≥ 10，門檻過了。** OpenRouter 那條退路不啟動。

清單落在 [`apps/harness/src/eval/survey.ts`](../apps/harness/src/eval/survey.ts)，
跑法是 `pnpm --filter @nexus/harness eval:survey`。

## 完整題目跑下來之後（2026-08-29，294 次執行）

**入場判準預測不了跑得完。** 16 個過關的候選，實際跑七題各三次之後：

| 層 | 幾個 | 誰 |
| --- | --- | --- |
| 資料近乎完整（19–21/21 評到分） | **8** | `oss-120b` `oss-20b` `nano` `super` `ultra` `gemma-4-31b` `laguna-xs` `muse-30b` |
| 資料部分缺（11–14/21） | 3 | `llama-90b` `llama-11b` `ds-pro` |
| 沒有可用資料（0–2/21） | 3 | `minimax-m3`(1) `kimi-k3`(2) `diffgemma-26b`(0) |
| 冒煙就排除（撞滿 300 秒上限） | 2 | `ds-flash` `nano-omni` |

所以「16 個可用」是**盤點**的數字，「8 個有完整資料」才是**報告**的數字。兩個都不是錯的，
它們量的不是同一件事 —— 一句話一個工具跟完整 plugin 組裝下的多輪對話，中間隔著單次執行的
迴圈與時鐘上限、端點拒收平行呼叫、限流、以及端點自己的 `500`。

**結論**：`openai/gpt-oss-120b` 是唯一一個三軸同時最好的（21/21、難題 `1.00`、token 最低、最快、
零 `throttled`）。完整數據表、失敗分類、兩組對不起來的限流數字，見
[#85 的報告](https://github.com/DemianLi/nexus-agent/issues/85#issuecomment-5459133975)。

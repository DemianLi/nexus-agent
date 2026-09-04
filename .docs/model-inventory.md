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
| 資料部分缺（11–14/21） | 3 | `llama-90b` `llama-11b` `ds-pro`（`ds-pro` 後來重跑到 21/21，見下一節） |
| 沒有可用資料（0–2/21） | 3 | `minimax-m3`(1) `kimi-k3`(2) `diffgemma-26b`(0) |
| 冒煙就排除（撞滿 300 秒上限） | 2 | `ds-flash` `nano-omni` |

所以「16 個可用」是**盤點**的數字，跑得完的才是**報告**的數字。兩個都不是錯的，
它們量的不是同一件事 —— 一句話一個工具跟完整 plugin 組裝下的多輪對話，中間隔著單次執行的
迴圈與時鐘上限、端點拒收平行呼叫、限流、以及端點自己的 `500`。

**「跑得完」要有一條寫得出來的判準，不能只看評到分幾次。** 上面這張表按次數分層，而
`llama-90b` 與 `llama-11b` 同為 14/21 卻不同命：前者 `grep-across-files` **0/3**，
後者缺的 7 次分散在七題裡、沒有哪一題掛零。**缺幾次跟缺在哪不是同一件事。**
[#85](https://github.com/DemianLi/nexus-agent/issues/85) 的驗收因此用這一條數：
**七題每一題都至少有 1 次評到分，四條難題全部有代表** —— 這樣數是 **10 個**
（上面的 8 個，加 `llama-11b`，加重跑後的 `ds-pro`）。

## `ds-pro` 拉開間隔重跑：11/21 → 21/21（2026-08-29）

`ds-pro` 在那一輪缺的 10 次是 `throttled`×8 ＋ `budget`×2，而 `throttled` 依定義是
**我們打太快**。單獨重跑、每次執行一個獨立 process、之間隔 60 秒，7 題 × 3 次跑了 31 分鐘：
**21/21 評到分、零失敗、七題與難題都是 `1.00`/`1.00`**、token 平均 8362、每次平均 28.8 秒。

**它推翻了兩件記在案的事**：

1. **那 2 次 `budget` 也是限流的產物** —— 退避把時鐘吃光才撞上 300 秒上限。同一個原因被
   記成了兩個類別，所以 `budget` 不能自動讀成「這個模型太慢」，要先看它旁邊有沒有 `throttled`。
2. **間隔動到的不只是限流，還有延遲** —— `echo-once` 從 40.9/209.1/76.9 秒變成 9.0/15.8/20.9 秒。
   同一個模型、同一套題、同一天。

**由此有一個沒量到的問題**：整輪那張表的延遲欄有多少是在量我們自己的節奏。只重跑了 `ds-pro`
一個，其餘 13 個沒有對照。那一欄現在的地位是「背靠背循序跑的條件下觀察到的耗時」，
**不是模型的延遲特性**。`oss-120b` 的 2.41 秒不受影響（它零 `throttled`，沒有退避混在裡面）。

**`ds-pro` 這一列不能跟其他 13 列並排讀延遲**：跑法不同。品質那三軸比得，評分只看單次執行
內部發生了什麼。

**結論**：`openai/gpt-oss-120b` 是唯一一個三軸同時最好的（21/21、難題 `1.00`、token 最低、最快、
零 `throttled`）。`ds-pro` 補齊之後是第二名 —— 品質同為 `1.00`/`1.00`，但 token 8362 對 5794，
而且它那個延遲是隔開跑出來的。**換掉預設沒有依據。** 完整數據表、失敗分類、兩組對不起來的
限流數字，見 [#85 的報告](https://github.com/DemianLi/nexus-agent/issues/85#issuecomment-5459133975)
與[驗收補完](https://github.com/DemianLi/nexus-agent/issues/85#issuecomment-5461840852)。

## `diffgemma-26b` 追下去的結果：不是那天端點壞了

整輪它 21 次全 `rejected 500`，當時只能寫成「像是端點那側的問題，沒有進一步驗證」。
2026-08-29 單獨重跑了一次，加上一組拆變數的探針：

**重跑 21 次**：`500`×18、`429`×2、`502`×1 —— **重現了**，所以不是那一輪碰巧遇上。

**但這個模型是活著的**：

- 裸 `createLiveModel().invoke()`（帶 benchmark 的 system prompt、不綁工具）**3/3 成功**
- 單發 REST 探針約 25 次，`200 finish=tool_calls` 正常回，0.3–1 秒

**四個變數各自排除**（每次只動一個）：

| 動的變數 | 結果 |
| --- | --- |
| 工具數 1 → 16 | 429 隨機出現，**跟數量無關**（1 個工具也 429，8 個工具也 200） |
| system prompt 加長 | `200 finish=tool_calls` |
| `max_tokens` 512 → 16384 | `200 finish=tool_calls` |
| `stream` true / false 交錯各 6 次 | **兩組一模一樣**（各 3 次 200、3 次 429） |

**順帶量到的**：這個模型有一個極低的請求速率上限 —— 每 4 秒一次的輕請求約**一半**被
**即時** 429（50–60 ms，不是退避後才失敗）。那跟整輪的 `500` 是兩回事，但它解釋了為什麼
連探針都不好跑。

**沒定位到**：完整 agent 迴圈下穩定 `500` 的原因。剩下最可能的是基座內建工具的 schema
（deepagents 的 `write_file` / `edit_file` / `task` 那批，比探針用的假工具複雜得多），
**沒測到** —— `loadPlugins` 拿不到基座工具，要挖進 deepagents 內部才拿得到。

**對清單的意思**：`diffgemma-26b` 過了入場判準，但在完整 agent 迴圈下**兩輪各 21 次、
0/42 評到分**。它列在「盤點時叫得動」裡是對的，但任何「可用模型」的計數都不該把它算進去。

## 第三輪盤點（2026-09-04）—— 可用掉到 9 個，門檻沒過

[#165](https://github.com/DemianLi/nexus-agent/issues/165) 撞到預設模型下架，照本檔
「這一輪怎麼跑的」那一節的同一套方法重跑：`GET /models` 拿全部 id，逐一送一個帶
`write_file` 工具定義的請求，`max_tokens: 512`、`temperature: 1`、90 秒逾時、循序、間隔 300ms。

| | 2026-08-28 | 2026-08-29 | **2026-09-04** |
| --- | --- | --- | --- |
| `GET /models` 列出 | 84 | 83 | **81** |
| 叫得動（非 404） | 29 | 28 | **26** |
| 可用（回得出 `tool_calls`） | 14 | 16 | **9** |

分類：可用 9、叫不動 55、不支援工具 8、逾時 4、端點自己壞了 3、叫得動但沒叫工具 2。

### 可用（9 個）

行內是探測往返時間；括號裡是 `max_tokens: 16384` 那道門檻的結果（見下一節）。

| id | 探測 | 16384 門檻 |
| --- | --- | --- |
| `google/diffusiongemma-26b-a4b-it` | 440ms | 過 |
| `google/gemma-4-31b-it` | 1299ms | 過 |
| `meta/llama-3.2-11b-vision-instruct` | 1256ms | 過（首次 500，補探 3/3） |
| `meta/muse-glimmer-30b` | 68688ms | 過 |
| `minimaxai/minimax-m3` | 23695ms | 過 |
| `nvidia/nemotron-3-super-120b-a12b` | 1683ms | 過 |
| `nvidia/nemotron-3.5-lightning-30b-a3b` | 5502ms | 過（首次逾時，補探 3/3） |
| `openai/gpt-oss-20b` | 2258ms | 過 |
| `poolside/laguna-xs-2.1` | 13295ms | **不穩**：1/3，其餘 503 容量不足 |

### 這一輪多加了一道門檻：`max_tokens: 16384`

[#166](https://github.com/DemianLi/nexus-agent/pull/166) 之後 `createLiveModel` **恆定送出**
`LIVE_MAX_OUTPUT_TOKENS = 16384`。所以「輸出上限比 16384 小」的模型**每一次呼叫都會失敗**，
而入場探測用的 512 看不出這件事。這道門檻是免費的（同一個請求換個數字），加進盤點裡。

### 一次探測會誤判，這一輪量到了

首輪的失敗態裡有兩個是瞬時的：`meta/llama-3.2-11b-vision-instruct`（500）與
`nvidia/nemotron-3.5-lightning-30b-a3b`（90 秒逾時）補探三次全過。反過來，
以下的失敗**重探之後仍然成立**，不是端點那一刻打嗝：

- **三次全逾時**：`deepseek-ai/deepseek-v4-flash-0731`、`deepseek-ai/deepseek-v4-pro-0813`、
  `meta/llama-3.2-90b-vision-instruct`、`moonshotai/kimi-k3` —— 四個都是 2026-08-29 的可用清單成員。
- **三次全 500**：`nvidia/nemotron-3-ultra-550b-a55b`、`nvidia/ai-synthetic-video-detector`。
- **三次都不叫工具**：`nvidia/ising-calibration-1.5-31b`。
- **1/3**：`nvidia/nemotron-3-nano-omni-30b-a3b-reasoning`（其餘 503 `Worker local total request limit`）。

**所以「可用」這一格本身要帶重複次數。** 前兩輪各只探一次，那兩份數字裡混著這一類瞬時失敗。

### 型錄上消失的兩個，各自打掉一道階梯

- **`openai/gpt-oss-120b`**：不在型錄裡了，而且**打它不是 404 是 410** ——
  `The model 'openai/gpt-oss-120b' has reached its end of life on 2026-09-03T08:00:00Z`。
  端點把「下架」跟「這把 key 叫不動」分成兩個碼。
- **`nvidia/nemotron-3-nano-30b-a3b`**：也不在型錄裡了（型錄上有個 `nvidia/nemotron-nano-3-30b-a3b`，
  名字順序不同，而且 404）。

兩個都是 `tiers.ts` 的階梯成員，所以 `GPT_OSS_LADDER` 只剩一階、`NEMOTRON_3_LADDER` 的底板沒了
（剩下的 `ultra` 還三次全 500）。**兩道階梯現在都不成立**，見
[#167](https://github.com/DemianLi/nexus-agent/issues/167)。

### 對 #85 的意思：**9 < 10，門檻沒過**

#85 寫的退路是「停下來，回報盤點的數字，然後提醒 demian」，他的決定是加上 OpenRouter
平台的免費模型把數字補齊。**這一輪沒有自己去接** —— 數字回報在這裡，決定權在 demian。

而且 9 這個數字還是寬鬆的算法：扣掉 `poolside/laguna-xs-2.1`（16384 門檻 1/3）就只剩 8，
再扣掉 2026-08-29 那一輪量到 0–2/21 的 `diffgemma-26b` 與 `minimax-m3` 就剩 6。

[`survey.ts`](../apps/harness/src/eval/survey.ts) 的 `SURVEY_MODELS` **刻意沒有在 #165 裡改** ——
改它就是在替 demian 做那個決定。它今天記的是 2026-08-29 的集合，其中四個已經三次全逾時。

## 決選（2026-09-04，84 次執行）

盤點之後照 #165 挑出四個候選跑完整基準任務：七題 × 3 次取樣，循序，走
`compareTiers` 與 `summarize`（跟 `eval:survey` 同一套，只是候選清單是臨時的 ——
`SURVEY_MODELS` 刻意沒動，理由見上一節）。

**沒有進決選的五個，理由逐一記著**：`meta/muse-glimmer-30b` 探測 13–68 秒（延遲那一軸出局）、
`minimaxai/minimax-m3` 與 `google/diffusiongemma-26b-a4b-it` 在 2026-08-29 那一輪是 1/21 與 0/21、
`meta/llama-3.2-11b-vision-instruct` 是判準對照（刻意的弱者）、`poolside/laguna-xs-2.1`
16384 門檻 1/3。

| | 難題 arg | 七題 arg | 多叫 | token | 秒 | 評到分 |
| --- | --- | --- | --- | --- | --- | --- |
| `google/gemma-4-31b-it` | 0.93 n=9 | 0.97 n=18 | 0.57 | 7639 | 17.5 | 21/21 |
| `nvidia/nemotron-3.5-lightning-30b-a3b` | 0.93 n=9 | 0.97 n=18 | 1.33 | 13530 | 38.4 | 21/21 |
| **`nvidia/nemotron-3-super-120b-a12b`** | **0.98** n=9 | **0.99** n=18 | **0.29** | 10661 | **8.0** | 21/21 |
| `openai/gpt-oss-20b` | 0.92 n=8 | 0.96 n=17 | 0.45 | **7076** | 17.1 | 20/21（1 budget）|

**84 次執行裡零 `throttled`、零 `rejected`**，所以這批數字沒有 #85 第 4 條那道牆的干擾。

**跟 2026-08-28 那次的差別：品質這次沒有打平。** 上一次五階擠在 0.88–0.98，選型因此落回
成本、延遲、失敗模式；這一次難題上是 0.98 對 0.92–0.93，而同一個候選順帶拿下延遲與多叫次數。
四軸拿三軸、而且贏的三軸裡有品質，所以不必在軸之間權衡 —— 唯一輸的 token 多五成。

`LIVE_MODEL_ID` 因此換成 `nvidia/nemotron-3-super-120b-a12b`。

## 上下文窗口：逐顆量，差五倍以上（2026-09-04）

**這是第一次真的量到窗口。** 兩種做法，因為兩顆模型的失敗形態不同：

| 模型 | 窗口 | 怎麼量的 |
| --- | --- | --- |
| `openai/gpt-oss-20b` | **131,007** | 反解導出來的負 `max_tokens`：20 萬字 → `got -68993`，`131007 = 200000 − 68993` |
| `nvidia/nemotron-3-super-120b-a12b` | **≥ 700,045** | 逼不出 400。改用暗號：把一個唯一字串放在提示詞最前面、塞 140 萬個字、要求唸回來 —— 唸對了，`usage.prompt_tokens` 線性到 700,045 |

**暗號那一步是必要的，不是講究。** 只看「有沒有回錯」分不出「窗口夠大」與「靜默截斷」——
兩者都回 `200`。唸得回最前面那個暗號才排除得掉截斷。

**直接後果兩條**：

1. `DEFAULT_SUMMARIZATION` 的 `tokens: 100_000` 檔頭裡那句「未經實測」可以改了，但值不動 ——
   量過最小的那一顆是 131,007，扣掉恆定送出的 `LIVE_MAX_OUTPUT_TOKENS = 16384`，輸入上限
   114,623，`100_000` 離它只剩 14,623 的餘裕。**那是量過的最緊一格，不是通則。**
2. 新的預設模型身上**逼不出上下文溢出**，所以 [#166](https://github.com/DemianLi/nexus-agent/pull/166)
   的 `isDerivedContextOverflow` 對預設路徑是備而不用的。它仍然要留著 —— eval 會把
   `gpt-oss-20b` 逐一傳進 `createLiveModel`，而那一顆 131,007 就滿了。

## 下架這件事本身會說話了（2026-09-04）

`openai/gpt-oss-120b` 的 410 實測**花了 106.7 秒才浮出來** —— `410` 不在
`@langchain/core` 那份 `STATUS_NO_RETRY` 裡，所以它被重試滿 6 次。#165 讓它第一次就放棄，
並把端點那句帶日期的 `detail` 原封不動搬進失敗訊息。**判準是狀態碼，不是那句話的措辭。**

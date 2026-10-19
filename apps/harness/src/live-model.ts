import { ContextOverflowError } from '@langchain/core/errors';
import { parseRetryAfterMs } from '@langchain/core/utils/async_caller';
import { MiddlewareError } from 'langchain';
import { ChatOpenAI } from '@langchain/openai';
import type { ChatOpenAIFields } from '@langchain/openai';
import {
  assertImageBudget,
  beginAttemptReport,
  DEFAULT_STREAM_RETRYABLE_CODES,
  isModelCallFailure,
  markModelCallFailure,
  noteStreamFailure,
  streamFailureReporter,
  tagModelRoute,
} from '@nexus/core';
import type { AttemptUsage, LlmFailure, StreamFailure } from '@nexus/core';

import { assertUsableApiKey, INVALID_CREDENTIAL_CODE } from './api-key.js';
import { AttachmentChatOpenAI } from './attachment-chat-openai.js';
import { GatedChatOpenAI } from './gated-chat-openai.js';
import { LOCAL_CAPACITY_CODE } from './request-gate.js';
import type { RequestGate } from './request-gate.js';
import type { RequestGuard } from './attachment-chat-openai.js';
import { projectAttachments } from './attachment-projection.js';
import type { AttachmentSource } from './attachment-projection.js';
import { resolveHarnessHome } from './harness-home.js';
import { ambientCredentials, createCredentialService, describeKeySource } from './credentials.js';
import type { CredentialService } from './credentials.js';
import { legacyEnvMovedError, loadLaunchEnv } from './launch-env.js';
import type { LaunchEnvironment } from './launch-env.js';
import { acceptsImages, requireModelEntry, thinkingOffBody } from './model-catalog.js';
import type { ModelEntry } from './model-catalog.js';
import type { LiveModelConfig } from './settings/live-model.js';

/**
 * Phase 0 的真實供應商接線（issue #31）。
 *
 * 走 NVIDIA 的 OpenAI 相容端點：JS 這邊沒有 NVIDIA 專用的 LangChain 整合
 * （`@langchain/nvidia-ai-endpoints` 只有 Python 版），所以用 `@langchain/openai`
 * 指過去。這裡驗的是接線 —— tool call 的參數回得來、streaming 的事件形狀對得上 ——
 * 不是模型品質；供應商比較在 Phase 2 與 Phase 5（見開發計劃第 7 節決策點 2）。
 *
 * ## 這個檔裡的 `DEFAULT_LIVE_*` 都只是**預設值**
 *
 * 連線值與模型型錄由清單上 `live-model` 那一列講（[#545](https://github.com/DemianLi/nexus-agent/issues/545)，
 * `settings/live-model.ts`），這裡的常數是那一列的 schema 預設。**測量與理由留在各常數的檔頭**——
 * 部署要改其中一個之前，該讀的就是那一段。
 */
export const DEFAULT_LIVE_BASE_URL = 'https://integrate.api.nvidia.com/v1';

/**
 * NVIDIA 閘道上的預設模型 id。
 *
 * ## 這是量出來的，不是挑出來的
 *
 * **2026-09-04 重選**（[#165](https://github.com/DemianLi/nexus-agent/issues/165)）。
 * 上一個 `openai/gpt-oss-120b` **下架了** —— 410、`end of life on 2026-09-03T08:00:00Z`，
 * 型錄上也沒有它了。所以它不是被比下去的，是**不能再打了**；重選是被迫的。
 *
 * 重選照原本的方法走兩步。**第一步是盤點**（方法在 [`eval/tiers.ts`](./eval/tiers.ts) 檔頭）：
 * `GET /models` 列 **81** 個，逐一送一個帶 `tools` 的請求，回得出 `finish_reason: tool_calls`
 * 的只有 **9** 個（前一輪是 16 個，四個舊成員現在三次探測全逾時）。這一輪多加一道**免費的
 * 硬門檻**：吃不吃得下 {@link DEFAULT_LIVE_MAX_OUTPUT_TOKENS} —— 我們每一次呼叫都送它，輸出上限比它
 * 小的模型會**每一次**都失敗，而入場探測用的 512 看不出這件事。
 *
 * **第二步是決選四個跑基準任務**（七題 × 3 次 = 84 次執行，零限流、零 `rejected`）：
 *
 * | | 難題 arg | 七題 arg | 多叫 | token | 秒 | 評到分 |
 * | --- | --- | --- | --- | --- | --- | --- |
 * | `google/gemma-4-31b-it` | 0.93 | 0.97 | 0.57 | 7639 | 17.5 | 21/21 |
 * | `nvidia/nemotron-3.5-lightning-30b-a3b` | 0.93 | 0.97 | 1.33 | 13530 | 38.4 | 21/21 |
 * | **這一個** | **0.98** | **0.99** | **0.29** | 10661 | **8.0** | 21/21 |
 * | `openai/gpt-oss-20b` | 0.92 | 0.96 | 0.45 | **7076** | 17.1 | 20/21 |
 *
 * **跟 2026-08-28 那次不同：品質這次沒有打平。** 上一次五階的參數正確性擠在 0.88–0.98，
 * 選型因此落回成本、延遲、失敗模式；這一次難題上是 **0.98 對 0.92–0.93**，而同一個候選**順帶**
 * 拿下延遲（8.0 秒，快一倍）與多叫次數（0.29）。**它唯一輸的是 token**：10661 比最省的
 * `gpt-oss-20b` 多五成。四軸拿三軸，而且贏的那三軸包含品質——所以這次不必在軸之間權衡。
 *
 * ## 窗口是量到的，而且大得離譜
 *
 * **≥ 700,045 token**（2026-09-04）。判準不是「沒回錯」——那分不出截斷：把一個唯一暗號放在
 * 提示詞**最前面**、再塞 140 萬個字、最後要求它唸回來，它唸對了，`usage.prompt_tokens` 也
 * 一路線性到 700,045。所以**不是截斷，是真的讀到了**。
 *
 * 對照組 `openai/gpt-oss-20b` 在同一天量到的是 **131,007**（128K 扣掉約 65 個 template
 * overhead），做法是反解那個導出來的負 `max_tokens`（見 {@link isDerivedContextOverflow}）。
 * 同一個端點上兩顆模型差五倍以上——**窗口不能從端點推得，只能逐顆量**。
 *
 * **直接後果**：這一顆身上**逼不出上下文溢出**。`DEFAULT_SUMMARIZATION` 的 `tokens: 100_000`
 * 在 700k 的窗口上是 1/7，摘要會遠遠早於任何溢出發生。{@link isDerivedContextOverflow} 因此
 * 對**預設路徑**是備而不用的——它仍然要留著，因為 eval 會把 `gpt-oss-20b` 那一階逐一傳進
 * {@link createLiveModel}，而那一顆 131,007 就滿了。
 *
 * ## 邊界
 *
 * 它是「這把 key 上量得到的最划算的那個」，不是「這是最好的模型」。**候選集合綁在帳號上，
 * 也綁在時間上**：81 / 26 / 9 這三個數字在六天內從 84 / 29 / 14 走到這裡，成員也換過。
 *
 * **而 9 沒有過 [#85](https://github.com/DemianLi/nexus-agent/issues/85) 的十個門檻。**
 * 那張卡寫的退路是「停下來、回報數字、提醒 demian」，決定權在他 —— #165 因此**沒有**動
 * `survey.ts` 的候選清單，也沒有自己去接第二個端點。完整盤點見
 * [`.docs/model-inventory.md`](../../../.docs/model-inventory.md)。
 *
 * 這是**預設**的 id：`cli:live` / `serve:live` 走 `live-model` 那一列（出貨值與它相同），
 * `spike:live` 直接吃 schema 預設，eval 的尺寸比較則把各道階梯的 id 逐一傳進 {@link createLiveModel}。
 *
 * **換它之前**：這顆是拿「吃不吃得下 {@link DEFAULT_LIVE_MAX_OUTPUT_TOKENS}」當淘汰門檻選出來的，
 * 兩個是綁著的（`settings/live-model.ts` 的檔頭）。
 */
export const DEFAULT_LIVE_MODEL_ID = 'nvidia/nemotron-3-super-120b-a12b';

/** 環境變數名。刻意不叫 `OPENAI_API_KEY`（`@langchain/openai` 的預設），免得這把 key 是誰的變模糊。 */
export const LIVE_API_KEY_ENV = 'NVIDIA_API_KEY';

/**
 * 「連線到第一則事件」的逾時上限（SDK 的 `timeout`）。
 *
 * **這不是調校，是止血。** 這個端點的失敗模式是**永遠不回來**（[#57](https://github.com/DemianLi/nexus-agent/issues/57)），
 * 而尺寸比較是一連串請求 —— 沒有上限的話，中間掛住一次換來的是整輪比較沒有結果，
 * 而不是「那一格失敗」。
 *
 * **為什麼是 180 秒，不是原本的 90 秒**（[#1251](https://github.com/DemianLi/nexus-agent/issues/1251)）：
 * 原本一個旋鈕同時管「到第一則事件」與「段與段之間」，90 秒是照後者量的（最慢的成功回應 43 秒，掛住的兩個在
 * 90 秒仍是零位元組）。但視覺模型吐第一則事件前會先吃圖：`meta/llama-3.2-90b-vision-instruct` 實測首事件
 * 133 秒，被 90 秒砍掉。兩段的性質不同——首事件前的等待含排隊與預處理（吃圖），本來就長；吐字之後的停頓才是
 * 「掛住」的訊號——所以拆開，各自有各自的值。
 *
 * **範圍**：連線到第一則事件，由 SDK 的計時器管；逾時算 `TIMEOUT`，由 `@nexus/core` 的 `stream-retry.ts` 整次重打
 * （[#1427](https://github.com/DemianLi/nexus-agent/issues/1427)，政策在 `settings/live-model.ts` 的 `retryPolicy`）。
 * 第一則事件**之後**每一段的閒置歸 {@link DEFAULT_LIVE_STREAM_IDLE_TIMEOUT_MS} 與 {@link withStreamIdleTimeout}，
 * 逾時同樣整次重打（[#520](https://github.com/DemianLi/nexus-agent/issues/520)），兩段共用同一份預算。
 *
 * **最壞情況是它乘上重試次數**：開了線卻不吐位元組，每一次都等滿，180 秒 × (6 + 1) = 1260 秒，再加上
 * 退避的約 25.5 秒（`settings/live-model.ts` 的偏離二）。**這是 dsh 的形狀，不是缺陷**：dsh 的
 * `TIMEOUT` 在預設可重試碼裡（`llm/src/retry-policy.ts:18`），5 次重試 × 300 秒閒置 ≈ 30 分鐘。
 * #521 查過之後照 dsh 保留逾時重試——一次偶發的慢本來就該重試。
 */
export const DEFAULT_LIVE_TIMEOUT_MS = 180_000;

/**
 * 串流的閒置逾時：第一則事件之後，兩段位元組之間最多等多久（毫秒）。
 *
 * 值沿用原本單一旋鈕的 90 秒（demian 拍板，#521），所以沒碰過 `timeoutMs` 的設定在這一側行為不變。
 * dsh 的 `streamIdleTimeoutMs` 預設是 300 秒（`packages/llm/llm-pi-ai/src/config.ts:47`，`5badb15`）；
 * 我們維持 90 秒是因為這個端點掛住的樣子就是吐了內容之後不再有位元組，而每一次重打都重付整個回覆的費用，
 * 等 300 秒才發現太貴。要放寬改 `streamIdleTimeoutMs`，與 `timeoutMs` 互不牽動。
 */
export const DEFAULT_LIVE_STREAM_IDLE_TIMEOUT_MS = 90_000;

/**
 * 端點限流（HTTP 429）的判定。
 *
 * **照 dsh 的規矩認碼，不解析訊息** —— dsh 的 `HarnessError.code` 註解寫得很直白：
 * 「route on this, never by parsing `message`」。這裡的碼有兩個來源：協定上的
 * `status === 429`，以及 `@langchain/core` 正規化後掛上的 `name`。兩個都認，因為
 * 包裝層數是別人家的實作細節。
 *
 * **`insufficient_quota` 不算。** dsh 把 `QUOTA`（配額耗盡）與 `RATE_LIMIT`（限流）
 * 分成兩個碼，而且只有後者在預設可重試集裡 —— 理由一樣：配額耗盡重試幾次都一樣，
 * 限流等一下就過。`@langchain/core` 也同樣把它歸成 `action: 'stop'`。
 */
export function isRetryableRateLimit(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 10; depth += 1) {
    if (typeof current !== 'object' || current === null || seen.has(current)) return false;
    seen.add(current);

    // 配額耗盡：重試無效，而且它跟限流共用 429。先看它，否則會被下面認成可重試。
    const code = (current as { code?: unknown }).code;
    if (code === 'insufficient_quota') return false;
    const name = (current as { name?: unknown }).name;
    if (name === 'RateLimitQuotaExhaustedError' || name === 'InsufficientQuotaError') return false;

    if ((current as { status?: unknown }).status === 429) return true;
    if (name === 'RateLimitCapacityError') return true;

    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * 我們送出去的輸出上限。
 *
 * **它是正數，而那是 {@link isDerivedContextOverflow} 唯一的前提。** 抽成常數不是為了
 * 好改，是為了讓那個前提在型別旁邊看得見：改成會產生負值或零的東西，那個判別式當場失效。
 * 可以設定之後（#545），守住這個前提的是 `live-model` 那一列 schema 的下限 1。
 */
export const DEFAULT_LIVE_MAX_OUTPUT_TOKENS = 16_384;

/**
 * 預設那顆模型在型錄裡的那一筆（[#729](https://github.com/DemianLi/nexus-agent/issues/729)）：出廠型錄只放這一筆，對應 dsh
 * 出廠預設模型那一筆。要加一筆先過入場量測：吃得下 {@link DEFAULT_LIVE_MAX_OUTPUT_TOKENS}，窗口不小於量過最小那顆的
 * 131,007。
 *
 * - `contextWindow`：見 {@link DEFAULT_LIVE_MODEL_ID} 的「窗口是量到的」，記的是量過的**下限**。
 * - `maxTokens`：{@link DEFAULT_LIVE_MAX_OUTPUT_TOKENS}，這顆每一次請求送出去的 `max_tokens`。
 * - `input`：只有文字。這顆收不收圖沒有量過，先不宣告收圖（#731 量 gemma 那一筆時一起看）。
 * - `reasoningEfforts` 與 `compat`：關推理的寫法，從原本的 `thinkingOffBody` 搬進來（#650）。**只宣告 `off` 與 `default`
 *   兩級**：這顆開著推理時有沒有分級沒在實際端點量過，`default` 是「不送任何東西、用模型自己的預設」，沒有線上的寫法要送。
 *   `enable_thinking` 那一格寫成 `thinking.enabled` 的佔位符，`off` 那一級把它解成 `false`。寫法照
 *   {@link DEFAULT_LIVE_MODEL_ID} 在 build.nvidia.com 的 model card（「Reasoning OFF」那段）。
 *
 * ## 關推理的寫法是量出來的
 *
 * 2026-09-26，預設模型、NVIDIA 閘道、非串流，送 dsh 逐字的標題請求（`maxOutputTokens: 64`），三句輸入各兩次：
 *
 * - **不帶**：0/6。全部 `finish_reason: length`、64 個 token 用滿，推理 157～293 字，而且整段也出現在正文裡。
 * - **帶這一份**：6/6。全部 `stop`、推理 0、輸出 2～23 個 token。
 * - model card 另一個寫法 `low_effort: true`：3/5，有兩次照樣吃光。
 *
 * ## 它跟這一筆的 id 是綁著的
 *
 * 關推理的寫法是各家模型自己的（chat template 的參數），不是 OpenAI 協定的一部分。**換模型時要一起換**：新模型
 * 不認得這一格的話，可能回 400，也可能照樣推理；兩種都讓標題一律失敗，而退回標題會把失敗蓋住。所以它住在型錄的
 * 條目裡，跟 id 同一筆。
 *
 * ## 只有標題這種用途會帶
 *
 * 主請求不帶 `chat_template_kwargs`（預設就是開著）；pi-ai 在非 `off` 的等級底下會明著送 `enable_thinking: true`，
 * 我們不送，**沒有量過兩者等價**——見 `model-catalog.ts` 檔頭。
 */
export const DEFAULT_LIVE_MODEL_ENTRY: ModelEntry = Object.freeze({
  id: DEFAULT_LIVE_MODEL_ID,
  contextWindow: 700_045,
  maxTokens: DEFAULT_LIVE_MAX_OUTPUT_TOKENS,
  input: Object.freeze(['text' as const]) as ModelEntry['input'],
  reasoningEfforts: Object.freeze({ off: null, default: 'default' }),
  tokenizer: Object.freeze({ digits: 'single' as const }),
  compat: Object.freeze({
    chatTemplateKwargs: Object.freeze({
      enable_thinking: Object.freeze({ $var: 'thinking.enabled' as const }),
    }),
  }),
});

/** `(parameter=max_tokens, value=-46771)`／`got -46771` 裡那個數字。 */
const DERIVED_VALUE = /\(parameter=max_tokens,\s*value=(-?\d+)\)|got\s+(-?\d+)/;

/**
 * 這個 400 其實是**上下文溢出**嗎。
 *
 * ## 為什麼需要它：那條鏈在我們身上是斷的
 *
 * 基座的緊急摘要恢復認的是型別化的 `ContextOverflowError`，而那顆是
 * `@langchain/openai` 的 `wrapOpenAIClientError` 在 adapter 層建出來的——條件是訊息命中
 * 四個字串之一（`context_length_exceeded`／`Input tokens exceed the configured limit`／
 * `exceeds the context window`／`maximum context length`）。
 *
 * **這個端點一個都不中，實測過**（2026-09-04，三種輸入尺寸，`openai/gpt-oss-20b`）：
 *
 * ```json
 * {"error":{"message":"max_tokens must be at least 1, got -46771. (parameter=max_tokens, value=-46771)",
 *           "type":"BadRequestError","param":"max_tokens","code":400}}
 * ```
 *
 * 它**根本不是一句「上下文太長」**，是一句「導出來的參數不合法」——伺服器自己用
 * `上限 − 輸入` 去導 `max_tokens`，導成負的就報這個。送不送 `max_tokens` 都一樣
 * （2026-09-04 複驗：送 `max_tokens: 16384` 打 20 萬字，照樣回 `got -68993`）。
 * 所以恢復路徑今天一次都不會觸發，而且是靜默的。
 *
 * ## 它對**預設模型**是備而不用的，而那不是拔掉它的理由
 *
 * 2026-09-04 換掉預設之後（見 {@link DEFAULT_LIVE_MODEL_ID}），這條路在預設模型上**逼不出來** ——
 * `nvidia/nemotron-3-super-120b-a12b` 吃到 700,045 token 都還是 `200`。留著是因為它守的不是
 * 預設那一條路：eval 把 `openai/gpt-oss-20b` 逐一傳進 {@link createLiveModel}，而那一顆
 * **131,007 就滿了**，滿了就是這個 body。**換一顆預設就換一個窗口**，而這個判別式跟預設是誰無關。
 *
 * **現況（#1437 M2，2026-10-14）：預設模型超過窗口時，端點回的是另一種 body，不是這一種。** 對
 * `nvidia/nemotron-3-super-120b-a12b` 送約 157 萬 token 的請求，端點回 `400`，信封是
 * `This model's maximum context length is 1000000 tokens. However, your messages resulted in 1579695 tokens…`，
 * 沒有 `param`、也沒有導出的負 `max_tokens`——所以**這個判別式對它一個都不中**；它命中的是
 * `@langchain/openai` 自己的四個溢出字串之一（`maximum context length`），被包成 `ContextOverflowError`，
 * 分類成 `CONTEXT_WINDOW_EXCEEDED`（`turn-failed` 的碼，狀態 `400`）。上面「逼不出來」的 700,045 token 是更早的
 * 量測，端點的上限實際是 100 萬。只補這一段現況，判別式不動。
 *
 * ## 偏離登記一：分類該歸 adapter，我們退到最靠近它的地方
 *
 * dsh 寫得很清楚：「溢出分类由适配器维护——提供方措辞可能改变」
 * （`compaction-basic/README.zh.md:241`），消費端只認規範碼；LangChain 與 LiteLLM 同形。
 * **我們動不了 `@langchain/openai` 那支**，所以退到手上最靠近 adapter 的一格：建 client
 * 的這個工廠。**不碰恢復那一層**——那一層基座已經有而且是對的（`context-overflow.test.ts`
 * 量過：branded 的錯誤到得了 `isContextOverflow`，埋在 `cause` 底下也認得）。
 *
 * ## 偏離登記二：這裡**解析了訊息**，而這個檔的規矩是不解析
 *
 * {@link isRetryableRateLimit} 的檔頭寫著「照 dsh 的規矩認碼，不解析訊息」。這裡破了例，
 * 理由是**結構化欄位不夠分**：body 只給得出 `param: "max_tokens"`，那個導出來的數字**只
 * 存在於訊息裡**。而少了它，一顆「輸出上限比我們送的 16384 小」的模型會被誤判成上下文
 * 溢出——那是一次壓縮救不回來的東西，壓幾次都一樣。
 *
 * 所以規則是：**結構化欄位當主判準（`param`），訊息只用來取那一個數字**，而且要求它
 * 為負。正的數字代表伺服器在抱怨我們送的值，那不是溢出。
 *
 * ## 為什麼「負數」就足以斷定
 *
 * 實測：短提示詞 ＋ `max_tokens: -46771`（一個真正的 client bug）回的 body 與真的溢出
 * **逐位元組相同**——單看 body 是**不可分辨**的。分得開的是請求那一側：
 * {@link createLiveModel} 建的 client **恆定送一個正數的 `maxOutputTokens`**（預設
 * {@link DEFAULT_LIVE_MAX_OUTPUT_TOKENS}，可設定之後由 schema 的下限 1 保證仍是正數），
 * 所以從這個 client 收到的負值只可能是伺服器自己算出來的。
 *
 * **前提由工廠保證，判別式就掛在工廠上**——這也是它不放進 `@nexus/core` 的理由：那裡沒有
 * 那個前提。
 *
 * @param error - 供應商拋出來的東西，可能已經被包過好幾層。
 * @returns 是不是一個「伺服器導出負 `max_tokens`」的溢出。
 */
export function isDerivedContextOverflow(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 10; depth += 1) {
    if (typeof current !== 'object' || current === null || seen.has(current)) return false;
    seen.add(current);

    // `param` 有兩個落點：OpenAI SDK 的 APIError 把它攤在頂層，原始 body 則包在 `error` 裡。
    const body = (current as { error?: unknown }).error;
    const param =
      (current as { param?: unknown }).param ??
      (typeof body === 'object' && body !== null ? (body as { param?: unknown }).param : undefined);
    if (param === 'max_tokens') {
      const message =
        (current as { message?: unknown }).message ??
        (typeof body === 'object' && body !== null
          ? (body as { message?: unknown }).message
          : undefined);
      const matched = typeof message === 'string' ? DERIVED_VALUE.exec(message) : null;
      const raw = matched?.[1] ?? matched?.[2];
      // 取不到數字時**不猜**：寧可漏判（維持今天的行為），不要把別的 400 誤判成溢出。
      if (raw !== undefined && Number(raw) < 0) return true;
    }

    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * 這個錯誤是不是「我們自己要中止的」：不是供應商的失敗，不回報、不重試。
 *
 * 認名字與碼，不解析訊息內容的語意：`AbortError`、`Cancel…`／`AbortError…` 開頭的訊息（axios／langchain 的取消訊息）、
 * `ECONNABORTED`。這是基座 `defaultFailedAttemptHandler` 的同一批判準，原本寫在已退役的 `retryDecision` 裡；**重試與否改由
 * 碼決定之後（#1437），它是唯一不是「看狀態」的一條規則**，所以獨立出來。
 */
function isAbortLike(error: unknown): boolean {
  if (error instanceof Error) {
    if (error.name === 'AbortError') return true;
    if (error.message.startsWith('Cancel') || error.message.startsWith('AbortError')) return true;
  }
  if (typeof error === 'object' && error !== null) {
    if ((error as { code?: unknown }).code === 'ECONNABORTED') return true;
  }
  return false;
}

/**
 * 「讀串流時連線斷了」的錯誤物件記號（#1437）。
 *
 * undici 在串流中段被切斷時拋 `TypeError: terminated`，沒有狀態、名字也不是 `APIConnectionError`——今天的
 * `classifyTurnFailure` 只能把它記成 `UNKNOWN`，而同一顆錯在 `llm/retry` 上記的是 `TRANSPORT`。{@link withStreamIdleTimeout}
 * 在 `reader.read()` 失敗（非逾時、非中止）時把它標在這裡，分類器認這個記號：**同一顆錯誤物件，兩邊同一個碼**。
 *
 * 用 `WeakSet` 而不是往錯誤上塞欄位：那顆錯是 undici 的、可能被凍結，也不該被我們的記號改變它的形狀。
 */
const connectionFailures = new WeakSet<object>();

/**
 * HTTP 狀態 → 失敗碼。**整個專案唯一的一張表**（#1437）：分類器、第一則事件的錯誤信封、第一則事件之後的信封監看用同一張，
 * 所以同一個狀態不論從哪條路進來都是同一個碼。表的順序與詞彙照 dsh 的 `providerError`
 * （`packages/llm/llm-deepseek/src/transport.ts:22-35`）：
 *
 * | 狀態 | 碼 |
 * | --- | --- |
 * | 401、403 | `AUTH` |
 * | 402 | `QUOTA` |
 * | 429 | `RATE_LIMIT` |
 * | 400、413 | `INVALID_REQUEST` |
 * | ≥ 500 | `SERVER` |
 * | 其餘（404、408、410、418、422、425…） | `HTTP_<狀態>` |
 *
 * **不在這張表裡的規則**：`insufficient_quota` 與配額的名字（429 也可能是 `QUOTA`）、上下文溢出（400 也可能是
 * `CONTEXT_WINDOW_EXCEEDED`）——它們要看狀態以外的東西，由 {@link classifyTurnFailure} 排在這張表前面。
 *
 * @param status - HTTP 狀態。
 * @returns 失敗碼。
 */
function failureCodeOfStatus(status: number): string {
  if (status === 401 || status === 403) return 'AUTH';
  if (status === 402) return 'QUOTA';
  if (status === 429) return 'RATE_LIMIT';
  if (status === 400 || status === 413) return 'INVALID_REQUEST';
  if (status >= 500) return 'SERVER';
  return `HTTP_${String(status)}`;
}

/** 展開 `cause` 鏈。有深度上限也認得出環，因為包裝層數是別人家的實作細節。 */
function* causeLinks(error: unknown): Generator<object> {
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 10; depth += 1) {
    if (typeof current !== 'object' || current === null || seen.has(current)) return;
    seen.add(current);
    yield current;
    current = (current as { cause?: unknown }).cause;
  }
}

/**
 * 嗅第一則串流事件時，最多緩衝幾個字元。
 *
 * **數的是解碼之後的字元，不是位元組** —— 這一層別處講邊界都用位元組（見
 * {@link withInbandStreamErrors}），只有這個數字不是，所以名字裡寫清楚。
 *
 * **這是逃生閥不是判準。** 正常的 SSE 第一則事件只有幾百個字元，永遠碰不到這個數字；
 * 碰到的只有「送了一堆位元組卻一則事件都沒收尾」的病態串流。那時候放棄嗅探、原樣放行。
 */
export const INBAND_PEEK_MAX_CHARS = 65_536;

/** 第一則事件之後監看串流內錯誤時，單一事件最多緩衝幾個字元；超過就放棄監看（見 {@link createInbandWatcher}）。 */
export const INBAND_WATCH_MAX_CHARS = 1_048_576;

/** SSE 的事件邊界。`\r\n\r\n` 不含 `\n\n`，所以兩個都要認。 */
const SSE_EVENT_BOUNDARY = /\r\n\r\n|\n\n/;

/**
 * 第一則串流事件其實是個錯誤物件嗎。
 *
 * @param buffered - 已經緩衝下來的串流開頭（可能不只一則事件）。
 * @param ended - 串流是不是已經結束了；結束了的話沒有邊界也算一則完整的事件。
 * @returns 供應商那個錯誤信封原封不動；不是錯誤就 `undefined`。
 */
function firstEventError(buffered: string, ended: boolean): Record<string, unknown> | undefined {
  const boundary = SSE_EVENT_BOUNDARY.exec(buffered);
  if (boundary === null && !ended) return undefined;
  const event = boundary === null ? buffered : buffered.slice(0, boundary.index);

  // SSE 的一則事件可以有多行 `data:`，語意是換行接起來。
  const data = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .join('\n');
  if (data === '' || data === '[DONE]') return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    // 解不開就**不猜**：當成內容放行，維持今天的行為。
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const error = (parsed as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return undefined;
  return parsed as Record<string, unknown>;
}

/**
 * 那個錯誤信封要當成哪個 HTTP 狀態碼。
 *
 * **只認結構化的數字碼，認不出來就 500。** 500 不是保守的預設，是**照 dsh 抄的**：
 * 它的 `providerError` 在沒有 HTTP 狀態碼可看時（`status === undefined`，正是串流內
 * 錯誤的情形）落到 `code = 'SERVER'`（`llm-deepseek/src/protocols/messages/transport.ts:35`），
 * 而 `SERVER` 在預設可重試集裡（`llm/src/retry-policy.ts:18`）。翻成我們的載體就是
 * `500`，經 {@link failureCodeOfStatus} 記成 `SERVER`、可重試。
 *
 * 只收 400–599：Response 的建構子不讓 204／304 帶 body，而一個「錯誤」本來也不該是 2xx。
 *
 * **兩種投遞方式共用這一支**（#1437）：第一則事件是信封時，這裡決定翻出來的 HTTP 回應的狀態；第一則事件之後的信封
 * （{@link createInbandWatcher}）與 SDK 在串流中段拋的、沒有 `status` 的 `APIError`（{@link classifyTurnFailure}）讀同一支，
 * 所以同一個信封不論在串流的哪一格出現都是同一個狀態、同一個碼。
 */
function inbandStatus(envelope: Record<string, unknown>): number {
  return inbandErrorStatus(envelope.error as Record<string, unknown>);
}

/** {@link inbandStatus} 的核心：直接吃信封裡的那個 `error` 物件（SDK 的 `APIError.error` 就是它）。 */
function inbandErrorStatus(error: Record<string, unknown>): number {
  for (const candidate of [error.code, error.status]) {
    if (
      typeof candidate === 'number' &&
      Number.isInteger(candidate) &&
      candidate >= 400 &&
      candidate <= 599
    ) {
      return candidate;
    }
  }
  return 500;
}

/**
 * 把「用 `200 OK` 開線、再把錯誤當成一則事件送進 body」的失敗，翻成一個 HTTP 錯誤回應。
 *
 * ## 病在哪裡
 *
 * NVIDIA 的串流端點會這樣回（[#516](https://github.com/DemianLi/nexus-agent/issues/516)）：
 *
 * ```
 * data: {"error":{"message":"Service temporarily overloaded","type":"service_unavailable","code":503}}
 * data: [DONE]
 * ```
 *
 * SDK 的呼叫包裝器（`AsyncCaller` → `p-retry`）包的是**建立串流的那一次呼叫**。那次拿到 `200`，
 * 當場判定成功；錯誤是稍後消費串流時才冒出來的，**那時候已經在它的射程之外**。
 * 結果是分類與重試政策對這一類失敗**從來沒有被問到** ——
 * 不是判錯，是沒被呼叫到。（#1427 之後 `maxRetries` 恆為 0、重試只在 `retryModelCall` 一層，
 * 但分類與回報仍走這個 `onFailedAttempt`，所以「落進它的迴圈」仍是下面這個做法的目標。）
 *
 * ## 做法：翻譯投遞方式，不是新增政策
 *
 * 在 fetch 這一層先把第一則事件讀出來。是錯誤物件的話，**不往外拋，而是回一個帶著
 * 供應商原始信封的 HTTP 錯誤回應** —— 於是 SDK 走它本來就有的 HTTP 錯誤路徑，
 * 建出帶 `status` 的 `APIError`，那顆錯誤落在 `AsyncCaller` 的 `onFailedAttempt` **裡面**（分類與回報都在那裡做）。
 *
 * **為什麼不用拋的**：`openai@7.5.0` 會把自訂 `fetch` 拋出來的東西包成 `APIConnectionError`
 * （`client.js:558`），而訊息來自 `getConnectionErrorMessage`，它對這個情形回 `undefined`
 * （`client.js:960-965`）—— 也就是人看到的第一句話會從供應商的原話變成 `Connection error.`，
 * 原話退到 `cause` 鏈第二層。回一個 Response 就沒有這個代價：訊息、`status`、`retry-after`
 * 全都留在原來的位置。
 *
 * ## 偏離登記：dsh 的射程比這裡大，差的是載體不是紀律
 *
 * dsh 對這件事有三層，我們表達得出前兩層：
 *
 * 1. **分類不分投遞方式。** `llm/src/error.ts:76`：adapter 把 provider 的 code／type／
 *    message 併成一串餵進同一支分類器，「so both thrown and in-band delivery styles share
 *    one classifier」。這裡同向：in-band 的錯誤被翻成跟 HTTP 錯誤同一個形狀。
 * 2. **adapter 負責翻譯投遞方式。** `llm-pi-ai/src/stream.ts:129-133`：「pi-ai never throws
 *    mid-stream —— failures arrive as `error` events, which become error/aborted `finish`
 *    chunks (the harness protocol's other error-delivery style)」。我們動不了
 *    `@langchain/openai` 那支 adapter（跟 {@link isDerivedContextOverflow} 的偏離登記一同因），
 *    所以退到手上最靠近 adapter 的一格：建 client 的這個工廠。
 * 3. **重試掛在迴圈的步級掛點**（`llm/src/retry-policy.ts:5`、`llm-retry/src/index.ts` 聽
 *    `agent/request-error`），所以它是在整條串流跑完之後才判 `finish.kind === 'error'`
 *    （`core/agent-loop/src/agent.ts:489-493`，`5badb15009a`）—— **中段才出錯的串流 dsh 照樣重試**。
 *
 * **第三層 #516 時退掉了，[#520](https://github.com/DemianLi/nexus-agent/issues/520) 補上了。** 退掉的理由不是「重試中段錯誤
 * 不值得」，而是 dsh 付得起那個代價是因為它有第一級的載體表示「那一次作廢、這是新的一次」：`assistant/attempt` 事件與
 * `assistantStreamRevision`（`core/agent-loop/src/agent.ts:116`、`:426-429`，`5badb15009a`），我們當時沒有——已經送到畫面上的字沒有
 * 地方宣告作廢。#520 補的載體是日誌的 `assistant/attempt`（不進模型）加線上的 `message-discard` 自訂 frame，重打本身是
 * `@nexus/core` 的 `stream-retry.ts`（`wrapModelCall`，排在記錄器外面，每次嘗試各是一對 `model/start`／`model/end`）。
 * **#1427 之後重打只有 core 那一層**：這一層對第一則事件之前的失敗是翻成 HTTP 錯誤，經 `AsyncCaller` 的 `onFailedAttempt`
 * 分類並**回報**（SDK 層 `maxRetries` 為 0，不自己重打）；第一則事件之後的失敗由 {@link createInbandWatcher} 回報。兩種都由 core
 * 那一顆（`retryModelCall`）決定重不重打，**共用同一份預算**，不存在兩邊相乘的問題。
 *
 * ## 邊界：第一則事件，不是「串流錯誤」
 *
 * 涵蓋的是**串流的第一則 SSE 事件**。判準刻意是事件而不是「第一次網路讀取拿到的位元組」——
 * 後者會隨網路分段漂移（loopback 上整份 body 會被併成一段，量出來的覆蓋率是假的）。
 *
 * **這一層（翻成 HTTP 錯誤、交 `onFailedAttempt` 分類回報）不涵蓋、而且有測試釘住**：
 *
 * - 吐了內容之後中段才出錯（第 2 則以後的事件是 error）。
 * - 串流中途斷掉（`ERR_INCOMPLETE_CHUNKED_ENCODING`）。
 *
 * 這兩類在這一層的行為不變：錯誤照原樣往下交、`ChatOpenAI` 只打一次（`live-model.test.ts` 的 `mid503`／`truncated`）。
 * 它們的整次重打在**更上面一層**（#520，見上），端到端的測試在 `stream-retry.test.ts`。吐了內容之後**停住**
 * （不是斷掉）由外層的 {@link withStreamIdleTimeout} 接成逾時，同樣歸那一層重打。
 *
 * **掛住的連線也不歸這一層管，而那是量出來的不是推的。** 嗅探迴圈在 fetch 裡面 await
 * `read()`，所以「開了線卻不吐位元組」看起來會從重試射程外被搬進射程內。實測兩側的請求數
 * 相同（`live-model.test.ts` 的「開了線卻不吐位元組」那條）：SDK 的計時器從請求開始一直計到
 * fetch 回來，嗅探在 fetch 裡面，所以兩側都被它蓋到；逾時的碼 `TIMEOUT` 本來就在可重試集裡。
 * 那個「逾時 × 重試次數」的乘法在這一刀之前就存在，#521 查過是 dsh 的形狀，見
 * {@link DEFAULT_LIVE_TIMEOUT_MS}。
 *
 * ## 這**不**保證 live 跑得完
 *
 * 它保證的只有「政策會被問到」。問到之後救不救得回來，取決於上游是不是間歇的 ——
 * #516 的第四則留言對真端點量到串流內 503 重試 **7/7** 在 `+2s` 內恢復，
 * 但 **n=7**，而且沒有量到上游真的壞窗裡的行為。
 *
 * @param baseFetch - 底層的 fetch。預設全域那個；測試用它換掉。
 * @returns 一個 fetch：非 SSE、非 2xx、沒有 body 的回應原樣放行，其餘嗅第一則事件。
 */
export function withInbandStreamErrors(baseFetch: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    // 抓這一次嘗試的範圍；串流是在 fetch 回來之後才被讀的。
    const report = streamFailureReporter();
    const response = await baseFetch(input, init);
    const contentType = response.headers.get('content-type') ?? '';
    if (!response.ok || response.body === null || !contentType.includes('text/event-stream')) {
      return response;
    }

    // **當場鎖住 reader。** 沒鎖的 body 會在 GC 時被取消，症狀是下行讀到一個乾淨的
    // `done` 而伺服器那側沒有關 —— 看起來像串流正常結束。
    const reader = response.body.getReader();
    const prefix: Uint8Array[] = [];
    const decoder = new TextDecoder();
    let buffered = '';
    let ended = false;
    while (
      !SSE_EVENT_BOUNDARY.test(buffered) &&
      buffered.length < INBAND_PEEK_MAX_CHARS &&
      !ended
    ) {
      const next = await reader.read();
      if (next.done) {
        ended = true;
        break;
      }
      prefix.push(next.value);
      buffered += decoder.decode(next.value, { stream: true });
    }

    const envelope = firstEventError(buffered, ended);
    if (envelope !== undefined) {
      await reader.cancel();
      const headers = new Headers({ 'content-type': 'application/json' });
      for (const name of ['retry-after', 'x-request-id', 'request-id']) {
        const value = response.headers.get(name);
        if (value !== null) headers.set(name, value);
      }
      return new Response(JSON.stringify(envelope), { status: inbandStatus(envelope), headers });
    }

    // 第一則事件之後的串流內錯誤：只監看、不改位元組（#520）。嗅探到上限還沒收尾的病態串流不監看。
    const firstBoundary = SSE_EVENT_BOUNDARY.exec(buffered);
    const watch =
      ended || firstBoundary === null
        ? undefined
        : createInbandWatcher(
            report,
            buffered.slice(firstBoundary.index + firstBoundary[0].length),
          );

    // 沒事：把嗅掉的那幾段原樣接回去。**接的是原始位元組**，不是解碼後再編碼回來的字串。
    const relayed = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of prefix) controller.enqueue(chunk);
        if (ended) controller.close();
      },
      async pull(controller) {
        if (ended) return;
        const next = await reader.read();
        if (next.done) {
          ended = true;
          controller.close();
          return;
        }
        watch?.(decoder.decode(next.value, { stream: true }));
        controller.enqueue(next.value);
      },
      cancel(reason) {
        void reader.cancel(reason);
      },
    });
    return new Response(relayed, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

/**
 * 監看**第一則事件之後**的串流內錯誤，發現了就回報給重試那一層（[#520](https://github.com/DemianLi/nexus-agent/issues/520)）。
 *
 * **只看、不改**：位元組原樣往下交，SDK 照今天的方式自己解析、自己拋 `APIError`；這裡只是在旁邊多解一份，認出錯誤信封就
 * `report` 一次（失敗的種類由 {@link classifyTurnFailure} 依信封的狀態碼與欄位分類，跟第一則事件那條、`turn/failed` 同一支分類器；重打與否由
 * 重試那一層依碼決定）。
 * 不能像第一則事件那樣翻成 HTTP 錯誤回應——內容已經往下送了，回應早就回出去了。
 *
 * 解不開的、不是錯誤信封的事件一律當內容放行。單一事件超過 {@link INBAND_WATCH_MAX_CHARS} 個字元就放棄監看（正常事件
 * 只有幾百字元，那是病態串流；放棄的代價只是這一次的串流內錯誤不重試，回到 #520 之前的行為）。
 *
 * @param report - 這一次嘗試的回報函式。
 * @param rest - 第一則事件之後、嗅探時已經多讀進來的字元。
 * @returns 餵解碼後文字進去的函式。
 */
function createInbandWatcher(
  report: (failure: StreamFailure) => void,
  rest: string,
): (text: string) => void {
  let pending = '';
  let watching = true;
  const scan = (text: string): void => {
    if (!watching) return;
    pending += text;
    for (let boundary = SSE_EVENT_BOUNDARY.exec(pending); boundary !== null;) {
      const event = pending.slice(0, boundary.index);
      pending = pending.slice(boundary.index + boundary[0].length);
      // 便宜的前置篩：正常的內容事件不含 `"error"`，不用付 JSON.parse 的錢。
      if (event.includes('"error"')) {
        const envelope = firstEventError(event, true);
        if (envelope !== undefined) {
          // 同一支分類器（#1437）：信封的狀態碼走 {@link failureCodeOfStatus}，`insufficient_quota` 之類走欄位。
          // 沒有數字碼的信封記 `SERVER`（照 dsh 的 `providerError`），與第一則事件那條一致。
          const status = inbandStatus(envelope);
          report({ code: classifyInbandEnvelope(envelope, status).code, status });
          watching = false;
          pending = '';
          return;
        }
      }
      boundary = SSE_EVENT_BOUNDARY.exec(pending);
    }
    if (pending.length > INBAND_WATCH_MAX_CHARS) {
      watching = false;
      pending = '';
    }
  };
  scan(rest);
  return scan;
}

/**
 * 串流吐了內容之後停住：{@link withStreamIdleTimeout} 等不到下一段位元組。
 *
 * **名字刻意不是 `AbortError`**：openai SDK 的串流迭代器碰到 `AbortError` 會當成正常結束直接
 * `return`（`openai@7.5.0` 的 `core/streaming.js:87-90`）——畫面上會是一段被截斷、卻沒有任何錯誤
 * 的回覆。
 */
export class StreamIdleTimeoutError extends Error {
  override readonly name = 'StreamIdleTimeoutError';

  /** @param timeoutMs - 等了多久。 */
  constructor(readonly timeoutMs: number) {
    super(`串流閒置逾時：模型吐出內容之後 ${timeoutMs} 毫秒沒有再送任何東西。`);
  }
}

/**
 * 串流的閒置逾時：**第一則事件之後**，每等一段位元組就重新計時（[#521](https://github.com/DemianLi/nexus-agent/issues/521)）。
 *
 * ## 為什麼要這一層：SDK 的 `timeout` 管不到串流的中段
 *
 * openai SDK 的計時器在 `fetch` 回來時就清掉（`openai@7.5.0` 的 `client.js:694`，`finally`
 * 裡的 `clearTimeout`）。{@link withInbandStreamErrors} 在 `fetch` 裡讀完第一則事件才回，所以
 * `timeoutMs` 管的是「連線到第一則事件」；之後**什麼都不管**。實測：loopback 端點吐一段內容就停住，
 * `timeout` 300 毫秒的串流過了 3 秒還掛著，掛不掛 {@link withInbandStreamErrors} 都一樣；非串流那條
 * （CLI 的 `invoke`）303 毫秒就逾時，因為 SDK 讀整份 body 時計時器還在。所以 serve 上供應商吐一半
 * 停住，那一輪會一直等到有人按停止。
 *
 * ## 照 dsh：一個閒置逾時，每段重新計時
 *
 * dsh 的 adapter 用 `idleWatchdog`（`packages/util/timeout/src/index.ts:126`，`46a7f68`）：每次
 * `next()` 重新計時，時間到就是 `TIMEOUT`（`llm-pi-ai/src/adapter.ts:355`、`:414-415`），預設
 * `streamIdleTimeoutMs` 300 秒。這裡照做，值是 live-model 列自己的 `streamIdleTimeoutMs`
 * （預設 {@link DEFAULT_LIVE_STREAM_IDLE_TIMEOUT_MS} 90 秒，demian 拍板）；「到第一則事件」另有
 * `timeoutMs`（#1251 拆開，同 dsh 的 `timeoutMs`／`streamIdleTimeoutMs` 兩格，`llm-pi-ai/src/config.ts:160-166`）。
 *
 * **只在有人讀的時候計時**：`pull` 才計時，下游讀得慢不算上游閒置——同 dsh 只在 `next()` 裡計時。
 *
 * ## 偏離登記
 *
 * 1. **中段逾時由 core 的 `stream-retry.ts` 整次重打**（#520；#521 時是「不重試」，因為當時沒有載體宣告「已經送到畫面上的字
 *    作廢」）。dsh 的 `TIMEOUT` 在預設可重試碼裡（`llm/src/retry-policy.ts:18`），由步級掛點重試整條串流；這裡拋
 *    {@link StreamIdleTimeoutError} 的同時向重試那一顆回報 `TIMEOUT`，跟串流中途斷掉（`TRANSPORT`）走同一條路。重打的預算
 *    與第一則事件之前的失敗**共用同一份 `retryPolicy`**（#1427，出廠 6 次，比 dsh 的預設 5 次多，見 `settings/live-model.ts`
 *    的偏離二）。**第一則事件之前的逾時由 SDK 的 `timeout` 計時器產生**，同樣經 `onFailedAttempt` 回報、進同一份預算。
 * 2. **事件級，不是 chunk 級**（#1538 起；之前是位元組級）。dsh 等的是轉接器解好的一個 chunk，SSE 解析器已經把 keep-alive 註解行吞掉，
 *    所以只送 keep-alive 的供應商會被擋下；我們在 `fetch` 這一層沒有解好的 chunk 可等，退到這裡是因為這是手上最靠近 adapter 的一格
 *    （同 {@link withInbandStreamErrors}）。這一層疊在 {@link withStreamCompletionCheck} **外面**，只看得到它放行的位元組，而它只交**完整的 SSE 事件**：
 *    - 寫到一半、一個位元組一個位元組滴的事件**不算進度**，閒置逾時照走（位元組級時這種滴灌會一直把計時器撥回去）；
 *    - 只有註解行的 keep-alive（`: ping`）是完整事件，照樣放行、照樣重新計時——供應商只送 keep-alive 不送內容時，這一層**還是擋不到**，
 *      這是與 dsh 剩下的那一格差距；
 *    - 完成檢查放棄監看（單一事件超過 {@link INBAND_WATCH_MAX_CHARS}）之後，或型錄條目把完成檢查關掉（`compat.supportsFinishReason: false`），位元組原樣交下來，那條連線退回位元組級。
 *    常駐測試在 `stream-completion-check.test.ts` 的「閒置逾時的粒度」。
 *
 * @param timeoutMs - 閒置多久算逾時。
 * @param baseFetch - 底層的 fetch。產品路徑是 {@link withInbandStreamErrors}；測試換掉它。
 * @returns 一個 fetch：非 SSE、非 2xx、沒有 body 的回應原樣放行，其餘把 body 包上閒置計時。
 */
export function withStreamIdleTimeout(
  timeoutMs: number,
  baseFetch: typeof fetch = fetch,
): typeof fetch {
  return async (input, init) => {
    const response = await baseFetch(input, init);
    const contentType = response.headers.get('content-type') ?? '';
    if (!response.ok || response.body === null || !contentType.includes('text/event-stream')) {
      return response;
    }

    // 當場鎖住 reader，理由同 withInbandStreamErrors。
    const report = streamFailureReporter();
    const reader = response.body.getReader();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watched = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          const idle = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new StreamIdleTimeoutError(timeoutMs)), timeoutMs);
          });
          try {
            // **回報只針對「讀上游」這一步**（#520）：SDK 收手之後我們這一側再 `enqueue`／`close` 會撞上「Controller is already
            // closed」，那是下游已經不要了，不是上游斷了——算進去會把一個本來不該重打的失敗標成可重打。
            let next: Awaited<ReturnType<typeof reader.read>>;
            try {
              next = await Promise.race([reader.read(), idle]);
            } catch (error: unknown) {
              if (error instanceof StreamIdleTimeoutError) {
                report({ code: 'TIMEOUT' });
              } else if (!isAbortLike(error) && !(error instanceof UnknownFinishReasonError)) {
                // 使用者中止的 AbortError 不回報——那是我們自己要的，不重打。
                // 陌生的 finish_reason 也不回報（#1538，Q1 (a)）：那是回應本身的問題不是連線的，落到 `UNKNOWN`、不重打。
                // **讀上游這一步失敗，定義上就是連線層的事**（#1437）：undici 的 `terminated`、`ERR_INCOMPLETE_CHUNKED_ENCODING`。
                // 標在這顆錯上，分類器認記號，`turn/failed` 才與這裡同一個 `TRANSPORT`；解不開的回應（SDK 讀完才解析出錯）
                // 不經過這一步，所以不會被當成連線問題重打（Q2 (a)）。
                if (typeof error === 'object' && error !== null) connectionFailures.add(error);
                report({ code: 'TRANSPORT' });
              }
              throw error;
            }
            if (next.done) controller.close();
            else controller.enqueue(next.value);
          } catch (error: unknown) {
            // 逾時要把底下那條連線放掉；錯誤本身一律原樣往下交，失敗分類同今天。
            if (error instanceof StreamIdleTimeoutError) void reader.cancel(error).catch(() => {});
            controller.error(error);
          } finally {
            clearTimeout(timer);
            timer = undefined;
          }
        },
        // 計時器只在 pull 裡活著：這時候取消，等著的那次 read 會回 done，由 pull 的 finally 清掉。
        cancel(reason) {
          return reader.cancel(reason);
        },
        // **水位 0：有人讀才 pull，不預讀**（#1538）。預讀會讓內側（{@link withStreamCompletionCheck}）延後丟的錯在 SDK 處理完上一則事件之前就先發生，
        // 搶在 SDK 自己的解析錯誤前面被回報成 `TRANSPORT`。
      },
      { highWaterMark: 0 },
    );
    return new Response(watched, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

/**
 * 模型的回應串流在**收到結束原因（`finish_reason`）之前**就結束了（[#1538](https://github.com/DemianLi/nexus-agent/issues/1538)）。
 *
 * 兩種結束法：`via: 'done'` 是看到 `data: [DONE]` 卻從沒出現過 `finish_reason`；`via: 'eof'` 是上游乾淨關線（連 `[DONE]` 都沒有）。
 * 都是中間的代理或閘道把回應切在一半、卻乾乾淨淨地收尾，使用者端會看到一段被截斷、卻顯示成正常結束的答案。
 *
 * **名字刻意不是 `AbortError`**，理由同 {@link StreamIdleTimeoutError}：openai SDK 的串流迭代器把 `AbortError` 當成正常結束。
 * 這顆錯由 {@link withStreamCompletionCheck} 標進 {@link connectionFailures} 並回報 `TRANSPORT`，分類器與重試那一層都把它當斷線。
 */
export class StreamEndedWithoutFinishError extends Error {
  override readonly name = 'StreamEndedWithoutFinishError';

  /** @param via - 靠什麼發現的：`[DONE]` 或上游關線。 */
  constructor(readonly via: 'done' | 'eof') {
    super(
      via === 'done'
        ? '模型的回應串流送出 [DONE]，但從沒收到結束原因（finish_reason），回覆可能被截斷。'
        : '模型的回應串流在收到結束原因（finish_reason）之前就被關閉了，回覆可能被截斷。',
    );
  }
}

/**
 * 供應商回了 nexus 不認得的 `finish_reason`（[#1538](https://github.com/DemianLi/nexus-agent/issues/1538)，Q1 (a)）。
 *
 * `@langchain/core` 的 `mapFinishReason` 把不認得的字串一律改成 `stop`，一段被供應商中止的回覆（`insufficient_system_resource` 之類）
 * 就會被當成「講完了」。這裡在 `fetch` 層讀得到原字串，當成失敗：不回報任何碼，分類器落到 `UNKNOWN`、不重打，訊息指名原字串。
 */
export class UnknownFinishReasonError extends Error {
  override readonly name = 'UnknownFinishReasonError';

  /** @param reason - 供應商送來的原字串。 */
  constructor(readonly reason: string) {
    super(
      `模型回了無法辨識的結束原因 finish_reason=${JSON.stringify(reason)}，這一輪當成失敗；端點不送標準結束原因時，把型錄條目的 compat.supportsFinishReason 設成 false。`,
    );
  }
}

/** nexus 認得的 `finish_reason`：OpenAI 相容端點的標準值，加上舊式的 `function_call` 與部分供應商的 `max_tokens`。 */
const KNOWN_FINISH_REASONS: ReadonlySet<string> = new Set([
  'stop',
  'length',
  'max_tokens',
  'tool_calls',
  'function_call',
  'content_filter',
]);

/**
 * 串流完成檢查（[#1538](https://github.com/DemianLi/nexus-agent/issues/1538)）：每一條 SSE 串流都要有一則帶 `finish_reason` 的事件，
 * 沒有就是被切斷，照斷線處理。
 *
 * ## 病在哪裡
 *
 * 讀上游失敗（undici 的 `terminated`）今天會被 {@link withStreamIdleTimeout} 標成斷線、回報 `TRANSPORT`。可是反向代理在 chunk 邊界
 * 乾淨收掉 upstream 時，body 是正常 EOF：沒有任何一層會講話——openai SDK 的迭代器沒收到 `[DONE]` 也正常 `return`，
 * `@langchain/core` 最後一律送 `message-finish`。答案停在一半，這一輪卻以 `turn/end` 收尾、日誌記成功。
 *
 * ## 做法：看，不改
 *
 * 在 `fetch` 這一層（同 {@link withInbandStreamErrors}、{@link withStreamIdleTimeout} 退到這裡的理由：`@langchain/openai` 的事件轉換
 * 不暴露原始 `finish_reason`，`message-finish` 又會把它蓋掉）逐則解 SSE 事件，記下有沒有出現過非空的 `choices[0].finish_reason`。
 * 位元組原樣往下交，只在三種情形把串流弄成錯誤：
 *
 * 1. 看到 `[DONE]`、之前沒有 finish → {@link StreamEndedWithoutFinishError}（`via: 'done'`）。**只在 EOF 判斷抓不到這一種**：openai 的迭代器
 *    看到 `[DONE]` 就收手，不再讀到 EOF。
 * 2. 上游 EOF、之前沒有 finish → {@link StreamEndedWithoutFinishError}（`via: 'eof'`）。
 *    這兩種都標進 {@link connectionFailures} 並回報 `TRANSPORT`，照 #1427 的政策整次重打。
 * 3. 出現了不認得的 finish（{@link KNOWN_FINISH_REASONS} 之外）→ {@link UnknownFinishReasonError}。不回報碼，落到 `UNKNOWN`、不重打。
 *
 * **不觸發的情況**：非 2xx、非 SSE、沒有 body；看過錯誤信封（中段的錯誤交給信封那一條，不改判）；下游已經取消（SDK 收手之後）；
 * 讀上游本身失敗（錯誤原樣交下去，由 {@link withStreamIdleTimeout} 標記）；單一事件超過 {@link INBAND_WATCH_MAX_CHARS}（放棄監看）。
 *
 * ## 偏離登記
 *
 * 1. **在位元組層解 SSE，不是在轉接器解好的事件上**（理由 1，基座表達不出來）。dsh 在 pi-ai 轉接器那一層，串流在 `finish_reason` 之前
 *    結束就發 `Stream ended without finish_reason`，並歸 `TRANSPORT`（`llm-pi-ai/src/stream.ts:52-58`）；nexus 沒有那一層。
 * 2. **不新增 `STREAM_CLOSED` 碼**：那是 dsh 轉接器對「pi-ai 事件流沒有 done／error 就結束」的不變量，nexus 沒有那一層。
 *
 * @param baseFetch - 底層的 fetch。產品路徑是 {@link withInbandStreamErrors}；測試換掉它。
 * @returns 一個 fetch：非 SSE、非 2xx、沒有 body 的回應原樣放行，其餘把 body 包上完成檢查。
 */
export function withStreamCompletionCheck(baseFetch: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    // 抓這一次嘗試的範圍；串流是在 fetch 回來之後才被讀的。
    const report = streamFailureReporter();
    const response = await baseFetch(input, init);
    const contentType = response.headers.get('content-type') ?? '';
    if (!response.ok || response.body === null || !contentType.includes('text/event-stream')) {
      return response;
    }

    // 當場鎖住 reader，理由同 withInbandStreamErrors。
    const reader = response.body.getReader();
    // 還沒收尾的那一則事件的位元組：**扣著不交**，收尾了才連同前面完整的事件一起交下去。這樣觸發點那則事件之前的位元組
    // 可以照常交給下游（SDK 先把它們解析完，例如先遇到解不開的事件就拋它自己的錯），錯誤留到下一次讀才丟。
    let held: Buffer = Buffer.alloc(0);
    let finished = false;
    let sawError = false;
    let watching = true;
    let cancelled = false;
    let deferred: Error | undefined;

    /** 一則完整事件：回傳要不要把串流弄成錯誤。 */
    const inspect = (event: string): Error | undefined => {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n');
      if (data === '[DONE]') {
        return finished || sawError ? undefined : new StreamEndedWithoutFinishError('done');
      }
      // 便宜的前置篩：不含這兩個字串的事件不用付 JSON.parse 的錢。
      if (!data.includes('"finish_reason"') && !data.includes('"error"')) return undefined;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return undefined;
      }
      if (typeof parsed !== 'object' || parsed === null) return undefined;
      const { error, choices } = parsed as { error?: unknown; choices?: unknown };
      if (typeof error === 'object' && error !== null) {
        sawError = true;
        return undefined;
      }
      if (!Array.isArray(choices) || choices.length === 0) return undefined;
      const choice: unknown = choices[0];
      if (typeof choice !== 'object' || choice === null) return undefined;
      const reason = (choice as { finish_reason?: unknown }).finish_reason;
      if (typeof reason !== 'string' || reason === '') return undefined;
      finished = true;
      return KNOWN_FINISH_REASONS.has(reason) ? undefined : new UnknownFinishReasonError(reason);
    };

    const fail = (
      controller: ReadableStreamDefaultController<Uint8Array>,
      failure: Error,
    ): void => {
      if (failure instanceof StreamEndedWithoutFinishError) {
        connectionFailures.add(failure);
        report({ code: 'TRANSPORT' });
      }
      void reader.cancel(failure).catch(() => {});
      controller.error(failure);
    };

    const checked = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          if (deferred !== undefined) {
            fail(controller, deferred);
            return;
          }
          // 一次 pull 一定要交出東西或收尾：沒交出東西 SDK 的那次讀會一直掛著。
          for (;;) {
            let next: Awaited<ReturnType<typeof reader.read>>;
            try {
              next = await reader.read();
            } catch (error: unknown) {
              // 讀上游失敗：原樣交下去，標記與回報是 withStreamIdleTimeout 的事。
              controller.error(error);
              return;
            }
            if (cancelled) return;
            if (next.done) {
              const tail = held;
              held = Buffer.alloc(0);
              const failure =
                watching && tail.length > 0 ? inspect(tail.toString('utf8')) : undefined;
              const ended =
                failure ??
                (watching && !finished && !sawError
                  ? new StreamEndedWithoutFinishError('eof')
                  : undefined);
              if (ended === undefined) {
                if (tail.length > 0) controller.enqueue(tail);
                controller.close();
                return;
              }
              if (failure === undefined && tail.length > 0) {
                deferred = ended;
                controller.enqueue(tail);
                return;
              }
              fail(controller, ended);
              return;
            }
            if (!watching) {
              controller.enqueue(next.value);
              return;
            }
            const combined = Buffer.concat([held, next.value]);
            // latin1 一個字元一個位元組，字串索引就是位元組偏移；事件邊界是 ASCII，不會落在多位元組字元裡面。
            const text = combined.toString('latin1');
            let start = 0;
            for (let boundary = SSE_EVENT_BOUNDARY.exec(text.slice(start)); boundary !== null;) {
              const end = start + boundary.index;
              const failure = inspect(combined.toString('utf8', start, end));
              if (failure !== undefined) {
                held = Buffer.alloc(0);
                if (start === 0) {
                  fail(controller, failure);
                } else {
                  deferred = failure;
                  controller.enqueue(combined.subarray(0, start));
                }
                return;
              }
              start = end + boundary[0].length;
              boundary = SSE_EVENT_BOUNDARY.exec(text.slice(start));
            }
            if (combined.length - start > INBAND_WATCH_MAX_CHARS) {
              // 單一事件超過上限：放棄監看，已扣著的全部交下去。
              watching = false;
              held = Buffer.alloc(0);
              controller.enqueue(combined);
              return;
            }
            held = combined.subarray(start);
            if (start > 0) {
              controller.enqueue(combined.subarray(0, start));
              return;
            }
          }
        },
        cancel(reason) {
          cancelled = true;
          return reader.cancel(reason);
        },
        // 水位 0：有人讀才 pull。延後丟的錯要等 SDK 把交下去的位元組處理完、真的又來讀才發生（見 {@link withStreamIdleTimeout} 同一處的註解）。
      },
      { highWaterMark: 0 },
    );
    return new Response(checked, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

/** 一則助手訊息在請求 body 裡的樣子，只看這一層要讀的幾格。 */
interface WireAssistant {
  role: 'assistant';
  content?: unknown;
  tool_calls?: unknown;
}

/**
 * 這則助手訊息的 content 是不是**一個字都沒有的陣列**：沒有任何一段非空白的文字。
 *
 * 有工具呼叫時只認陣列。字串（CLI 那條送的 `""`）與 `null`（`@langchain/openai` 標準轉換那條送的）
 * 配工具呼叫兩個模型都收，不動。空白算空，同 pi-ai 的 `.filter((block) => block.text.trim().length > 0)`。
 */
function isEmptyContentArray(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return !content.some((part: unknown) => {
    if (typeof part !== 'object' || part === null) return true;
    const { type, text } = part as { type?: unknown; text?: unknown };
    if (type !== 'text') return true;
    return typeof text === 'string' && text.trim().length > 0;
  });
}

/**
 * 這則助手訊息的 content 是不是一個字都沒有，**不分形狀**：`null`、缺席、空白字串、{@link isEmptyContentArray}。
 * 沒有工具呼叫的那一種用它判：什麼都沒有的一則，照 dsh 整則不送。
 */
function isEmptyContent(content: unknown): boolean {
  if (content === null || content === undefined) return true;
  if (typeof content === 'string') return content.trim() === '';
  return isEmptyContentArray(content);
}

/**
 * 把請求裡**沒有內容**的助手訊息換成 dsh 的送法
 * （[#592](https://github.com/DemianLi/nexus-agent/issues/592)）：有工具呼叫、內容是空陣列的送
 * `content: null`；沒有工具呼叫、內容是空的（任何形狀）整則不送。
 *
 * 後者的第二個來源是撞到輸出上限（[#433](https://github.com/DemianLi/nexus-agent/issues/433)）：那一則的工具
 * 呼叫被清掉，只剩推理或什麼都沒有。CLI 那條送的是 `""`、web 那條是空陣列或 `null`，所以這一種不分形狀——
 * 同 dsh 的 `surface.ts:142-147`（`477b4f4`）與 pi-ai 的「沒有 content 也沒有工具呼叫的整則略過」。
 *
 * @param messages - 請求 body 的 `messages`。
 * @returns 換過的訊息串；一則都沒換時是**原本那個陣列**。
 */
export function normalizeEmptyAssistantContent(messages: readonly unknown[]): readonly unknown[] {
  let changed = false;
  const next: unknown[] = [];
  for (const message of messages) {
    const assistant = message as WireAssistant;
    if (typeof message !== 'object' || message === null || assistant.role !== 'assistant') {
      next.push(message);
      continue;
    }
    const hasToolCalls = Array.isArray(assistant.tool_calls) && assistant.tool_calls.length > 0;
    if (
      hasToolCalls ? !isEmptyContentArray(assistant.content) : !isEmptyContent(assistant.content)
    ) {
      next.push(message);
      continue;
    }
    changed = true;
    if (hasToolCalls) next.push({ ...assistant, content: null });
  }
  return changed ? next : messages;
}

/**
 * 送出前把**沒有內容**的助手訊息換掉——gpt-oss-20b 收到 `content: []`＋`tool_calls` 會回 400
 * （[#592](https://github.com/DemianLi/nexus-agent/issues/592)）；沒有工具呼叫、什麼都沒有的那則照 dsh
 * 整則不送（[#433](https://github.com/DemianLi/nexus-agent/issues/433) 放寬到每一種形狀）。
 *
 * ## 誰會送出 `[]`
 *
 * `@langchain/openai` 1.5.10 的 `convertMessagesToCompletionsMessageParams` 有兩條路
 * （`dist/converters/completions.js:571`）：帶 `response_metadata.output_version === 'v1'` 的走標準
 * 轉換，沒有文字、有工具呼叫時送 `null`；其餘走舊路，把推理與工具呼叫區塊濾掉、剩下的陣列原樣送，
 * 沒有文字就是 `[]`。產品路徑上掉進 `[]` 的有兩個（本機假端點實測，正常串流、日誌還原、CLI 都不會）：
 *
 * 1. deepagents 的 `truncateArgs`（`deepagents@1.13.1`）重建舊訊息時丟了 `response_metadata`，
 *    推理＋工具呼叫的那則送成 `[]`＋`tool_calls`。**這個會壞。**
 * 2. 按停止時只收到推理的那則（#561），送成 `[]`、沒有工具呼叫。**今天不會壞**，照 dsh 一起收掉。
 *
 * ## 誰會送出空字串或 `null`、又沒有工具呼叫
 *
 * 撞到輸出上限的那則（#433）：`@nexus/core` 的 `max-tokens.ts` 清掉它的呼叫之後，只寫了參數、沒吐字的
 * 那種什麼都不剩——CLI 那條送 `""`，web 那條送空陣列或 `null`。**不分形狀整則不送**。這也收掉了別的
 * 來源的同一種形狀（例如只有推理的最終回覆），同 dsh 不分來源：沒有內容也沒有呼叫的就不是一則。
 * 這一種兩個模型都沒有量過（上表只量了 `[]`），照 dsh 做。
 *
 * ## 真端點量到的（2026-09-25，NVIDIA 閘道，非串流，各 1 次）
 *
 * | 助手訊息 | gpt-oss-20b | nemotron-3-super |
 * | --- | --- | --- |
 * | `[]`＋`tool_calls` | **400**（`content.0 Input should be a valid dictionary`） | 200 |
 * | `null`＋`tool_calls` | 200 | 200 |
 * | `""`＋`tool_calls` | 200 | 200 |
 * | `[]`、沒有 `tool_calls` | 200 | 200（第一輪一次 500，重打 3/3 是 200） |
 * | 整則不送 | 200 | 200 |
 * | 工具結果之後整則不送（`tool` → `user`） | 200 | 5 次 4 次 200，另一次 500 |
 *
 * 最後一列是第二個來源最常見的位置：使用者在工具結果之後那一次呼叫裡按停止。nemotron 那次 500 在
 * 對照組（同位置送 `[]`，3 次 2 次 200）也出現，兩邊都有、每一種形狀都零星出現，是閘道偶發。
 *
 * 所以壞的只有第一格。gpt-oss 那幾格常常 60 秒等不到標頭，等到 240 秒才拿到上表的結果——是閘道慢，
 * 不是拒收（連「整則不送」這種完全合法的請求也一樣慢）。
 *
 * ## 照 dsh
 *
 * dsh 的 chat-completions 由 pi-ai 組請求（`@earendil-works/pi-ai@0.85.1`，dsh `477b4f4` 的
 * `packages/llm/llm-pi-ai/package.json`），`dist/api/openai-completions.js` 的 `convertMessages`：
 * 助手文字為空時 content 是 `null`（`:959-961`，NVIDIA 端點偵測出的 `requiresAssistantAfterToolResult`
 * 是 `false`，`:1285`）；沒有 content 也沒有工具呼叫的整則略過（`:1050-1060`）。這裡照做。
 *
 * ## 偏離登記
 *
 * 1. **改在 `fetch` 這一層，不在組請求那一步。** dsh 在序列化裡就送對；`@langchain/openai` 的轉換
 *    函式沒有可設定的地方，所以退到手上最靠近它的一格：送出前的 body（同
 *    {@link withInbandStreamErrors} 退到 `fetch` 的理由）。
 * 2. **只換空的那種**（有工具呼叫的只換空陣列，沒有的不分形狀）。pi-ai 還把非空的文字接成一條字串送（它的註解說陣列會讓 NVIDIA NIM 上的
 *    DeepSeek V3.2 照抄區塊結構）。那會改掉每一則有字的助手訊息的送法，兩個模型都要重量，不在這張。
 *
 * @param baseFetch - 底層的 fetch。預設全域那個；測試用它換掉。
 * @returns 一個 fetch：`/chat/completions` 的 POST、body 是 JSON 字串時換掉空的助手內容，其餘原樣。
 */
export function withEmptyAssistantContent(baseFetch: typeof fetch = fetch): typeof fetch {
  return rewriteChatMessages(baseFetch, normalizeEmptyAssistantContent);
}

/**
 * 把 `/chat/completions` 的 POST（body 是 JSON 字串）的 `messages` 交給 `rewrite` 換過再送，其餘原樣交下去。
 *
 * `rewrite` 一則都沒換時要回**原本那個陣列**（同一個物件）：這時連 body 都不重新序列化，`init` 原樣往下送。
 * 不是這種請求（別的路徑、不是 POST、body 不是 JSON、沒有 `messages` 陣列）也原樣交下去。
 */
function rewriteChatMessages(
  baseFetch: typeof fetch,
  rewrite: (messages: readonly unknown[]) => readonly unknown[],
): typeof fetch {
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (
      init?.method !== 'POST' ||
      typeof init.body !== 'string' ||
      !new URL(url).pathname.endsWith('/chat/completions')
    ) {
      return baseFetch(input, init);
    }
    let body: unknown;
    try {
      body = JSON.parse(init.body);
    } catch {
      return baseFetch(input, init);
    }
    const messages = (body as { messages?: unknown } | null)?.messages;
    if (!Array.isArray(messages)) return baseFetch(input, init);
    const rewritten = rewrite(messages);
    if (rewritten === messages) return baseFetch(input, init);
    return baseFetch(input, {
      ...init,
      body: JSON.stringify({ ...(body as object), messages: rewritten }),
    });
  };
}

/**
 * 去掉助手訊息的 `name`（[#1392](https://github.com/DemianLi/nexus-agent/issues/1392)，決議見
 * `.docs/log-derived-history-vs-wire-2026-10-08.md` 最後一則補記）。
 *
 * 欄位的來源不是我們的碼：LangChain 的 `AgentNode`（`langchain@1.5.10` 的 `dist/agents/nodes/AgentNode.js:97-98`）
 * 把回來的 `AIMessage` 的 `name` 設成 `options.name ?? "model"`。非串流回的是完整訊息所以帶，串流路徑不帶
 * （同一份日誌，兩條路徑送出的訊息不同，#1159 量過 80 次）。日誌不記它、`replayConversation` 不產生它、dsh 的
 * `AssistantMessage` 沒有這個欄位，所以它是「到了模型請求、不在日誌裡」的東西；兩條路徑統一成都不送。
 *
 * 只動 `role: "assistant"` 的 `name`：工具訊息等其他角色的 `name` 不是這張卡的事。
 *
 * ## 偏離登記
 *
 * **改在 `fetch` 這一層。** dsh 在序列化裡就不送；`AgentNode` 的 `name` 是 `??` 後面接預設值，傳什麼都拿不掉，
 * `@langchain/openai` 的轉換函式也沒有可設定的地方，所以退到手上最靠近它的一格：送出前的 body（同
 * {@link withEmptyAssistantContent} 與 {@link withInbandStreamErrors} 退到 `fetch` 的理由）。
 *
 * @param messages - 請求 body 的 `messages`。
 * @returns 換過的訊息串；沒有任何助手訊息帶 `name` 時是**原本那個陣列**。
 */
export function stripAssistantName(messages: readonly unknown[]): readonly unknown[] {
  let changed = false;
  const next = messages.map((message) => {
    if (typeof message !== 'object' || message === null) return message;
    const { role, name, ...rest } = message as { role?: unknown; name?: unknown };
    if (role !== 'assistant' || name === undefined) return message;
    changed = true;
    return { role, ...rest };
  });
  return changed ? next : messages;
}

/**
 * 送出前把助手訊息的 `name` 拿掉，見 {@link stripAssistantName}。
 *
 * @param baseFetch - 底層的 fetch。預設全域那個；測試用它換掉。
 * @returns 一個 fetch：`/chat/completions` 的 POST、body 是 JSON 字串時去掉助手訊息的 `name`，其餘原樣。
 */
export function withoutAssistantName(baseFetch: typeof fetch = fetch): typeof fetch {
  return rewriteChatMessages(baseFetch, stripAssistantName);
}

/**
 * 出貨的「送出前換 body」那一組：換掉空的助手內容（#592）、再去掉助手訊息的 `name`（#1392）。
 *
 * **`createLiveModel` 與測試夾具共用這一個函式**（[#1398](https://github.com/DemianLi/nexus-agent/issues/1398)）：
 * 夾具自己組的模型（`log-derived-history.fixture.ts` 的 `model()`）要量的是出貨時線上的形狀，兩邊各疊一次的話，
 * 產品哪天多掛一格 body 改寫、夾具不會跟著變，S 系列量到的就悄悄不是出貨的樣子。要加新的一格改寫就加在這裡。
 *
 * 順序：`withoutAssistantName` 在外、`withEmptyAssistantContent` 在內——外層的請求先被去掉 `name`，
 * 再交給內層換空內容；兩格改的是不同的欄位，順序不影響結果，這裡照 #1392 之後 `createLiveModel` 原本的疊法不變。
 *
 * @param baseFetch - 底層的 fetch。預設全域那個；`createLiveModel` 傳進最貼近底層的用量回報那一層，測試用它換掉。
 */
export function withShippedRequestBody(baseFetch: typeof fetch = fetch): typeof fetch {
  return withoutAssistantName(withEmptyAssistantContent(baseFetch));
}

/** 串流用量嗅探單行的長度上限：超過的行放棄（供應商的片段不會這麼長，上限只防暴長的怪行把記憶體吃光）。 */
const USAGE_TAP_MAX_LINE_CHARS = 1_000_000;

/**
 * 從一行 SSE 資料讀供應商的用量（OpenAI 相容：`usage.prompt_tokens`／`completion_tokens`／`total_tokens`，快取細節在
 * `prompt_tokens_details.cached_tokens`／`cache_write_tokens`，#724）。
 * 不是 `data:` 行、沒有 `"usage"`、JSON 壞掉、`usage` 為 `null` 或缺欄一律 `undefined`——**不補 0**。
 * 快取細節缺欄或 `null` 就不放那個 key（沒報），不補 0；`prompt_tokens` 含這兩桶，減法在 `validateUsage`。
 */
function usageOfSseLine(line: string): AttemptUsage | undefined {
  if (!line.startsWith('data:') || !line.includes('"usage"')) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.slice('data:'.length));
  } catch {
    return undefined;
  }
  const usage = (parsed as { usage?: unknown } | null)?.usage;
  if (typeof usage !== 'object' || usage === null) return undefined;
  const {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: total,
    prompt_tokens_details: details,
  } = usage as Record<string, unknown>;
  if (input === undefined || output === undefined || total === undefined) return undefined;
  const { cached_tokens: cacheRead, cache_write_tokens: cacheWrite } =
    typeof details === 'object' && details !== null
      ? (details as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    ...(cacheRead === undefined || cacheRead === null ? {} : { cacheReadTokens: cacheRead }),
    ...(cacheWrite === undefined || cacheWrite === null ? {} : { cacheWriteTokens: cacheWrite }),
  };
}

/**
 * 把串流裡供應商報的用量回報給這次模型呼叫（`@nexus/core` 的 `beginAttemptReport`，
 * [#1022](https://github.com/DemianLi/nexus-agent/issues/1022)）：呼叫沒有正常回來時，用量記錄器靠它記下那次燒掉的 token。
 *
 * ## 為什麼在 `fetch` 層
 *
 * 失敗的呼叫沒有回應物件可讀；v3 串流的模型層又收不到 token 回呼（pump 轉發的逐段片段不經模型的回呼）。供應商的用量只活在
 * 串流的位元組裡，而 `fetch` 是手上最靠近那些位元組的一格——同 {@link withInbandStreamErrors} 退到這裡的理由。
 * **放最內層，緊貼底層 fetch**：外面的嗅探與逾時層動過的位元組，這一層不必知道。
 *
 * ## 做什麼、不做什麼
 *
 * - **每次請求開跑就換一格新的**（重試的下一次請求不繼承上一次的），串流邊流邊嗅每一行 `data:`，看到 `usage` 就回報，後到的覆蓋先到的。
 * - **位元組原樣放行**，不解碼重編、不延後：只是旁邊讀一份。
 * - **供應商不報就沒有**。OpenAI 相容的串流把用量放在**最後一則**片段（`stream_options.include_usage`），所以串流中途斷線的呼叫
 *   多半拿不到——那種「不知道」靠 `model/end.outcome` 表態，**不是 0**。
 * - 非 2xx、非 SSE、沒有 body 的回應原樣放行（錯誤回應沒有用量）；不在模型呼叫範圍裡（標題那一顆）不嗅。
 *
 * @param baseFetch - 底層的 fetch。預設全域那個；測試用它換掉。
 */
export function withStreamUsageReport(baseFetch: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const report = beginAttemptReport();
    const response = await baseFetch(input, init);
    const contentType = response.headers.get('content-type') ?? '';
    if (
      report === undefined ||
      !response.ok ||
      response.body === null ||
      !contentType.includes('text/event-stream')
    ) {
      return response;
    }
    const decoder = new TextDecoder();
    let pending = '';
    let skipping = false;
    const scan = (text: string, flush: boolean): void => {
      const lines = (pending + text).split('\n');
      pending = flush ? '' : (lines.pop() ?? '');
      for (const raw of lines) {
        // 暴長行的尾巴：頭已經丟了，這一段不是完整的一行。
        if (skipping) {
          skipping = false;
          continue;
        }
        const usage = usageOfSseLine(raw.replace(/\r$/, ''));
        if (usage !== undefined) report(usage);
      }
      if (pending.length > USAGE_TAP_MAX_LINE_CHARS) {
        pending = '';
        skipping = true;
      }
    };
    // `pipeThrough` 當場鎖住來源，沒鎖的 body 會在 GC 時被取消（見 {@link withInbandStreamErrors}）。
    const tapped = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          controller.enqueue(chunk);
          scan(decoder.decode(chunk, { stream: true }), false);
        },
        flush() {
          scan(decoder.decode(), true);
        },
      }),
    );
    return new Response(tapped, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

/**
 * 一次模型呼叫的用途。照 dsh `GenerateOptions.purpose`（`packages/llm/llm/src/types.ts:547-552`，`477b4f4`）：
 * 「adapters may map the purpose to … purpose-specific generation policy」，一般的對話請求不帶。
 *
 * - `session-title`：標題（#650）。帶上型錄條目的關推理寫法（`thinkingOffBody`），同 dsh 的 DeepSeek adapter 對這個用途關掉思考
 *   （`packages/llm/llm-deepseek/src/serialize.ts:146`）。
 *
 * dsh 另有 `compaction`，我們的摘要走另一條路，沒有這一格的消費者。
 */
export type LiveModelPurpose = 'session-title';

/**
 * 這一列型錄條目的圖片額度檢查（#1270）：宣告了 `imageBudget` 且收圖才有；純文字模型的圖在投影裡就是文字佔位，不佔額度，不量。
 * 超額由 {@link assertImageBudget} 拋 `IMAGE_OFFLOAD_REQUIRED`，上層接住。額度跟著 adapter 走（照 dsh：額度住在 adapter 的部署設定），
 * 換模型就是換一顆 adapter、換一份額度。
 */
export function imageBudgetGuard(entry: ModelEntry): RequestGuard | undefined {
  const budget = entry.imageBudget;
  if (budget === undefined || acceptsImages(entry) === 'rejects') return undefined;
  return (messages) => assertImageBudget(messages, budget);
}

/**
 * 真實供應商的 model。
 *
 * key **每次請求前才向憑證服務取**（`credentials.ts`），缺少時直接失敗，沒有預設值也不 fallback
 * （[docs/standards.md](../../../docs/standards.md) 的秘密處理規則）。
 *
 * @param config - 連線值與型錄（`settings/live-model.ts`）。**必填，沒有預設參數**（#545）：
 *   一個預設參數會讓「呼叫端忘了傳」跟「設定就是這個」長得一模一樣。產品路徑（CLI、serve）
 *   傳起動期從清單解出來的那一份；eval 與 spike 手上沒有清單，在自己的入口用 schema 預設，
 *   eval 只換 `modelId`（見 [`eval/tiers.ts`](./eval/tiers.ts)）——**除了模型 id，取樣設定、
 *   逾時、金鑰來源完全相同**，否則比的不是模型是設定。
 * @param purpose - 這一顆拿來做什麼，見 {@link LiveModelPurpose}。一般的對話請求不帶。
 */
export function createLiveModel(
  config: LiveModelConfig,
  purpose?: LiveModelPurpose,
  credentials: CredentialService = ambientCredentials(),
  overrides: {
    readonly maxOutputTokens?: number;
    /**
     * 關掉這顆的推理（[#877](https://github.com/DemianLi/nexus-agent/issues/877)，背景子代理被指定 `off` 那一級）：疊上型錄條目的
     * `thinkingOffBody`，同標題那一顆的做法。條目沒宣告 `off` 或沒有 chat template 參數時什麼都不加。
     */
    readonly thinkingOff?: boolean;
    /**
     * 附件儲存（[#732](https://github.com/DemianLi/nexus-agent/issues/732)）：給了就建會在送出請求前把附件參照換成模型看得懂的
     * 東西的子類（`attachment-chat-openai.ts`）。對話那條路（root，與可以換成的別顆）給；標題與背景子代理的模型不會看到附件參照。
     */
    readonly attachments?: AttachmentSource;
    /**
     * 全機的模型請求並行閘（[#1505](https://github.com/DemianLi/nexus-agent/issues/1505)，`request-gate.ts`）：給了就建帶閘的子類，
     * 每一次模型呼叫先取名額、結束時還。**只有 serve 給**（一次性 CLI、REPL、eval、spike 不建閘）；全機只有一份，每個建模型的地方
     * （對話、換模型、背景子代理、標題）都要交同一份，不然那一處的請求不受管。
     */
    readonly requestGate?: RequestGate;
  } = {},
): ChatOpenAI {
  // 型錄沒有這個 id 就拋，訊息指名 id：設定的 schema 已經擋過一次，這裡是手搭設定的呼叫端（測試、eval）的最後一道。
  const entry = requireModelEntry(config.models, config.modelId);
  // **建構時先問一次**：缺 key 在組裝當下就失敗，不等到第一個請求。這是跟 dsh 的時刻差異——dsh 只在請求當下才拋
  // （`llm-deepseek-api-key`），我們兩個時刻都拋：組裝時的那一次讓 `--live` 起不來的原因在起動時就講，
  // 請求時的那一次負責受管檔在兩個請求之間被拿掉的情況。
  resolveUsableKey(credentials);

  const fields: ChatOpenAIFields = {
    model: config.modelId,
    // `fetch` 疊三層（再加最內層貼著底層 fetch 的串流用量回報，#1022，只旁讀不改位元組；與 #1538 夾在中間外層的完成檢查）：最內層是
    // 送出前換 body 的兩格（{@link withShippedRequestBody}，夾具共用）——#592（換掉空的助手內容）與 #1392（拿掉助手訊息的 `name`），中間是 #516
    // （串流內回報的錯誤翻成 HTTP 錯誤回應，才進得了重試射程），外層是 #521（第一則事件之後的閒置逾時）。
    // 外層收到的是中間那層嗅完第一則事件的那份回應。
    configuration: {
      baseURL: config.baseUrl,
      // **每次請求前才解析**（openai 的 `apiKey` 收函式，實測經過 `bindTools`／`withConfig` 之後還在，
      // 見 `live-model.test.ts`）。所以受管檔改了、下一個請求就用新的，也不必把 key 放進行程的環境變數。
      apiKey: async () => resolveUsableKey(credentials),
      fetch: withStreamIdleTimeout(
        config.streamIdleTimeoutMs,
        // 完成檢查夾在閒置逾時與串流內錯誤之間（#1538）；型錄條目宣告 `supportsFinishReason: false`（端點不送 finish_reason）就不掛。
        (entry.compat?.supportsFinishReason === false
          ? (fetcher: typeof fetch) => fetcher
          : withStreamCompletionCheck)(
          withInbandStreamErrors(withShippedRequestBody(withStreamUsageReport())),
        ),
      ),
    },
    temperature: 1,
    topP: 0.95,
    // 這顆的輸出上限跟著型錄條目走；覆寫是明著傳的（標題那一顆用它自己那一列的上限）。
    maxTokens: overrides.maxOutputTokens ?? entry.maxTokens,
    timeout: config.timeoutMs,
    // **SDK 層不重試**（#1427，照 dsh `llm-pi-ai/src/adapter.ts:141`：「The agent recovery layer owns visible attempts」）。
    // 重試只有 `@nexus/core` 的 `stream-retry.ts` 那一層，首事件之前與之後共用一份預算；留著 SDK 的 6 次就是兩層相乘
    // （#1341 的 G4：打到端點 9 次、日誌只有 2 顆）。`onFailedAttempt` 仍然會在每次失敗時被叫（含沒有重試的這一次）——
    // 分類（下架、溢出、不可重試）與把「這一次值得重打」報給重試那一層，都靠它。
    maxRetries: 0,
    onFailedAttempt: classifyAndReportFailedAttempt,
    // 用途專屬的請求內容，見 {@link LiveModelPurpose}。**要在建構時給**：建好之後才設 `modelKwargs` 不會進請求
    // （#650 實測，前兩輪的參數就是這樣沒送出去的）。
    ...((purpose === 'session-title' || overrides.thinkingOff === true) &&
      Object.keys(thinkingOffBody(entry)).length > 0 && {
        modelKwargs: thinkingOffBody(entry),
      }),
  };
  // 帶了附件儲存的才用會投影附件的子類（#732）：沒有儲存就不會有附件參照進得了請求，也就不需要它。
  const attachments = overrides.attachments;
  const requestGate = overrides.requestGate;
  const instance =
    attachments !== undefined
      ? new AttachmentChatOpenAI(
          fields,
          (messages) => projectAttachments(messages, attachments, acceptsImages(entry)),
          imageBudgetGuard(entry),
          requestGate,
        )
      : requestGate !== undefined
        ? new GatedChatOpenAI(fields, requestGate)
        : new ChatOpenAI(fields);
  // 對話那一顆（含子代理）貼路由標籤（#723）：`model/start.route`、換模型通知與系統提示詞的 `{{model}}` 讀它。標題等別的用途不貼——
  // 它們不是對話的請求，不該冒充「最近一次請求走的路由」。
  return purpose === undefined
    ? tagModelRoute(instance, {
        model: config.modelId,
        ...(overrides.thinkingOff === true && { effort: 'off' }),
      })
    : instance;
}

/**
 * 模型下架了 —— 那句話，原封不動。
 *
 * ## 為什麼要專門認它：它要的是那句話，不只是一個碼
 *
 * 一顆下架的模型，碼本身（`HTTP_410`，#1437 之後由 {@link failureCodeOfStatus} 記，不在可重試集裡所以不重打）已經夠分類；
 * 專門認它是為了**把供應商那句帶日期的話搬到人眼前**，並換一個說得出「去哪裡換模型」的訊息。
 * （#1437 之前的版本它還有一個職責：`410` 不在基座那份不重試清單裡，所以曾被重試滿政策的 `maxRetries` 次——
 * **實測 2026-09-04（當時是 SDK 層 6 次、退避 1–32 秒）：`openai/gpt-oss-120b` 的 410 花了 106.7 秒才浮出來**。
 * 現在重試只看碼，這個職責退場了。）
 *
 * ## 這裡沒有破「認碼不解析訊息」那條規矩
 *
 * 判準是 `status === 410`，一個**碼**。`detail` 只是被**原樣搬運**到失敗訊息裡 ——
 * 沒有任何分支讀它的內容。這跟 {@link isDerivedContextOverflow} 是兩回事：那邊是拿訊息
 * 當資料來源（而且登記了偏離），這邊只是把供應商的話帶到人眼前。
 *
 * **值得搬運，是因為那句話帶著日期**：`has reached its end of life on
 * 2026-09-03T08:00:00Z`。少了它，錯誤只說得出「410」，而「哪一天下架的」正是判斷
 * 「是不是我們太久沒動」的那一格。
 *
 * ## 認得出來 ≠ 擋得住
 *
 * 這只讓失敗快一點、話清楚一點。**它擋不住「預設模型哪天會下架」** —— 那要連外，
 * CI 裡沒有憑證也沒有端點。所以這裡不假裝是一道 gate，它是一句在事發當下說得出所以然的話。
 *
 * @param error - 供應商拋出來的東西，可能已經被包過好幾層。
 * @returns 下架時的失敗訊息；不是 410 就 `undefined`。
 */
export function modelGoneMessage(error: unknown): string | undefined {
  for (const link of causeLinks(error)) {
    if ((link as { status?: unknown }).status !== 410) continue;
    const body = (link as { error?: unknown }).error;
    const detail =
      typeof body === 'object' && body !== null ? (body as { detail?: unknown }).detail : undefined;
    const said =
      typeof detail === 'string' && detail.trim() !== ''
        ? detail.trim()
        : '端點沒有給 detail —— 只說了 410。';
    return (
      `模型已下架（HTTP 410），重試無效：${said} ` +
      '在設定裡換掉 `live-model` 那一列的 `modelId`（出貨值在 apps/harness/cordis.yml）；' +
      '重新盤點端點上叫得動哪些模型的方法，在 src/eval/tiers.ts 的檔頭。'
    );
  }
  return undefined;
}

/**
 * 一次失敗要怎麼處置：先分類，再決定 SDK 層要不要接著重打。
 *
 * **抽成具名的匯出，是為了它測得到。** 它是 `AsyncCaller` 的 `onFailedAttempt`，而
 * 「`AsyncCaller` 到底會不會為一個不可重試的 400 叫它」是這條鏈上唯一還沒量過的一環
 * ——寫成 closure 的話，不打真端點就驗不到。`live-model.test.ts` 拿一個 loopback
 * 假端點把整條走一遍（零憑證、零外部連線）。
 *
 * **重試只看碼**（[#1437](https://github.com/DemianLi/nexus-agent/issues/1437)）：中止之外，這裡把錯誤交給
 * {@link classifyTurnFailure}，碼不在預設可重試集（`DEFAULT_STREAM_RETRYABLE_CODES`）裡就拋出去讓 SDK 別再打。
 * 產品路徑上 SDK 層的 `maxRetries` 是 0，真正決定重打的是 `@nexus/core` 的 `retryModelCall`，它讀的也是
 * 同一個碼（見 {@link classifyAndReportFailedAttempt}）；這裡的閘門只讓**直接把它掛在 `ChatOpenAI` 上**的呼叫
 * （單元測試、eval 的尺寸比較）維持「401／400／422 這類打一次就放棄」。
 *
 * **下架排在最前面**：它換掉的是錯誤的**說法**——供應商那句帶日期的話、與去哪裡換模型。
 * **溢出的分類排在重試決策之前**，因為它換掉的是錯誤的**型別**而不是重試與否：
 * `ContextOverflowError` 建構當下就標成不可重試（`stampRetryable(this, false)`），而它本來就是個 400。
 *
 * @param error - 這次失敗的錯誤。
 * @throws 要放棄時拋——下架拋人話的那顆、溢出拋 branded 的那顆、其餘原樣拋。要重試就正常返回。
 */
export function classifyFailedAttempt(error: unknown): void {
  // `onFailedAttempt` 看到的一定是模型呼叫的失敗（含不在圖裡的標題、摘要器、eval）：記下來，分類器才套連線規則。
  markModelCallFailure(error);
  const gone = modelGoneMessage(error);
  if (gone !== undefined) throw new Error(gone, { cause: error });
  if (isDerivedContextOverflow(error)) throw ContextOverflowError.fromError(error as Error);
  if (isAbortLike(error)) throw error;
  if (DEFAULT_STREAM_RETRYABLE_CODES.includes(classifyTurnFailure(error).code)) return;
  throw error;
}

/**
 * 這一環是不是「請求逾時」。**認的是名字，而且要認 SDK 真的丟的那個**：openai SDK 的逾時是 `TimeoutError`
 * （`name`，訊息 `Request timed out.`，沒有 `status`），不是它型別宣告裡的 `APIConnectionTimeoutError`——
 * 後一個名字從來沒出現過，原本只認它，逾時就被記成 `TRANSPORT`（#434 量到）。`StreamIdleTimeoutError` 是我們自己
 * 在第一則事件之後的閒置逾時（#521）。
 */
function isTimeoutLink(link: object): boolean {
  const name = (link as { name?: unknown }).name;
  return (
    name === 'StreamIdleTimeoutError' ||
    name === 'APIConnectionTimeoutError' ||
    name === 'TimeoutError'
  );
}

/**
 * 這一環是不是「串流中段的錯誤信封」被 SDK 拋出來的那顆：`openai` 的 `APIError` 基底類別、**沒有 `status`**
 * （`core/streaming.js:62`／`:78`：`new APIError(undefined, data.error, …)`）。有狀態的錯誤是 `generate()` 出的子類別
 * （`BadRequestError`…），名字不同，不會落到這裡。
 */
function isInbandApiError(link: object): boolean {
  if ((link.constructor as { name?: string } | undefined)?.name !== 'APIError') return false;
  return typeof (link as { status?: unknown }).status !== 'number';
}

/**
 * 連線層錯誤碼（Node／undici 的）→ `TRANSPORT`。**逐碼列舉，每個碼說得出它對到 dsh 哪一類**
 * （pi-ai 的 `classifyPiAiError`，`llm-pi-ai/src/stream.ts:56-65`；那一支只認訊息字面，它自己的 `XXX` 註解說「拿得到
 * `code`／`cause` 就該改認碼」，所以這裡認碼、不認字面，但類別要對得上）：
 *
 * | 碼 | pi-ai 的字面類別 |
 * | --- | --- |
 * | `UND_ERR_SOCKET` | 有：訊息 `other side closed`／`socket`（`:62-65`）→ `TRANSPORT` |
 * | `ECONNRESET`、`ECONNREFUSED` | 有：`ECONN[A-Z]+`（`:62`）→ `TRANSPORT` |
 * | `UND_ERR_CLOSED` | 沒有字面對應：undici 的 `ClientClosedError`，連線已被關掉；歸 `TRANSPORT`（最近的是 `connection` 那一類） |
 * | `EPIPE` | 沒有字面對應：寫進已關閉的 socket；歸 `TRANSPORT` |
 * | `ENOTFOUND`、`EAI_AGAIN` | 沒有字面對應：名字解析失敗；歸 `TRANSPORT` |
 * | `ENETUNREACH`、`EHOSTUNREACH` | 沒有字面對應：網路／主機不可達；歸 `TRANSPORT` |
 * | `ERR_INCOMPLETE_CHUNKED_ENCODING` | 沒有字面對應：chunked 回應在結尾前被切斷；pi-ai 對應的是 `terminated`／`premature close`（`:63-65`）那一類，歸 `TRANSPORT` |
 *
 * **不在表裡的就不是連線問題**：`UND_ERR_INVALID_ARG`、`UND_ERR_NOT_SUPPORTED` 這類是我們自己的程式錯誤，照 Q2 (a)
 * 記 `UNKNOWN`、不重打——不用 `UND_ERR_` 前綴一網打盡。`ECONNABORTED` 也不在：那是 {@link isAbortLike} 的中止。
 */
const NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ERR_INCOMPLETE_CHUNKED_ENCODING',
]);

/**
 * 逾時類錯誤碼 → `TIMEOUT`（照 pi-ai `:61`：訊息含 `timeout`／`timed out` 的記 `TIMEOUT`，排在連線類之前）。
 * 兩個碼都在預設可重試集裡，重打行為與記成 `TRANSPORT` 相同，差別只在日誌與網頁上寫的碼。
 *
 * | 碼 | 說明 |
 * | --- | --- |
 * | `UND_ERR_HEADERS_TIMEOUT`、`UND_ERR_BODY_TIMEOUT` | undici 等標頭／等 body 逾時；訊息含 `Timeout`，有字面對應 |
 * | `UND_ERR_CONNECT_TIMEOUT` | undici 連線逾時；訊息 `Connect Timeout Error`，有字面對應 |
 * | `ETIMEDOUT` | Node 的 TCP 逾時；訊息 `connect ETIMEDOUT` 沒有被 `\btimed out\b` 的字界吃到，沒有字面對應，依 PM 審查（#1448）歸 `TIMEOUT` |
 */
const TIMEOUT_ERROR_CODES: ReadonlySet<string> = new Set([
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'ETIMEDOUT',
]);

/**
 * 這一環是不是連線層的失敗：SDK 的 `APIConnectionError`（SDK 自己的型別，工具鏈上不會有）、
 * {@link withStreamIdleTimeout} 標過的讀端錯誤，或是**模型呼叫拋的錯**（`modelCall`，見 {@link isModelCallFailure}）
 * 上有 {@link NETWORK_ERROR_CODES} 的碼。
 *
 * **碼那一條只在模型呼叫的錯誤鏈上套**：工具 middleware 拋的、cause 帶 `ECONNREFUSED` 的錯（MCP 伺服器連不上）是工具失敗，
 * 不該被記成模型的 `TRANSPORT`。
 */
function isConnectionLink(link: object, modelCall: boolean): boolean {
  if ((link.constructor as { name?: string } | undefined)?.name === 'APIConnectionError')
    return true;
  if (connectionFailures.has(link)) return true;
  const code = (link as { code?: unknown }).code;
  return modelCall && typeof code === 'string' && NETWORK_ERROR_CODES.has(code);
}

/**
 * 把一則串流內錯誤信封用同一支分類器分類（給第一則事件之後的監看用，#1437）。
 *
 * 造一個形狀同 SDK 在串流中段拋的那顆（`status` 補上、`error`／`code`／`type` 取自信封）的物件餵給
 * {@link classifyTurnFailure}，所以 `insufficient_quota`、狀態表、溢出以外的欄位規則全部共用，不在監看那裡另寫一份。
 */
function classifyInbandEnvelope(envelope: Record<string, unknown>, status: number): LlmFailure {
  const inner = envelope.error as Record<string, unknown>;
  const message = typeof inner.message === 'string' ? inner.message : '串流內回報了錯誤';
  return classifyTurnFailure(
    Object.assign(new Error(message), { status, error: inner, code: inner.code, type: inner.type }),
  );
}

/**
 * 把「這一輪為什麼失敗」描述成日誌裡的 {@link LlmFailure}（[#434](https://github.com/DemianLi/nexus-agent/issues/434)），
 * 給 `turn/failed.error`**，也給 `llm/retry.failure`**（[#1437](https://github.com/DemianLi/nexus-agent/issues/1437)）。
 *
 * ## 一支分類器，不分投遞方式
 *
 * #1437 之前有兩支：`classifyLlmFailure`（`llm/retry` 用，只有 `RATE_LIMIT`／`SERVER`／`TIMEOUT`／`TRANSPORT` 四個碼，
 * 任何狀態都記 `SERVER`）與這一支。**同一顆錯在兩處的碼不同**（串流中段的信封、斷流：`llm/retry` 記 `SERVER`／
 * `TRANSPORT`，`turn/failed` 記 `UNKNOWN`），而且 408／422／425 這類被當成 `SERVER` 重打。現在只有這一支：
 * 分類、`llm/retry` 的回報、串流內信封的監看、`turn/failed` 全走它，重打與否由重試那一層**只看碼**。照 dsh 的
 * `providerError`（`packages/llm/llm-deepseek/src/transport.ts`，`5badb15`）的順序與詞彙：
 *
 * | 條件（認結構化欄位，不解析訊息） | `code` | 預設重打 |
 * | --- | --- | --- |
 * | 401、403 | `AUTH` | 否 |
 * | 402，或任何一環 `code`／`type` 是 `insufficient_quota`、或名字是 `RateLimitQuotaExhaustedError`／`InsufficientQuotaError`（要在 429 之前，它跟限流共用 429） | `QUOTA` | 否 |
 * | 429 | `RATE_LIMIT` | 是 |
 * | 鏈上有 `ContextOverflowError`（含伺服器導出負 `max_tokens` 那種，見 {@link isDerivedContextOverflow}） | `CONTEXT_WINDOW_EXCEEDED` | 否 |
 * | 400、413 | `INVALID_REQUEST` | 否 |
 * | ≥ 500 | `SERVER` | 是 |
 * | 其他有狀態的（404、408、410、418、422、425…） | `HTTP_<狀態>` | 否 |
 * | 模型呼叫拋的、串流中段的錯誤信封（SDK 拋的沒有 `status` 的 `APIError`）：信封的數字碼（400–599）照上面幾列；沒有數字碼 | 照上面；`SERVER` | 照上面；是 |
 * | 沒有狀態、逾時那幾個名字（{@link isTimeoutLink}），或模型呼叫的錯誤鏈上有 {@link TIMEOUT_ERROR_CODES} 的碼 | `TIMEOUT` | 是 |
 * | 本機排隊等不到名額（`request-gate.ts` 拋的 `LocalCapacityError`，沒有送請求，#1505） | `LOCAL_CAPACITY` | 否 |
 * | 空回覆（{@link createEmptyResponseMiddleware} 拋的 `EmptyResponseError`） | `EMPTY_RESPONSE` | 是 |
 * | 沒有狀態、連線層的（`APIConnectionError`、模型呼叫的錯誤鏈上有 {@link NETWORK_ERROR_CODES} 的碼、讀串流時被切斷，見 {@link connectionFailures}） | `TRANSPORT` | 是 |
 * | **其餘——不是供應商的錯，或解不開的回應** | `UNKNOWN` | 否 |
 *
 * 狀態那幾列就是 {@link failureCodeOfStatus}；它與這張表只有一處寫。
 *
 * `UNKNOWN` 是 dsh 的規矩（`packages/core/session/src/types.ts:206-210`：解不成 `LlmFailure` 的錯一律壓成
 * `{ message, code: 'UNKNOWN' }`）。我們的 `turn/failed` 還有不是模型的來源——工具 middleware 拋的、遞迴上限、
 * `#withdraw` 的狀態查詢——它們沒有供應商的任何痕跡，就是 `UNKNOWN`。**不要把它們套進 `TRANSPORT`**：「沒有狀態」
 * 不等於「網路問題」，這是 #1437 之前那支把整類程式錯誤標成網路問題的原因（Q2 (a)：解不開的回應也是 `UNKNOWN`，dsh 記成
 * `PI_AI_ERROR`、同樣不重試）。
 *
 * ## 為什麼要先拆 `MiddlewareError`
 *
 * 實測（假端點＋真的 `createNexusAgent`）：丟到 `thread-pump` 那個 catch 的錯是 **14 層** `MiddlewareError`，
 * 供應商的錯在最底下。{@link causeLinks} 只展 10 層，所以直接丟進來**一個狀態都讀不到**。先沿 `cause` 拆到不是
 * `MiddlewareError` 為止，同 `turn-cancel.ts` 的 `isTurnCancelled`。
 *
 * `message` 是呼叫端照舊寫進 `turn/failed.message` 的那句（最外層的 `error.message`），不是底下那個：兩處同一句，
 * 讀的人不用猜哪個才是人話。
 *
 * @param error - 這一輪拋出來的東西，可能已經被包過很多層。
 */
export function classifyTurnFailure(error: unknown): LlmFailure {
  const message = error instanceof Error ? error.message : String(error);
  let root = error;
  while (MiddlewareError.isInstance(root)) root = root.cause;

  let status: number | undefined;
  let inband: number | undefined;
  let quota = false;
  let overflow = false;
  let timedOut = false;
  let connection = false;
  let empty = false;
  let localCapacity = false;
  let invalidCredential = false;
  // 「只看結構」的連線與串流中段規則只套在模型呼叫拋的錯誤鏈上（工具 middleware 的錯不算）。
  const links = [...causeLinks(root)];
  const modelCall = links.some((link) => isModelCallFailure(link));
  for (const link of links) {
    const found = (link as { status?: unknown }).status;
    if (status === undefined && typeof found === 'number') status = found;
    const { code, type, name } = link as { code?: unknown; type?: unknown; name?: unknown };
    if (code === 'insufficient_quota' || type === 'insufficient_quota') quota = true;
    if (name === 'RateLimitQuotaExhaustedError' || name === 'InsufficientQuotaError') quota = true;
    if (ContextOverflowError.isInstance(link)) overflow = true;
    if (isTimeoutLink(link)) timedOut = true;
    if (modelCall && typeof code === 'string' && TIMEOUT_ERROR_CODES.has(code)) timedOut = true;
    if (isConnectionLink(link, modelCall)) connection = true;
    if (name === 'EmptyResponseError') empty = true;
    if (name === 'LocalCapacityError') localCapacity = true;
    if (name === 'InvalidCredentialError') invalidCredential = true;
    if (inband === undefined && modelCall && isInbandApiError(link)) {
      const body = (link as { error?: unknown }).error;
      inband = inbandErrorStatus(
        typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {},
      );
    }
  }
  // 串流中段的信封沒有 HTTP 狀態：用信封自己的數字碼（沒有就 500），與第一則事件那條翻成 HTTP 回應時同一支（`inbandStatus`）。
  if (status === undefined) status = inband;

  const code =
    quota && status !== 401 && status !== 403
      ? 'QUOTA'
      : status === 401 || status === 403
        ? 'AUTH'
        : status === 429
          ? 'RATE_LIMIT'
          : overflow
            ? 'CONTEXT_WINDOW_EXCEEDED'
            : status !== undefined
              ? failureCodeOfStatus(status)
              : invalidCredential
                ? INVALID_CREDENTIAL_CODE
                : localCapacity
                  ? LOCAL_CAPACITY_CODE
                  : empty
                    ? 'EMPTY_RESPONSE'
                    : timedOut
                      ? 'TIMEOUT'
                      : connection
                        ? 'TRANSPORT'
                        : 'UNKNOWN';
  return { message, code, ...(status !== undefined && { status }) };
}

/**
 * 供應商給的 `retry-after`（毫秒）：從錯誤鏈上找帶 `headers` 的那一環，秒數或 HTTP 日期都認，沒有就 `undefined`。
 *
 * **認 header，不解析訊息**（同這個檔的規矩）。in-band 錯誤翻成的 HTTP 回應會把 `retry-after` 帶過來
 * （{@link withInbandStreamErrors}），所以兩種投遞方式走同一條路。
 */
export function retryAfterMsOf(error: unknown): number | undefined {
  for (const link of causeLinks(error)) {
    const headers = (link as { headers?: unknown }).headers;
    if (typeof headers !== 'object' || headers === null) continue;
    const raw =
      typeof (headers as { get?: unknown }).get === 'function'
        ? (headers as Headers).get('retry-after')
        : (headers as Record<string, unknown>)['retry-after'];
    if (typeof raw !== 'string') continue;
    const parsed = parseRetryAfterMs(raw);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

/**
 * `AsyncCaller` 的 `onFailedAttempt`（#1427、#1437）：先分類，再把「這一次失敗是哪一種」報給重試那一層
 * （`@nexus/core` 的 `noteStreamFailure`，`stream-retry.ts` 在外面讀它）。
 *
 * **回報的是碼，不是判斷**：重打與否由那一層依 `retryableCodes` 決定，這裡不替它下結論（#1437：碼決定重試）。
 * 所以不重打的失敗（`HTTP_422`、`AUTH`…）也照樣回報——`retryableCodes` 若被使用者加上 `HTTP_422`，政策就是要重打，
 * 這裡不該先把它關掉。中止是例外：那是我們自己要的，不回報。
 *
 * **分類先做**（{@link classifyFailedAttempt}）：要放棄的在那裡拋；這裡取拋出來的那顆（下架的人話、溢出的 branded 錯誤）
 * 的碼回報，再原樣往外拋。SDK 層的 `maxRetries` 是 0，這裡正常返回的失敗會直接以原錯誤落到外層，**不再由 `p-retry` 排退避**。
 *
 * 範圍外（沒有包重試的呼叫）回報是空操作，行為同 SDK 重試關掉之後的樣子：打一次、失敗就失敗。
 */
function classifyAndReportFailedAttempt(error: unknown): void {
  let outcome: unknown = error;
  let thrown = false;
  try {
    classifyFailedAttempt(error);
  } catch (caught: unknown) {
    outcome = caught;
    thrown = true;
  }
  if (!isAbortLike(error)) {
    const failure = classifyTurnFailure(outcome);
    const retryAfterMs = retryAfterMsOf(outcome);
    noteStreamFailure({
      code: failure.code,
      ...(failure.status !== undefined && { status: failure.status }),
      ...(retryAfterMs !== undefined && { retryAfterMs }),
    });
  }
  if (thrown) throw outcome;
}

/**
 * 解析並收下這一把金鑰：沒有就拋缺 key，有但不合格（空白、標頭放不下的字元）就拋 {@link InvalidCredentialError}，合格的回修過頭尾的值
 * （#1541，照 dsh 在轉接器取金鑰的那一刻判）。建構時與每次請求前各走一次：建構時讓 `--live` 起不來的原因在起動當場就講，
 * 請求時負責受管檔在兩個請求之間被改壞的情況。**只有空白的值不往下一層退**：資訊來自最高優先的那一層，退下去會讓人以為
 * 受管檔生效了，其實用的是別處的金鑰（`resolve` 回第一個有值的層，空白字串算有值）。
 */
function resolveUsableKey(credentials: CredentialService): string {
  const hit = credentials.resolve(LIVE_API_KEY_ENV);
  if (hit === undefined) throw new Error(missingKeyMessage(credentials.store));
  return assertUsableApiKey(LIVE_API_KEY_ENV, hit);
}

/**
 * 缺 key 的失敗訊息：指名缺哪一個、去哪裡放。分兩種講法（#1540）：serve 掛受管檔且它最優先；一次性入口（CLI、eval、spike）不讀受管檔，
 * 訊息明說，免得人把 key 只放受管檔、跑 `cli:live` 卻找不到原因。
 */
function missingKeyMessage(store: boolean): string {
  return store
    ? `缺少環境變數 ${LIVE_API_KEY_ENV}。真實供應商的 key 沒有預設值也不 fallback，` +
        '依序從這幾處找：harness home 的受管憑證檔（~/.nexus-agent/.credentials.yaml，chmod 600，最優先）、' +
        '啟動環境、目前資料夾的 .env、harness home 的 .env（~/.nexus-agent/.env）；欄位名見 .env.example。'
    : `缺少環境變數 ${LIVE_API_KEY_ENV}。真實供應商的 key 沒有預設值也不 fallback，` +
        '此入口不讀受管檔（.credentials.yaml 只有 serve 讀），依序從這幾處找：' +
        '啟動環境、目前資料夾的 .env、harness home 的 .env（~/.nexus-agent/.env）；欄位名見 .env.example。';
}

/** {@link loadLiveLaunchEnv} 的結果。 */
export interface LiveLaunch {
  readonly launchEnv: LaunchEnvironment;
  /** 這次啟動的憑證服務：模型從它取 key，每次請求前解析。 */
  readonly credentials: CredentialService;
  /**
   * 「`NVIDIA_API_KEY` 來自哪一層」那一行（#1540）：只有名字與來源，不含值；一次性入口會寫明「此入口不讀受管檔」。
   * 啟動當下還沒有任何一層有值時是 `undefined`（缺 key 由 `createLiveModel` 當場失敗）。呼叫端各自印到自己的日誌。
   */
  readonly keySource: string | undefined;
}

/**
 * 真模型路徑的啟動：載入兩層 `.env`（{@link loadLaunchEnv}）、建憑證服務；`store` 時並**完整檢查受管檔**
 * （權限或格式不對就起不來）。key 都找不到、而舊位置（程式碼資料夾根目錄）的 `.env` 還在時，
 * 直接失敗、指名搬去哪裡。
 *
 * **這不是 fallback。** 每一層都是明說過的來源（順序見 `credentials.ts`）；缺的變數留給
 * {@link createLiveModel} 當場失敗並指名缺哪一個。
 *
 * @param options - `store` **必填**（#1540，照 dsh 分兩邊）：serve 傳 `true`，受管檔最優先；CLI、eval、spike 傳 `false`，
 *   完全不碰受管檔（不 `stat`、不讀、不檢查，壞檔也不擋），順序是啟動環境 > 目前資料夾 `.env` > harness home `.env`。
 *   `cwd` 是「專案」那一層 `.env` 所在（省略即 `process.cwd()`）；`env` 只用來解 harness home（省略即 `process.env`）。
 *   兩層 `.env` 的值仍寫進 `process.env`（同 dsh）；受管檔的值不會。
 * @throws 壞的 `.env`、`store` 時壞的受管檔、或舊位置搬家訊息。
 */
export function loadLiveLaunchEnv(options: {
  readonly store: boolean;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}): LiveLaunch {
  const cwd = options.cwd ?? process.cwd();
  const home = resolveHarnessHome(options.env ?? process.env);
  const launchEnv = loadLaunchEnv({ cwd, home });
  const credentials = createCredentialService({ home, launchEnv, store: options.store });
  credentials.check();
  if (credentials.resolve(LIVE_API_KEY_ENV) === undefined) {
    const moved = legacyEnvMovedError(launchEnv, LIVE_API_KEY_ENV, { cwd, home });
    if (moved !== undefined) throw moved;
  }
  return { launchEnv, credentials, keySource: describeKeySource(credentials, LIVE_API_KEY_ENV) };
}

import { resolve } from 'node:path';
import { ContextOverflowError } from '@langchain/core/errors';
import { ChatOpenAI } from '@langchain/openai';

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
 * 五個連線值由清單上 `live-model` 那一列講（[#545](https://github.com/DemianLi/nexus-agent/issues/545)，
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
 * 單一請求的逾時上限。
 *
 * **這不是調校，是止血。** 這個端點的失敗模式是**永遠不回來**（[#57](https://github.com/DemianLi/nexus-agent/issues/57)），
 * 而尺寸比較是一連串請求 —— 沒有上限的話，中間掛住一次換來的是整輪比較沒有結果，
 * 而不是「那一格失敗」。90 秒是量出來的：實測最慢的成功回應是 43 秒
 * （`meta/muse-glimmer-30b`），掛住的那兩個在 90 秒仍是零位元組。
 *
 * **在串流上它管兩段**（[#521](https://github.com/DemianLi/nexus-agent/issues/521)）：連線到第一則事件
 * 由 SDK 的計時器管、在重試射程內；第一則事件之後每一段的閒置由 {@link withStreamIdleTimeout} 管、
 * 不重試。同 dsh 只有一個 `streamIdleTimeoutMs`（預設 300 秒）。
 *
 * **最壞情況是它乘上重試次數**：開了線卻不吐位元組，每一次都等滿，90 秒 × (6 + 1) = 630 秒，再加上
 * 退避的 63–126 秒（`settings/live-model.ts` 的偏離二）。**這是 dsh 的形狀，不是缺陷**：dsh 的
 * `TIMEOUT` 在預設可重試碼裡（`llm/src/retry-policy.ts:18`），5 次重試 × 300 秒閒置 ≈ 30 分鐘。
 * #521 查過之後照 dsh 保留逾時重試——一次偶發的慢本來就該重試。
 */
export const DEFAULT_LIVE_TIMEOUT_MS = 90_000;

/**
 * 被端點限流時，最多重試幾次。
 *
 * **這道要存在，是因為基座那道的作用面比看起來窄。** `AsyncCaller` 的 `maxRetries` 預設是
 * 6，看起來限流本來就會被接住；但 `@langchain/core` 的 `defaultFailedAttemptHandler` 把
 * **沒有 `retry-after` header 的 429** 分類成 `headerless_429` → `action: 'capacity'`，
 * 然後**直接拋**（`async_caller.js`）。NVIDIA 回的正是
 * `{"status":429,"title":"Too Many Requests"}` —— 沒有那個 header，所以一次都不會重試。
 * 底層那道也關著：`@langchain/openai` 建 `OpenAI` client 時寫死 `maxRetries: 0`。
 *
 * **退避多久是量出來的，不是猜的。** 2026-08-28 實測這個端點：`openai/gpt-oss-120b` 在
 * 49.5 秒內燒掉 119,363 token 後觸發 429（約 120k 的每分鐘 token 配額），而 **16 秒後
 * 就完全恢復** —— 輕請求與一次真的 eval 執行都立刻通過。`AsyncCaller` 交給 `p-retry` 的
 * 退避是 1／2／4／8／16／32 秒（帶隨機），所以第四次重試累計就蓋過那個窗口。
 *
 * **偏離標註**：dsh 的 [`retry-policy.ts`](../../../references/deepseek-harness/packages/llm/llm/src/retry-policy.ts)
 * 把 `RATE_LIMIT` 放在預設可重試碼裡（與這裡同向），但它的退避是**有界**的
 * （`initialDelayMs: 500`、`maxDelayMs: 10_000`、`jitterRatio: 0.1`）。`AsyncCaller`
 * **沒有把退避參數暴露出來** —— 只收 `maxRetries` 與 `onFailedAttempt`，退避寫死在
 * `callWithRetries` 裡。所以這裡只釘得住次數，釘不住每次等多久；要對齊 dsh 的有界退避
 * 得自己包一層 caller，那是更大的一張工。
 */
export const DEFAULT_LIVE_MAX_RETRIES = 6;

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
 * HTTP 狀態碼裡「重試幾次都一樣」的那些。
 *
 * **這是 `@langchain/core@1.2.9` `async_caller.js` 的 `STATUS_NO_RETRY` 的複本。**
 * 抄一份是因為它沒有被匯出，而我們需要在自訂的 `onFailedAttempt` 裡維持它的行為 ——
 * 見 {@link retryDecision} 的說明。**它會隨基座版本漂移**，升級 `@langchain/core`
 * 時要回頭核一次；`live-model.test.ts` 有一條測試釘住 400 不重試，但釘不住整份清單。
 */
const STATUS_NO_RETRY: ReadonlySet<number> = new Set([
  400, 401, 402, 403, 404, 405, 406, 407, 409, 413,
]);

/**
 * 一次失敗要不要重試。
 *
 * **這是基座 `defaultFailedAttemptHandler` 的複本，只改了一支。** 基座沒有把它匯出，
 * 而 `onFailedAttempt` 是全有全無的 —— 傳了就整個取代掉預設，沒有「只改一條規則」的接縫。
 * 所以這裡把預設的判斷抄回來，唯一的差別是**沒有 `retry-after` header 的 429**：
 * 基座把它歸成 `action: 'capacity'` 然後放棄，這裡讓它重試。
 *
 * **為什麼不是「非限流一律放棄」**：那會把 `500`、連線斷掉這些**本來會重試**的也一起關掉，
 * 是一次行為退化。預設的形狀是「除了明確無望的以外都重試」，不是反過來。
 */
export function retryDecision(error: unknown): 'retry' | 'give-up' {
  // 中止是我們自己要的，不重試。
  if (error instanceof Error) {
    if (error.name === 'AbortError') return 'give-up';
    if (error.message.startsWith('Cancel') || error.message.startsWith('AbortError')) {
      return 'give-up';
    }
  }
  if (typeof error === 'object' && error !== null) {
    if ((error as { code?: unknown }).code === 'ECONNABORTED') return 'give-up';
  }

  // 配額耗盡與 4xx：重試幾次都一樣。
  for (const link of causeLinks(error)) {
    const code = (link as { code?: unknown }).code;
    if (code === 'insufficient_quota') return 'give-up';
    const name = (link as { name?: unknown }).name;
    if (name === 'RateLimitQuotaExhaustedError' || name === 'InsufficientQuotaError') {
      return 'give-up';
    }
    const status = (link as { status?: unknown }).status;
    if (typeof status === 'number' && status !== 429 && STATUS_NO_RETRY.has(status)) {
      return 'give-up';
    }
  }

  // 到這裡還是 429 的話就是限流 —— 這一支才是我們跟基座不同的地方。
  // 其餘（5xx、連線問題、解不開的回應）沿用基座「重試」的預設。
  return 'retry';
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
 * 「一個不在 {@link STATUS_NO_RETRY} 裡的 5xx」。
 *
 * 只收 400–599：Response 的建構子不讓 204／304 帶 body，而一個「錯誤」本來也不該是 2xx。
 */
function inbandStatus(envelope: Record<string, unknown>): number {
  const error = envelope.error as Record<string, unknown>;
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
 * 重試包裝器（`AsyncCaller` → `p-retry`）包的是**建立串流的那一次呼叫**。那次拿到 `200`，
 * 當場判定成功；錯誤是稍後消費串流時才冒出來的，**那時候已經在重試的射程之外**。
 * 結果是 {@link retryDecision} 那一整套政策對這一類失敗**從來沒有被問到** ——
 * 不是判錯，是沒被呼叫到。
 *
 * ## 做法：翻譯投遞方式，不是新增政策
 *
 * 在 fetch 這一層先把第一則事件讀出來。是錯誤物件的話，**不往外拋，而是回一個帶著
 * 供應商原始信封的 HTTP 錯誤回應** —— 於是 SDK 走它本來就有的 HTTP 錯誤路徑，
 * 建出帶 `status` 的 `APIError`，那顆錯誤落在 `AsyncCaller` 的重試迴圈**裡面**。
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
 *    （`core/agent-loop/src/agent.ts:444`）—— **中段才出錯的串流 dsh 照樣重試**。
 *
 * **第三層我們退掉了，而理由不是「重試中段錯誤不值得」。** dsh 付得起那個代價，是因為它
 * 有第一級的載體表示「那一次作廢、這是新的一次」：`assistant/attempt` 事件與
 * `assistantStreamRevision`（`core/agent-loop/src/agent.ts:381-384`、`:446-447`）。
 * **我們沒有那個載體** —— 已經送到畫面上的字沒有地方宣告作廢。所以這裡只涵蓋
 * **第一則事件**就是錯誤的那一類，也就是 #516 實際觀察到的長相。
 *
 * ## 邊界：第一則事件，不是「串流錯誤」
 *
 * 涵蓋的是**串流的第一則 SSE 事件**。判準刻意是事件而不是「第一次網路讀取拿到的位元組」——
 * 後者會隨網路分段漂移（loopback 上整份 body 會被併成一段，量出來的覆蓋率是假的）。
 *
 * **明確未涵蓋**，而且有測試釘住這件事：
 *
 * - 吐了內容之後中段才出錯（第 2 則以後的事件是 error）。
 * - 串流中途斷掉（`ERR_INCOMPLETE_CHUNKED_ENCODING`）。
 *
 * 這兩類今天的行為不變：當場失敗、零重試。要涵蓋它們得買下第三層，那是另一張卡。吐了內容之後
 * **停住**（不是斷掉）也在射程外，那一類由外層的 {@link withStreamIdleTimeout} 接成逾時，同樣不重試。
 *
 * **掛住的連線也不歸這一層管，而那是量出來的不是推的。** 嗅探迴圈在 fetch 裡面 await
 * `read()`，所以「開了線卻不吐位元組」看起來會從重試射程外被搬進射程內。實測兩側的請求數
 * 相同（`live-model.test.ts` 的「開了線卻不吐位元組」那條）：SDK 的計時器從請求開始一直計到
 * fetch 回來，嗅探在 fetch 裡面，所以兩側都被它蓋到；{@link retryDecision} 本來就判它重試。
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
    super(
      `串流閒置逾時：模型吐出內容之後 ${timeoutMs} 毫秒沒有再送任何東西。` +
        '已經送到畫面上的部分作廢不了，所以這一次不重試。',
    );
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
 * `streamIdleTimeoutMs` 300 秒。這裡照做，值沿用同一個 `timeoutMs`（demian 拍板，90 秒）：一個旋鈕
 * 同時管「到第一則事件」與「段與段之間」，同 dsh 只有一個 `streamIdleTimeoutMs`。
 *
 * **只在有人讀的時候計時**：`pull` 才計時，下游讀得慢不算上游閒置——同 dsh 只在 `next()` 裡計時。
 *
 * ## 偏離登記
 *
 * 1. **中段逾時不重試**。dsh 的 `TIMEOUT` 在預設可重試碼裡（`llm/src/retry-policy.ts:18`），由步級
 *    掛點重試整條串流。我們退掉的理由跟 {@link withInbandStreamErrors} 的第三層同一個：沒有載體宣告
 *    「已經送到畫面上的字作廢」。所以這裡拋 {@link StreamIdleTimeoutError}，跟串流中途斷掉走同一條路：
 *    當場失敗、只打一次。**第一則事件之前的逾時照舊重試**（SDK 的計時器，在重試射程內）。
 * 2. **位元組級，不是 chunk 級**。dsh 等的是解析好的一個 chunk；我們在 `fetch` 這一層只看得到位元組，
 *    所以 SSE 的 keep-alive 註解行（`: ping`）也會重新計時。供應商要是只送 keep-alive 不送內容，這一層
 *    擋不到。退到位元組級是因為這是手上最靠近 adapter 的一格（同 {@link withInbandStreamErrors}）。
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
    const reader = response.body.getReader();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watched = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const idle = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new StreamIdleTimeoutError(timeoutMs)), timeoutMs);
        });
        try {
          const next = await Promise.race([reader.read(), idle]);
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        } catch (error: unknown) {
          // 逾時要把底下那條連線放掉；其他錯誤（含使用者中止的 AbortError）原樣往下交，行為同今天。
          if (error instanceof StreamIdleTimeoutError) void reader.cancel(error).catch(() => {});
          controller.error(error);
        } finally {
          clearTimeout(timer);
          timer = undefined;
        }
      },
      cancel(reason) {
        clearTimeout(timer);
        timer = undefined;
        return reader.cancel(reason);
      },
    });
    return new Response(watched, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

/**
 * 真實供應商的 model。
 *
 * key **只從環境變數讀**，缺少時直接失敗，沒有預設值也不 fallback
 * （[docs/standards.md](../../../docs/standards.md) 的秘密處理規則）。
 *
 * @param config - 五個連線值（`settings/live-model.ts`）。**必填，沒有預設參數**（#545）：
 *   一個預設參數會讓「呼叫端忘了傳」跟「設定就是這個」長得一模一樣。產品路徑（CLI、serve）
 *   傳起動期從清單解出來的那一份；eval 與 spike 手上沒有清單，在自己的入口用 schema 預設，
 *   eval 只換 `modelId`（見 [`eval/tiers.ts`](./eval/tiers.ts)）——**除了模型 id，取樣設定、
 *   逾時、金鑰來源完全相同**，否則比的不是模型是設定。
 */
export function createLiveModel(config: LiveModelConfig): ChatOpenAI {
  const apiKey = process.env[LIVE_API_KEY_ENV];
  if (!apiKey) {
    throw new Error(
      `缺少環境變數 ${LIVE_API_KEY_ENV}。真實供應商的 key 只從環境變數讀，` +
        '沒有預設值也不 fallback。把它放進專案根目錄的 .env（該檔已被 .gitignore 排除），' +
        '或在 shell 裡設好；欄位名見 .env.example。',
    );
  }

  return new ChatOpenAI({
    apiKey,
    model: config.modelId,
    // `fetch` 疊兩層：內層是 #516（串流內回報的錯誤翻成 HTTP 錯誤回應，才進得了重試射程），
    // 外層是 #521（第一則事件之後的閒置逾時）。外層收到的是內層嗅完第一則事件的那份回應。
    configuration: {
      baseURL: config.baseUrl,
      fetch: withStreamIdleTimeout(config.timeoutMs, withInbandStreamErrors()),
    },
    temperature: 1,
    topP: 0.95,
    maxTokens: config.maxOutputTokens,
    timeout: config.timeoutMs,
    maxRetries: config.maxRetries,
    onFailedAttempt: classifyFailedAttempt,
  });
}

/**
 * 模型下架了 —— 那句話，原封不動。
 *
 * ## 為什麼要專門認它：`410` 不在基座那份不重試清單裡
 *
 * {@link STATUS_NO_RETRY} 是 `@langchain/core` 那份的複本，成員是
 * `400/401/402/403/404/405/406/407/409/413` —— **`410` 不在裡面**。所以一顆下架的模型
 * 今天會走到 {@link retryDecision} 最後那個 `return 'retry'`，被重試滿
 * {@link DEFAULT_LIVE_MAX_RETRIES} 次。**實測 2026-09-04：`openai/gpt-oss-120b` 的 410 花了
 * 106.7 秒才浮出來**，而它第一次回應就已經確定了。
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
 * 一次失敗要怎麼處置：先分類，再決定重試。
 *
 * **抽成具名的匯出，是為了它測得到。** 它是 `AsyncCaller` 的 `onFailedAttempt`，而
 * 「`AsyncCaller` 到底會不會為一個不可重試的 400 叫它」是這條鏈上唯一還沒量過的一環
 * ——寫成 closure 的話，不打真端點就驗不到。`live-model.test.ts` 拿一個 loopback
 * 假端點把整條走一遍（零憑證、零外部連線）。
 *
 * **下架排在最前面**，因為它是三者裡唯一會被 {@link retryDecision} 判成「重試」的
 * ——排在後面就永遠輪不到（`410` 不在 {@link STATUS_NO_RETRY} 裡，見
 * {@link modelGoneMessage}）。
 *
 * **溢出的分類排在重試決策之前**，因為它換掉的是錯誤的**型別**而不是重試與否：
 * `ContextOverflowError` 建構當下就標成不可重試（`stampRetryable(this, false)`），
 * 而它本來就是個 400，兩條路的重試結論一致。
 *
 * @param error - 這次失敗的錯誤。
 * @throws 要放棄時拋——溢出拋 branded 的那顆，其餘原樣拋。要重試就正常返回。
 */
export function classifyFailedAttempt(error: unknown): void {
  const gone = modelGoneMessage(error);
  if (gone !== undefined) throw new Error(gone, { cause: error });
  if (isDerivedContextOverflow(error)) throw ContextOverflowError.fromError(error as Error);
  if (retryDecision(error) === 'retry') return;
  throw error;
}

/** 專案根目錄的 `.env`（已被 .gitignore 排除）。 */
const ENV_FILE = resolve(import.meta.dirname, '../../../.env');

/**
 * 需要時把根目錄的 `.env` 填進環境變數。
 *
 * **這不是 fallback。** key 一律從環境變數讀（[docs/standards.md](../../../docs/standards.md)），
 * `.env` 只是填充環境變數的其中一種方式：檔案不存在就安靜跳過，缺的變數留給
 * {@link createLiveModel} 當場失敗並指名缺哪一個。已經設好的環境變數不會被檔案蓋掉。
 */
export function loadLiveEnvIfNeeded(): void {
  if (process.env[LIVE_API_KEY_ENV]) return;
  try {
    process.loadEnvFile(ENV_FILE);
  } catch {
    // 沒有 .env 就靠 shell 裡既有的環境變數。
  }
}

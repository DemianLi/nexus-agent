import { resolve } from 'node:path';
import { ContextOverflowError } from '@langchain/core/errors';
import { ChatOpenAI } from '@langchain/openai';

/**
 * Phase 0 的真實供應商接線（issue #31）。
 *
 * 走 NVIDIA 的 OpenAI 相容端點：JS 這邊沒有 NVIDIA 專用的 LangChain 整合
 * （`@langchain/nvidia-ai-endpoints` 只有 Python 版），所以用 `@langchain/openai`
 * 指過去。這裡驗的是接線 —— tool call 的參數回得來、streaming 的事件形狀對得上 ——
 * 不是模型品質；供應商比較在 Phase 2 與 Phase 5（見開發計劃第 7 節決策點 2）。
 */
export const LIVE_BASE_URL = 'https://integrate.api.nvidia.com/v1';

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
 * 硬門檻**：吃不吃得下 {@link LIVE_MAX_OUTPUT_TOKENS} —— 我們每一次呼叫都送它，輸出上限比它
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
 * 這是**預設**的 id：`cli:live` / `serve:live` / `spike:live` 三條路走這個常數，
 * eval 的尺寸比較則把各道階梯的 id 逐一傳進 {@link createLiveModel}。
 */
export const LIVE_MODEL_ID = 'nvidia/nemotron-3-super-120b-a12b';

/** 環境變數名。刻意不叫 `OPENAI_API_KEY`（`@langchain/openai` 的預設），免得這把 key 是誰的變模糊。 */
export const LIVE_API_KEY_ENV = 'NVIDIA_API_KEY';

/**
 * 單一請求的逾時上限。
 *
 * **這不是調校，是止血。** 這個端點的失敗模式是**永遠不回來**（[#57](https://github.com/DemianLi/nexus-agent/issues/57)），
 * 而尺寸比較是一連串請求 —— 沒有上限的話，中間掛住一次換來的是整輪比較沒有結果，
 * 而不是「那一格失敗」。90 秒是量出來的：實測最慢的成功回應是 43 秒
 * （`meta/muse-glimmer-30b`），掛住的那兩個在 90 秒仍是零位元組。
 */
export const LIVE_TIMEOUT_MS = 90_000;

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
export const LIVE_MAX_RETRIES = 6;

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
 */
export const LIVE_MAX_OUTPUT_TOKENS = 16_384;

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
 * 2026-09-04 換掉預設之後（見 {@link LIVE_MODEL_ID}），這條路在預設模型上**逼不出來** ——
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
 * {@link createLiveModel} 建的 client **恆定送 {@link LIVE_MAX_OUTPUT_TOKENS}（正數）**，
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
 * 真實供應商的 model。
 *
 * key **只從環境變數讀**，缺少時直接失敗，沒有預設值也不 fallback
 * （[docs/standards.md](../../../docs/standards.md) 的秘密處理規則）。
 *
 * @param modelId - 要指到哪個模型。省略即 {@link LIVE_MODEL_ID}；尺寸比較把各道階梯的
 *   id 逐一傳進來（見 [`eval/tiers.ts`](./eval/tiers.ts)）。**除了這個參數，取樣設定、
 *   逾時、金鑰來源完全相同** —— 否則比的不是模型是設定。
 */
export function createLiveModel(modelId: string = LIVE_MODEL_ID): ChatOpenAI {
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
    model: modelId,
    configuration: { baseURL: LIVE_BASE_URL },
    temperature: 1,
    topP: 0.95,
    maxTokens: LIVE_MAX_OUTPUT_TOKENS,
    timeout: LIVE_TIMEOUT_MS,
    maxRetries: LIVE_MAX_RETRIES,
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
 * {@link LIVE_MAX_RETRIES} 次。**實測 2026-09-04：`openai/gpt-oss-120b` 的 410 花了
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
      '換掉 LIVE_MODEL_ID（apps/harness/src/live-model.ts）；' +
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

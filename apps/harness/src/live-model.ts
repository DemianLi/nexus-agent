import { resolve } from 'node:path';
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
 * 2026-08-28 定案（開發計劃第 7 節決策點 2）。同一個端點上五個橫階、每階 12 次取樣：
 * **品質打平**（參數正確性 `0.88`–`0.98`，而判準沒有飽和 —— 全距下探到 `0.33`），
 * 所以選型落回成本、延遲、失敗模式，而三個軸都指向這一個：token 最省（平均 8519，
 * 比 Nemotron 那一家的 14049–17414 少四到五成）、多叫次數最低（0.33）、
 * 品質並列第二（離最高的 `super` 差 0.06）。
 *
 * **邊界**：它是「這把 key 叫得動的模型裡最划算的那個」，不是「這是最好的模型」。
 * 候選集合綁在帳號上（`GET /models` 列 84 個，這把 key 只叫得動 29 個、真的支援工具的
 * 14 個），換一把 key 要重新盤點 —— 盤點方法在 [`eval/tiers.ts`](./eval/tiers.ts) 的檔頭。
 *
 * ## 上一個是什麼、為什麼不是它
 *
 * 原本是 `deepseek-ai/deepseek-v4-pro-0813`，而它從來不是被選出來的 —— 它是
 * [#57](https://github.com/DemianLi/nexus-agent/issues/57) 那個「`deepseek-v4-flash-0731`
 * 永遠不回來」的替代品，唯一的判準是「同系列、而且回得出 `finish_reason: tool_calls`」。
 * **它慢**：一次簡單的呼叫約 37 秒。現在有量過的數字了，所以換掉它。
 *
 * 這是**預設**的 id：`cli:live` / `serve:live` / `spike:live` 三條路走這個常數，
 * eval 的尺寸比較則把各道階梯的 id 逐一傳進 {@link createLiveModel}。
 */
export const LIVE_MODEL_ID = 'openai/gpt-oss-120b';

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
    maxTokens: 16384,
    timeout: LIVE_TIMEOUT_MS,
    maxRetries: LIVE_MAX_RETRIES,
    onFailedAttempt: (error) => {
      if (retryDecision(error) === 'retry') return;
      throw error;
    },
  });
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

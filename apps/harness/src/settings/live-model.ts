/**
 * 真實供應商那五個連線值的**設定條目**（[#545](https://github.com/DemianLi/nexus-agent/issues/545)／
 * [#457](https://github.com/DemianLi/nexus-agent/issues/457)）。
 *
 * **這一顆不裝功能，只講設定**，`apply` 是空的，同 `thread-title`／`tool-text` 那幾列。
 * 消費者是 `live-model.ts` 的 `createLiveModel`，只在 `--live` 時才建。
 *
 * ## 與 dsh 的關係：五格都是 dsh 的設定欄位
 *
 * dsh 的 adapter `@deepseek-ai/dsh-llm-deepseek` 的 `Config`（`packages/llm/llm-deepseek/src/config.ts`，
 * `ddefc45`）有 `baseURL`（`:83`）、`maxTokens`（`:86`）、`streamIdleTimeoutMs`（`:89`）、
 * `retryPolicy`（`:100`，形狀在 `packages/llm/llm/src/retry-policy.ts:100`），模型則從設定與型錄選。
 * 所以**可設定本身沒有偏離，寫死才是**——跟 `tool-text` 那一列同一句話。
 *
 * 「調它會壞」的顧慮（`live-model.ts` 各常數的檔頭記著那些數字是怎麼量出來的），dsh 的答法
 * 不是不給旋鈕，是**給有邊界的旋鈕、量出來的值當 schema 預設**。這裡照做：測量留在原檔頭，
 * 常數改叫 `DEFAULT_LIVE_*`，讀的人一眼看得出它只是預設值。
 *
 * ## 偏離一：逐次請求解析，退到起動期解一次
 *
 * dsh 那一列的註解是「No key or endpoint is inlined: both resolve per request」
 * （`packages/bundle/base/cordis.patch.yml:507-510`）。**`@langchain/openai` 1.5.10 的 `ChatOpenAI`
 * 表達不出來**：client 懶建一次就快取在實例上（`dist/chat_models/base.cjs:309-319`），端點與逾時
 * 凍在那顆 client 裡；模型 id 寫死 `model: this.model`（`dist/chat_models/completions.cjs:29`），
 * 不看 per-call options。逐次換只能每次重建實例。
 *
 * 所以退到 `startupSetting`：起動期解一次、往下傳一份，同 `#settings/…` 那幾列
 * （[#529](https://github.com/DemianLi/nexus-agent/issues/529) 的 A2）。**這一條與 `live-model.ts`
 * 裡 `DEFAULT_LIVE_MAX_RETRIES` 檔頭登記的「要對齊 dsh 的有界退避得自己包一層 caller」是同一層
 * 的工**——哪天包了那一層，逐次解析跟有界退避一起做。key 的讀取時刻（dsh 逐次請求從 credential
 * store 取，我們建構時從 `NVIDIA_API_KEY` 讀一次）同源，不在這一列。
 *
 * ## 偏離二：重試只有次數，而且次數有上限
 *
 * dsh 的 `retryPolicy` 有 `initialDelayMs`／`maxDelayMs`／`jitterRatio`。`AsyncCaller` 只收
 * `maxRetries` 與 `onFailedAttempt`，退避寫死在 `callWithRetries` 裡，所以這裡只有 `maxRetries`。
 *
 * **dsh 的次數上限是 `Number.MAX_SAFE_INTEGER`，我們不能照抄**，因為那個上限安全的前提是退避
 * 有界（`maxDelayMs`）。我們的退避是 p-retry 的 `factor 2`、`minTimeout 1s`、**`maxTimeout` 無限**
 * （`@langchain/core` 的 `dist/utils/p-retry/index.js:91-93`），第 k 次重試前等 `2^(k−1) × [1, 2]`
 * 秒。n 次重試的累計等待：
 *
 * | `maxRetries` | 累計等待 |
 * | --- | --- |
 * | 6（預設） | 63–126 秒 |
 * | 8 | 4.3–8.5 分鐘 |
 * | 10（上限） | 17–34 分鐘 |
 * | 11 | 34–68 分鐘 |
 *
 * **10 是挑的，不是量的**：算式是量得到的，「一次呼叫最多安靜多久還算可以接受」不是。挑在
 * 半小時這個量級，是因為再往上一格，一次呼叫就可能安靜超過一小時才浮出錯誤。
 *
 * ## 偏離三：逾時語意不同，所以欄位名不照抄
 *
 * dsh 的 `streamIdleTimeoutMs` 是串流**閒置**逾時，每一段重新計時。我們的 `timeoutMs` 同一個值管兩段
 * （[#521](https://github.com/DemianLi/nexus-agent/issues/521)）：
 *
 * - **連線到第一則事件**：`ChatOpenAI` 的 `timeout`，交給 openai SDK 的 `setTimeout(abort, ms)`
 *   （`openai@7.5.0` 的 `client.js`，`fetchWithTimeout`）。計時器在 fetch 回來時清掉，而 #516 那層
 *   在 fetch 裡讀完第一則事件才回。這一段在重試射程內。
 * - **第一則事件之後，段與段之間**：`live-model.ts` 的 `withStreamIdleTimeout`，每一段重新計時，
 *   時間到不重試（已經送到畫面上的字作廢不了）。
 *
 * 非串流（CLI 的 `invoke`）那條，SDK 讀整份 body 時計時器還在，所以是整個請求的逾時。
 * 名字不照抄 `streamIdleTimeoutMs`，因為第一段語意仍不同：它從請求開始算到第一則事件，中間收到
 * 位元組（例如標頭）也不重新計時，dsh 則每一段都重新計時。上限照 dsh 的 `MAX_TIMER_DELAY_MS`
 * （`packages/util/timeout/src/index.ts:25`），理由相同：超過 2 147 483 647 的延遲 Node 會當成
 * 1 毫秒，「調得很寬」會變成「立刻逾時」。
 *
 * ## `maxOutputTokens` 與 `modelId` 是綁著的
 *
 * dsh 由型錄裡「模型自己的上限」蓋過設定值（`config.ts:36` 的註解：「a model's own cap and
 * explicit request values win」），**我們沒有型錄**。所以耦合還在：`DEFAULT_LIVE_MODEL_ID` 是用
 * 「吃不吃得下 `DEFAULT_LIVE_MAX_OUTPUT_TOKENS`」當淘汰門檻選出來的，**換其中一個之前要拿另一個
 * 重新確認**——吃不下的模型會每一次呼叫都失敗，沒有任何測試會紅。
 *
 * **`maxOutputTokens` 的下限 1 是承重的**：`live-model.ts` 的 `isDerivedContextOverflow` 唯一的
 * 前提是我們送出去的輸出上限恆為正數（那樣伺服器回來的負值才只可能是它自己導出來的）。
 *
 * ## 換 `modelId` 今天碰不到 harness profile 那道檢查
 *
 * 組裝點會比對基座按模型查到的 harness profile 與宣告的是否一致（`harness-profile.ts` 的
 * `assertHarnessProfileDeclared`）。**今天換哪一個 id 都過得了**：`ChatOpenAI` 把型號存在
 * `model` 而不是 `model_name`／`modelName`，查詢鍵湊不出型號（`harness-profile.ts` 的
 * `identifierHint` 檔頭）。哪天欄位補齊，換成一顆基座登記過 profile 的模型就會在**組裝期**
 * 失敗並印出該填的宣告——那是那道檢查的本意，不是這一列的缺陷。
 *
 * ## 端點的規則照 dsh
 *
 * dsh 的 resolve 那一步擋非 HTTP(S)、帳密、query、fragment，**`http:` 明確放行**
 * （`config.ts:295-298`）。dsh 只在它的 messages 協定上做這個檢查，chat-completions 那條不驗；
 * 我們對應的是 chat-completions，但照樣套用：URL 帶帳密就是把 key 寫進設定，而 dsh 自己那一列
 * 的註解說 key 不內嵌。
 *
 * ## 這一列關不掉
 *
 * `disabled: true` 在載入期當場拋，理由同起動期那幾列：`startupSetting` 把關掉的那一列當成
 * 沒有那一列，值回到 schema 的預設，看起來像關掉了什麼，實際上什麼都沒變。
 *
 * ## eval 不跟這一列走
 *
 * `eval/*` 與 `spike/*` 手上沒有條目清單，它們在自己的入口用 schema 預設（eval 只換 `modelId`）。
 * 那是刻意的：它們量的是出貨預設那一組設定底下的模型，不是某一台部署的設定。
 *
 * @module
 */

import { z } from 'zod';

import type { NexusPlugin, PluginRegistry } from '@nexus/core';

import {
  DEFAULT_LIVE_BASE_URL,
  DEFAULT_LIVE_MAX_OUTPUT_TOKENS,
  DEFAULT_LIVE_MAX_RETRIES,
  DEFAULT_LIVE_MODEL_ID,
  DEFAULT_LIVE_TIMEOUT_MS,
} from '../live-model.js';

/** 這一列在訊息裡叫什麼。 */
export const LIVE_MODEL_PLUGIN_NAME = 'live-model';

/** 逾時的上限：Node 計時器收得住的最大延遲，見檔頭「偏離三」。 */
export const MAX_LIVE_TIMEOUT_MS = 2_147_483_647;

/** 重試次數的上限，見檔頭「偏離二」。 */
export const MAX_LIVE_RETRIES = 10;

/**
 * 是不是一個 HTTP(S) 的根：擋帳密、query、fragment。規則照 dsh，見檔頭「端點的規則照 dsh」。
 *
 * @param value - 要驗的端點。
 * @returns 合不合格。
 */
function isHttpRoot(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (
    (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.search === '' &&
    parsed.hash === ''
  );
}

/** 五格。`strictObject`：多寫一個欄位是打錯字，不是擴充點。 */
export const liveModelConfigSchema = z.strictObject({
  /** OpenAI 相容端點的根。 */
  baseUrl: z
    .string()
    .refine(isHttpRoot, '端點要是 http: 或 https: 的網址，不能帶帳密、query 或 fragment')
    .default(DEFAULT_LIVE_BASE_URL),
  /** 模型 id。換它之前先讀檔頭「`maxOutputTokens` 與 `modelId` 是綁著的」。 */
  modelId: z.string().min(1).default(DEFAULT_LIVE_MODEL_ID),
  /** 每一次呼叫送出去的 `max_tokens`。下限 1 是承重的，見檔頭。 */
  maxOutputTokens: z.number().int().min(1).default(DEFAULT_LIVE_MAX_OUTPUT_TOKENS),
  /** 單一請求的逾時（毫秒）。 */
  timeoutMs: z.number().int().min(1).max(MAX_LIVE_TIMEOUT_MS).default(DEFAULT_LIVE_TIMEOUT_MS),
  /** 被限流時最多重試幾次。 */
  maxRetries: z.number().int().min(0).max(MAX_LIVE_RETRIES).default(DEFAULT_LIVE_MAX_RETRIES),
});

/** 驗過的設定。 */
export type LiveModelConfig = z.infer<typeof liveModelConfigSchema>;

/** 只講設定的那一顆，見檔頭。 */
export const liveModelPlugin: NexusPlugin<LiveModelConfig> = {
  name: LIVE_MODEL_PLUGIN_NAME,
  Config: liveModelConfigSchema,
  apply: (_registry: PluginRegistry, _config: LiveModelConfig): void => {
    // 空的，見檔頭：組裝期沒有消費者。
  },
};

export default liveModelPlugin;

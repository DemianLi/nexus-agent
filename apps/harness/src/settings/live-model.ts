/**
 * 真實供應商的連線值與**模型型錄**的設定條目（[#545](https://github.com/DemianLi/nexus-agent/issues/545)／
 * [#457](https://github.com/DemianLi/nexus-agent/issues/457)／[#729](https://github.com/DemianLi/nexus-agent/issues/729)）。
 *
 * **這一顆不裝功能，只講設定**，`apply` 是空的，同 `thread-title`／`tool-text` 那幾列。
 * 消費者是 `live-model.ts` 的 `createLiveModel`，只在 `--live` 時才建。
 *
 * ## 與 dsh 的關係：連線值是 dsh 的設定欄位，型錄照 `llm-pi-ai`
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
 * 的工**——哪天包了那一層，逐次解析跟有界退避一起做。key 不在這一列：它已經是逐次請求解析
 * （[#730](https://github.com/DemianLi/nexus-agent/issues/730)，`credentials.ts`），跟這裡的「起動期解一次」是兩件事。
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
 *   時間到整次重打（偏離五）。
 *
 * 非串流（CLI 的 `invoke`）那條，SDK 讀整份 body 時計時器還在，所以是整個請求的逾時。
 * 名字不照抄 `streamIdleTimeoutMs`，因為第一段語意仍不同：它從請求開始算到第一則事件，中間收到
 * 位元組（例如標頭）也不重新計時，dsh 則每一段都重新計時。上限照 dsh 的 `MAX_TIMER_DELAY_MS`
 * （`packages/util/timeout/src/index.ts:25`），理由相同：超過 2 147 483 647 的延遲 Node 會當成
 * 1 毫秒，「調得很寬」會變成「立刻逾時」。
 *
 * ## 型錄：輸出上限、窗口、收不收圖、怎麼關推理都跟著模型走（#729）
 *
 * dsh 由型錄裡「模型自己的上限」蓋過設定值（`packages/llm/llm-deepseek/src/config.ts:36` 的註解：「a model's own
 * cap and explicit request values win」）；`llm-pi-ai` 則把型錄寫成設定：每條路由帶 `models` 清單，**整份取代**那條
 * 路由的型錄，不逐筆合併（`packages/llm/llm-pi-ai/README.md:99`）。我們照 `llm-pi-ai` 的形狀寫成這一列的 `models`
 * 欄位，形狀與逐欄的差異在 `model-catalog.ts` 的檔頭。
 *
 * - **`modelId` 必須在 `models` 裡**，不在就是載入期失敗，訊息指名 id（那一列的名字由 `startupSetting` 加上）。
 *   換 `modelId` 之前，先確認新那一筆的 `maxTokens` 吃得下：這顆預設模型是拿「吃不吃得下 16384」當淘汰門檻選出來的，
 *   吃不下的模型會每一次呼叫都失敗，沒有任何測試會紅。
 * - **`models` 是整份替換。** patch 只想改預設那一筆的 `maxTokens` 也要把整筆（連 `reasoningEfforts` 與 `compat`）
 *   重述，沒重述的欄位不會回到出貨值。
 * - **`maxTokens` 的下限 1 是承重的**：`live-model.ts` 的 `isDerivedContextOverflow` 唯一的前提是我們送出去的輸出
 *   上限恆為正數（那樣伺服器回來的負值才只可能是它自己導出來的）。
 * - **標題那一顆的輸出上限不看型錄**，看 `thread-title-llm` 那一列（`cli.ts` 的 `titleLlmFor` 明著傳進 `createLiveModel`）。
 *
 * **摘要門檻不跟型錄走**：`DEFAULT_SUMMARIZATION` 仍是絕對值 `100_000`，按量過最小那顆的窗口挑；型錄的
 * `contextWindow` 今天沒有消費者。
 *
 * ## 換 `modelId` 不會碰到基座的 harness profile
 *
 * 基座的 `createDeepAgent` 會按模型查一份 harness profile 並改寫組裝；自有組裝點
 * （`@nexus/core` 的 `assembleAgent`）**不套 profile**，所以換哪一個 id 組成都不變。
 * （以前組裝點有一道「宣告」檢查擋這件事，隨 `harness-profile.ts` 一起拿掉了。）
 *
 * ## 端點的規則照 dsh
 *
 * dsh 的 resolve 那一步擋非 HTTP(S)、帳密、query、fragment，**`http:` 明確放行**
 * （`config.ts:295-298`）。dsh 只在它的 messages 協定上做這個檢查，chat-completions 那條不驗；
 * 我們對應的是 chat-completions，但照樣套用：URL 帶帳密就是把 key 寫進設定，而 dsh 自己那一列
 * 的註解說 key 不內嵌。
 *
 * ## 偏離四：標題要關推理，由 `createLiveModel` 依用途帶型錄條目的寫法
 *
 * 兩半各有 dsh 出處：
 *
 * - **「怎麼關推理」放在型錄條目**（`off` 那一級加 `compat.chatTemplateKwargs`）：照 `llm-pi-ai` 的形狀
 *   （`packages/llm/llm-pi-ai/src/catalog.ts:389-396`、`:600-607`）。寫法跟模型 id 一起換，所以住在同一筆。
 * - **「標題要關推理」依用途在程式裡決定**：照 dsh 的 DeepSeek adapter 對 `purpose: 'session-title'` 在程式裡關思考
 *   （`packages/llm/llm-deepseek/src/serialize.ts:146`，`477b4f4`）；`llm-pi-ai` 自己不因用途關推理。標題程式只表明
 *   用途，由 `createLiveModel` 決定帶什麼（[#650](https://github.com/DemianLi/nexus-agent/issues/650)）。
 *
 * **偏離的一格**：pi-ai 在非 `off` 的等級底下會把 `thinking.enabled` 解成 `true` 一併送出，我們的主請求不送
 * `chat_template_kwargs`（今天的送法）。沒有量過兩者等價——這台機器沒有 key，量不了——所以保留今天的送法，見
 * `model-catalog.ts` 檔頭。量測與寫法在 `live-model.ts` 的 `DEFAULT_LIVE_MODEL_ENTRY`。
 *
 * ## 偏離五：串流中段的失敗整次重打（[#520](https://github.com/DemianLi/nexus-agent/issues/520)）
 *
 * dsh 的 `TIMEOUT`、`TRANSPORT`、`SERVER` 都在預設可重試碼裡（`packages/llm/llm/src/retry-policy.ts:18-24`），中段失敗照樣整次重打，
 * 靠的是 `assistant/attempt` 這個載體宣告「那一次作廢」。我們同向：`@nexus/core` 的 `stream-retry.ts` 整次重打、日誌多一顆
 * `assistant/attempt`、web 收到 `message-discard` 擦掉作廢的那一則。**退避的形狀照 dsh**：倍增、`maxDelayMs` 封頂 10 秒、
 * `jitterRatio` 0.1（`:14-17`，`5badb15009a`），次數沒有另設上限（同 dsh，安全靠單次等待有界）。**只有兩個起始值不照抄**：
 * 預設 2 次、1 秒起（dsh 是 5 次、500 毫秒），因為每次重打都重付整個回覆的費用；那是 #520 卡上 2026-10-06 拍板的，欄位都能調。
 * 第一則事件**之前**的失敗不歸這一格管：SDK 層用 `maxRetries`（偏離二，p-retry 的退避，**不是同一套**——那一層 `AsyncCaller`
 * 只收次數、退避寫死，帶不進 dsh 的上限與抖動）已經重試過，這裡再接就是乘法。
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

import { DEFAULT_STREAM_RETRY_JITTER_RATIO, DEFAULT_STREAM_RETRY_MAX_DELAY_MS } from '@nexus/core';
import type { NexusPlugin, PluginRegistry } from '@nexus/core';

import {
  DEFAULT_LIVE_BASE_URL,
  DEFAULT_LIVE_MAX_RETRIES,
  DEFAULT_LIVE_MODEL_ENTRY,
  DEFAULT_LIVE_MODEL_ID,
  DEFAULT_LIVE_TIMEOUT_MS,
} from '../live-model.js';
import { findModelEntry, modelCatalogSchema } from '../model-catalog.js';
import type { ModelEntry } from '../model-catalog.js';

/** 這一列在訊息裡叫什麼。 */
export const LIVE_MODEL_PLUGIN_NAME = 'live-model';

/** 逾時的上限：Node 計時器收得住的最大延遲，見檔頭「偏離三」。 */
export const MAX_LIVE_TIMEOUT_MS = 2_147_483_647;

/** 重試次數的上限，見檔頭「偏離二」。 */
export const MAX_LIVE_RETRIES = 10;

/** 出廠的串流中段重打次數，見檔頭「偏離五」。 */
export const DEFAULT_STREAM_RETRY_MAX = 2;
/** 出廠的串流中段重打退避起點（毫秒），之後每次加倍。 */
export const DEFAULT_STREAM_RETRY_BASE_MS = 1_000;

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

/** 六格。`strictObject`：多寫一個欄位是打錯字，不是擴充點。 */
export const liveModelConfigSchema = z
  .strictObject({
    /** OpenAI 相容端點的根。 */
    baseUrl: z
      .string()
      .refine(isHttpRoot, '端點要是 http: 或 https: 的網址，不能帶帳密、query 或 fragment')
      .default(DEFAULT_LIVE_BASE_URL),
    /** 用哪一顆模型。必須是 `models` 裡的一筆，見檔頭「型錄」。 */
    modelId: z.string().min(1).default(DEFAULT_LIVE_MODEL_ID),
    /** 模型型錄，**整份取代**，見檔頭「型錄」。省略即出廠那一筆。 */
    models: modelCatalogSchema.default(() => [structuredClone(DEFAULT_LIVE_MODEL_ENTRY)]),
    /** 單一請求的逾時（毫秒）。 */
    timeoutMs: z.number().int().min(1).max(MAX_LIVE_TIMEOUT_MS).default(DEFAULT_LIVE_TIMEOUT_MS),
    /** 被限流時最多重試幾次。 */
    maxRetries: z.number().int().min(0).max(MAX_LIVE_RETRIES).default(DEFAULT_LIVE_MAX_RETRIES),
    /**
     * 串流**第一則事件之後**才出錯（中段錯誤、斷線、停住）的整次重打，見檔頭「偏離五」與 `@nexus/core` 的 `stream-retry.ts`。
     * `maxRetries: 0` 就是不重打，回到只打一次。
     */
    streamRetry: z
      .strictObject({
        /** 最多重打幾次（不含第一次）。沒有另外的上限，同 dsh：安全靠的是下面單次等待有界。 */
        maxRetries: z.number().int().min(0).default(DEFAULT_STREAM_RETRY_MAX),
        /** 第一次重打前等多久（毫秒），之後每次加倍。 */
        baseDelayMs: z
          .number()
          .int()
          .min(0)
          .max(MAX_LIVE_TIMEOUT_MS)
          .default(DEFAULT_STREAM_RETRY_BASE_MS),
        /** 單次等待的上限（毫秒），照 dsh 的 `maxDelayMs`。 */
        maxDelayMs: z
          .number()
          .int()
          .min(0)
          .max(MAX_LIVE_TIMEOUT_MS)
          .default(DEFAULT_STREAM_RETRY_MAX_DELAY_MS),
        /** 抖動比例，照 dsh 的 `jitterRatio`。 */
        jitterRatio: z.number().min(0).max(1).default(DEFAULT_STREAM_RETRY_JITTER_RATIO),
      })
      .default(() => ({
        maxRetries: DEFAULT_STREAM_RETRY_MAX,
        baseDelayMs: DEFAULT_STREAM_RETRY_BASE_MS,
        maxDelayMs: DEFAULT_STREAM_RETRY_MAX_DELAY_MS,
        jitterRatio: DEFAULT_STREAM_RETRY_JITTER_RATIO,
      })),
  })
  .superRefine((config, context) => {
    if (findModelEntry(config.models, config.modelId) !== undefined) return;
    const known = config.models.map((entry) => entry.id).join('、');
    context.addIssue({
      code: 'custom',
      path: ['modelId'],
      message: `模型 "${config.modelId}" 不在 models 型錄裡（型錄有：${known === '' ? '（空的）' : known}）`,
    });
  });

/** 驗過的設定。 */
export type LiveModelConfig = z.infer<typeof liveModelConfigSchema>;

/**
 * eval 與 spike 用的設定：出廠那一組，只換模型 id（`eval/*` 逐階傳各道階梯的 id，見 `eval/tiers.ts`）。
 *
 * 那些 id 多半不在出廠型錄裡，所以型錄裡沒有的就**合成一筆**：輸出上限沿用出廠那一筆（比較的是模型、不是設定），
 * 窗口取量過最小那顆的下限 131,007。這一筆只給 eval 用，產品路徑不走這裡。
 *
 * @param modelId - 要比的模型 id。
 * @returns 解好的設定。
 */
export function liveModelConfigForModel(modelId: string): LiveModelConfig {
  const defaults = liveModelConfigSchema.parse({});
  if (findModelEntry(defaults.models, modelId) !== undefined) {
    return liveModelConfigSchema.parse({ modelId });
  }
  const synthesized: ModelEntry = {
    id: modelId,
    contextWindow: 131_007,
    maxTokens: DEFAULT_LIVE_MODEL_ENTRY.maxTokens,
  };
  return liveModelConfigSchema.parse({ modelId, models: [...defaults.models, synthesized] });
}

/** 只講設定的那一顆，見檔頭。 */
export const liveModelPlugin: NexusPlugin<LiveModelConfig> = {
  name: LIVE_MODEL_PLUGIN_NAME,
  Config: liveModelConfigSchema,
  apply: (_registry: PluginRegistry, _config: LiveModelConfig): void => {
    // 空的，見檔頭：組裝期沒有消費者。
  },
};

export default liveModelPlugin;

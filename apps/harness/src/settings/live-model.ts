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
 * （[#529](https://github.com/DemianLi/nexus-agent/issues/529) 的 A2）。key 不在這一列：它已經是逐次請求解析
 * （[#730](https://github.com/DemianLi/nexus-agent/issues/730)，`credentials.ts`），跟這裡的「起動期解一次」是兩件事。
 * 重試政策（偏離二）同樣在起動期解一次、進組裝點的那一份；退避與次數的有界性已經由 `retryModelCall` 自己守，不再依賴
 * 「自己包一層 caller」。
 *
 * ## 偏離二：重試只有一層，`mode: 'always'` 拒收（[#1427](https://github.com/DemianLi/nexus-agent/issues/1427)）
 *
 * **形狀與驗證逐條照 dsh**（`packages/llm/llm/src/retry-policy.ts` 的 `resolveRetryPolicy`／`resolveBackoff`）：
 * `retryPolicy: { mode, maxRetries, retryableCodes, backoff: { initialDelayMs, maxDelayMs, jitterRatio } }`。整個不寫就是
 * normal 的預設值，寫了就必填 `mode`；`maxRetries` 是非負安全整數、**不設上限**（同 dsh：安全靠單次等待有界）；
 * `initialDelayMs` 大於 0、不超過 `MAX_TIMER_DELAY_MS`、不大於 `maxDelayMs`；`jitterRatio` 在 0 到 1；`retryableCodes` 不能
 * 是空陣列、不能有空字串、不能重複；未知欄位拒收。
 *
 * **重試只有 `@nexus/core` 的 `retryModelCall` 這一層**：SDK 的 `AsyncCaller` `maxRetries` 恆為 0（`live-model.ts`
 * 的 `onFailedAttempt` 只做分類與回報）。以前兩層各算各的（SDK 6 次＋串流中段 2 次），同一個情境最壞 (1+6)×(1+2) 次請求、
 * 第 4 次起 `llm/retry` 還被吞掉（`.docs/wrapmodelcall-bridge-gaps-2026-10-11.md` G4）。現在首事件之前與之後共用這一份預算，
 * 打到端點的請求數就是 `maxRetries + 1`，`llm/retry` 的顆數就是實際重打的次數。標題、摘要器生摘要、eval、spike 也吃同一份
 * （`retryModelCall` 直接呼叫，沒有日誌就不寫 `llm/retry`）。
 *
 * **出廠值**（demian 2026-10-14 拍板，不是偏離）：`maxRetries` 6、`initialDelayMs` 500、`maxDelayMs` 10000、
 * `jitterRatio` 0.1、`retryableCodes` 是 dsh 的預設五個碼。dsh 的預設是 5 次；6 次不計抖動的累計等待約 25.5 秒（0.5＋1＋2＋4＋8＋10），
 * 蓋得過 2026-08-28 量到的 16 秒限流窗口。**那次量的是 `openai/gpt-oss-120b`，出貨的 nemotron 沒量過**，所以這個數字是
 * 「蓋過已知窗口」不是「量過這顆」。代價：串流中段失敗最壞重付 6 次整個回覆。
 *
 * **碼對得上我們的分類**（`live-model.ts` 的 `classifyLlmFailure`）：429（含沒帶 header 的）→ `RATE_LIMIT`、其他 HTTP 狀態 →
 * `SERVER`、逾時 → `TIMEOUT`、沒有狀態的連線問題 → `TRANSPORT`。`EMPTY_RESPONSE` 今天沒有生產者（沒有「空回覆就重打」的
 * 路徑），收在清單裡只為形狀與 dsh 一致。放棄的那幾類（401／403／402／配額、4xx、上下文溢出、410 下架）不經過回報，所以
 * `retryableCodes` 擋的是「分類出來的碼」，不是替它們翻案。
 *
 * **與 dsh 行為對齊的幾條**：`retry-after` 不超過 `maxDelayMs` 就照它等（不加抖動）、超過就放棄；抖動之後再夾到
 * `maxDelayMs`；**沒帶 header 的 429 照樣重試**（基座的預設 handler 會把它當容量不足放棄）。
 *
 * **偏離：`mode` 只收 `normal`，`always` 拒收。** dsh 的 `always` 對每一次失敗無限重試。我們是企業內部聊天機器人，一輪沒有
 * 盡頭，中段失敗每次都重付整個回覆，無限重試會無限重付。理由類別是**產品需求超出 dsh**。**撤除條件**：demian 提出需要無限
 * 重試的情境。也登記在 `docs/plugin-contract.md` 的偏離表。
 *
 * **舊欄位（頂層 `maxRetries`、`streamRetry`）大聲失敗**，不自動轉換：兩個舊數字沒有無損的合併方式（見
 * `legacyRetryKeysMessage`）。`--live` 起不來並指名這一列；寫入口 `plugin config set live-model` 整份替換可以改，
 * 但**寫在 `--patch` 檔裡的舊值寫入口蓋不掉**，使用者要自己改那個檔。
 *
 * ## 偏離三：逾時拆兩格，第一格語意與 dsh 不同所以欄位名不照抄
 *
 * dsh 的 `llm-pi-ai` 有兩格：`timeoutMs`（SDK 請求逾時）與 `streamIdleTimeoutMs`（串流閒置，預設 300 秒；
 * `llm-pi-ai/src/config.ts:160-166`、`:342-343`、`:47`，`5badb15`）。我們原本只有一個 `timeoutMs` 同一個值管
 * 兩段（[#521](https://github.com/DemianLi/nexus-agent/issues/521)），[#1251](https://github.com/DemianLi/nexus-agent/issues/1251)
 * 拆回兩格，欄位名與 dsh 一致：
 *
 * - **`timeoutMs`（預設 180 秒）= 連線到第一則事件**：`ChatOpenAI` 的 `timeout`，交給 openai SDK 的
 *   `setTimeout(abort, ms)`（`openai@7.5.0` 的 `client.js`，`fetchWithTimeout`）。計時器在 fetch 回來時清掉，
 *   而 #516 那層在 fetch 裡讀完第一則事件才回。這一段在重試射程內。視覺模型要先吃圖才吐第一則事件
 *   （`meta/llama-3.2-90b-vision-instruct` 實測 133 秒），所以比閒置那格寬。
 * - **`streamIdleTimeoutMs`（預設 90 秒）= 第一則事件之後，段與段之間**：`live-model.ts` 的
 *   `withStreamIdleTimeout`，每一段重新計時，時間到整次重打（偏離五）。值是 demian 拍板的 90 秒，比 dsh 的
 *   300 秒緊，理由在 `DEFAULT_LIVE_STREAM_IDLE_TIMEOUT_MS`。
 *
 * **舊設定怎麼辦**：`timeoutMs` 這個名字保留，語意縮成只管第一段。兩格各有預設，沒有「只設一格另一格跟著走」的
 * 隱含連動（連動會讓「只想放寬首事件」的人順便放寬了閒置，反之亦然）。出廠的 `cordis.yml` 沒寫 `timeoutMs`
 * 以外的值，所以只有自己在 `cordis.yml` 寫過 `timeoutMs` 的人會遇到差異：首事件那一側照他寫的值，閒置那一側
 * 變成 90 秒——寫的值小於 90 秒的人閒置變寬，大於 90 秒的人閒置變緊；要維持舊行為就把同一個值也寫到
 * `streamIdleTimeoutMs`。
 *
 * 非串流（CLI 的 `invoke`）那條，SDK 讀整份 body 時計時器還在，所以 `timeoutMs` 是整個請求的逾時。
 * `timeoutMs` 的名字雖然與 dsh 同名，語意仍不同：它從請求開始算到第一則事件，中間收到位元組（例如標頭）也不重新
 * 計時。兩格的上限照 dsh 的 `MAX_TIMER_DELAY_MS`（`packages/util/timeout/src/index.ts:25`），理由相同：超過
 * 2 147 483 647 的延遲 Node 會當成 1 毫秒，「調得很寬」會變成「立刻逾時」。
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
 * `assistant/attempt`、web 收到 `message-discard` 擦掉作廢的那一則。**政策與首事件之前共用**（偏離二，#1427）：同一份次數、
 * 同一套退避，沒有第二層。
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

import {
  DEFAULT_STREAM_RETRYABLE_CODES,
  DEFAULT_STREAM_RETRY_JITTER_RATIO,
  DEFAULT_STREAM_RETRY_MAX_DELAY_MS,
} from '@nexus/core';
import type { NexusPlugin, PluginRegistry, StreamRetryOptions } from '@nexus/core';

import {
  DEFAULT_LIVE_BASE_URL,
  DEFAULT_LIVE_MODEL_ENTRY,
  DEFAULT_LIVE_MODEL_ID,
  DEFAULT_LIVE_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_LIVE_TIMEOUT_MS,
} from '../live-model.js';
import { findModelEntry, modelCatalogSchema } from '../model-catalog.js';
import type { ModelEntry } from '../model-catalog.js';

/** 這一列在訊息裡叫什麼。 */
export const LIVE_MODEL_PLUGIN_NAME = 'live-model';

/** 逾時的上限：Node 計時器收得住的最大延遲，見檔頭「偏離三」。 */
export const MAX_LIVE_TIMEOUT_MS = 2_147_483_647;

/**
 * 出廠的重試次數（[#1427](https://github.com/DemianLi/nexus-agent/issues/1427)，demian 2026-10-14 拍板）。
 *
 * **取 6，是為了蓋過 2026-08-28 量到的 16 秒限流窗口**：不計抖動的累計等待是 0.5＋1＋2＋4＋8＋10 秒 ≈ 25.5 秒。
 * dsh 的預設是 5 次（累計約 15.5 秒，剛好卡在窗口邊上），6 是 dsh 的 `retryPolicy` 本來就開放的設定值，不是偏離。
 * **那次量的是 `openai/gpt-oss-120b`，出貨的 nemotron 沒量過。**
 */
export const DEFAULT_RETRY_MAX_RETRIES = 6;
/** 出廠的退避起點（毫秒），之後每次加倍。dsh 的預設（`retry-policy.ts:15`）。 */
export const DEFAULT_RETRY_INITIAL_DELAY_MS = 500;

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

/** 這一列拿掉的兩個欄位（#1427）：舊的兩套重試預算。 */
const LEGACY_RETRY_KEYS: ReadonlySet<string> = new Set(['maxRetries', 'streamRetry']);

/**
 * 舊欄位被拒收時的訊息（#1427）：指名舊欄位、新欄位，並講清楚兩邊語意不同。
 *
 * **不自動轉換，也不靜靜忽略**：兩個舊數字（首事件前、中段各自計數）合成一個新數字沒有無損的對應方式，不論取大、取和還是只取
 * 一個，都是替使用者做決定、結果又看不出來。拒收讓 `--live` 起不來並指名這一列（必掛名單，`startup-audit.ts`），由使用者
 * 照語意自己決定新的次數。
 */
function legacyRetryKeysMessage(found: readonly string[]): string {
  const named = found.map((key) => `\`${key}\``).join('、');
  return (
    `${named} 已經拿掉（#1427）：首事件之前與之後的失敗合成一條重試政策，改寫成 ` +
    "`retryPolicy: { mode: 'normal', maxRetries, retryableCodes, backoff: { initialDelayMs, maxDelayMs, jitterRatio } }`。" +
    '語意不同，不會自動轉換：舊的頂層 `maxRetries`（預設 6）只管第一則事件之前、`streamRetry.maxRetries`（預設 2）只管之後，' +
    '各自計數；新的 `retryPolicy.maxRetries` 是一個數字兩段一起管（預設 6），退避 500 毫秒起、倍增、封頂 10 秒、抖動 0.1。' +
    '請依新的語意自己決定次數（`config set live-model` 整份替換，或改你的 `--patch` 檔）。'
  );
}

const retryBackoffSchema = z
  .strictObject({
    /** 第一次重打前等多久（毫秒），之後每次加倍。dsh：大於 0、不超過計時器上限、不大於 `maxDelayMs`。 */
    initialDelayMs: z
      .number()
      .gt(0)
      .max(MAX_LIVE_TIMEOUT_MS)
      .default(DEFAULT_RETRY_INITIAL_DELAY_MS),
    /** 單次等待的上限（毫秒），**供應商給的 `retry-after` 超過它就放棄**（dsh 的 normal 模式）。 */
    maxDelayMs: z
      .number()
      .gt(0)
      .max(MAX_LIVE_TIMEOUT_MS)
      .default(DEFAULT_STREAM_RETRY_MAX_DELAY_MS),
    /** 抖動比例，0 到 1。 */
    jitterRatio: z.number().min(0).max(1).default(DEFAULT_STREAM_RETRY_JITTER_RATIO),
  })
  .refine((backoff) => backoff.initialDelayMs <= backoff.maxDelayMs, {
    path: ['initialDelayMs'],
    message: 'initialDelayMs 不能大於 maxDelayMs（dsh 的 resolveBackoff 同一條）',
  });

/** `mode` 只收 `normal`；`always` 的拒收理由登記在檔頭「偏離二」。 */
function retryModeError(issue: { readonly input?: unknown }): string {
  if (issue.input === undefined) {
    return "retryPolicy 寫了就要寫 mode: 'normal'（整個不寫 retryPolicy 就是預設值）";
  }
  if (issue.input === 'always') {
    return (
      "retryPolicy.mode 不收 'always'（無限重試）：企業聊天機器人的一輪沒有盡頭，中段失敗會無限重付整個回覆。" +
      '這是登記在案的偏離（settings/live-model.ts 檔頭「偏離二」、plugin-contract.md 偏離表），' +
      '要撤除請由 demian 提出需要無限重試的情境。'
    );
  }
  return "retryPolicy.mode 只收 'normal'";
}

const retryPolicySchema = z.strictObject({
  /** 只收 `normal`，寫了就必填，見 {@link retryModeError}。 */
  mode: z.literal('normal', { error: retryModeError }),
  /** 最多重打幾次（不含第一次）。非負安全整數，沒有另外的上限，同 dsh：安全靠的是單次等待有界。 */
  maxRetries: z
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .default(DEFAULT_RETRY_MAX_RETRIES),
  /** 哪些失敗碼才重打；不能是空陣列、不能有空字串、不能重複（dsh 同三條）。 */
  retryableCodes: z
    .array(z.string().min(1, 'retryableCodes 不能有空字串'))
    .min(1, 'retryableCodes 不能是空陣列')
    .refine((codes) => new Set(codes).size === codes.length, 'retryableCodes 不能重複')
    .default(() => [...DEFAULT_STREAM_RETRYABLE_CODES]),
  backoff: retryBackoffSchema.default(() => ({
    initialDelayMs: DEFAULT_RETRY_INITIAL_DELAY_MS,
    maxDelayMs: DEFAULT_STREAM_RETRY_MAX_DELAY_MS,
    jitterRatio: DEFAULT_STREAM_RETRY_JITTER_RATIO,
  })),
});

/** 整個不寫 `retryPolicy` 時的值：normal、出廠的四個數字、dsh 預設可重試碼。 */
function defaultRetryPolicy(): z.infer<typeof retryPolicySchema> {
  return {
    mode: 'normal',
    maxRetries: DEFAULT_RETRY_MAX_RETRIES,
    retryableCodes: [...DEFAULT_STREAM_RETRYABLE_CODES],
    backoff: {
      initialDelayMs: DEFAULT_RETRY_INITIAL_DELAY_MS,
      maxDelayMs: DEFAULT_STREAM_RETRY_MAX_DELAY_MS,
      jitterRatio: DEFAULT_STREAM_RETRY_JITTER_RATIO,
    },
  };
}

/** 七格。`strictObject`：多寫一個欄位是打錯字，不是擴充點。 */
export const liveModelConfigSchema = z
  .strictObject(
    {
      /** OpenAI 相容端點的根。 */
      baseUrl: z
        .string()
        .refine(isHttpRoot, '端點要是 http: 或 https: 的網址，不能帶帳密、query 或 fragment')
        .default(DEFAULT_LIVE_BASE_URL),
      /** 用哪一顆模型。必須是 `models` 裡的一筆，見檔頭「型錄」。 */
      modelId: z.string().min(1).default(DEFAULT_LIVE_MODEL_ID),
      /** 模型型錄，**整份取代**，見檔頭「型錄」。省略即出廠那一筆。 */
      models: modelCatalogSchema.default(() => [structuredClone(DEFAULT_LIVE_MODEL_ENTRY)]),
      /** 連線到第一則事件的逾時（毫秒），見檔頭「偏離三」。 */
      timeoutMs: z.number().int().min(1).max(MAX_LIVE_TIMEOUT_MS).default(DEFAULT_LIVE_TIMEOUT_MS),
      /** 第一則事件之後，兩段位元組之間的閒置逾時（毫秒），見檔頭「偏離三」。 */
      streamIdleTimeoutMs: z
        .number()
        .int()
        .min(1)
        .max(MAX_LIVE_TIMEOUT_MS)
        .default(DEFAULT_LIVE_STREAM_IDLE_TIMEOUT_MS),
      /**
       * 模型請求失敗的重試政策（#1427），**首事件之前與之後共用這一份預算**，見檔頭「偏離二」。形狀與驗證逐條照 dsh 的
       * `retryPolicy`（`packages/llm/llm/src/retry-policy.ts` 的 `resolveRetryPolicy`／`resolveBackoff`）。整個不寫就是
       * normal 的預設值；**寫了就必填 `mode`**。`maxRetries: 0` 就是不重打，回到只打一次。
       */
      retryPolicy: retryPolicySchema.default(defaultRetryPolicy),
    },
    {
      error: (issue) => {
        if (issue.code !== 'unrecognized_keys') return undefined;
        const legacy = issue.keys.filter((key) => LEGACY_RETRY_KEYS.has(key));
        return legacy.length === 0 ? undefined : legacyRetryKeysMessage(legacy);
      },
    },
  )
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
 * 把驗過的 `retryPolicy` 攤平成 `@nexus/core` 的執行參數（`mode` 只有 `normal`，沒有東西要帶）。
 *
 * @param policy - `live-model` 那一列驗過的 `retryPolicy`。
 * @returns 給 `streamRetry`、標題與摘要器生摘要那幾處共用的同一份。
 */
export function streamRetryOptionsOf(policy: LiveModelConfig['retryPolicy']): StreamRetryOptions {
  return {
    maxRetries: policy.maxRetries,
    initialDelayMs: policy.backoff.initialDelayMs,
    maxDelayMs: policy.backoff.maxDelayMs,
    jitterRatio: policy.backoff.jitterRatio,
    retryableCodes: policy.retryableCodes,
  };
}

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

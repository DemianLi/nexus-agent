/**
 * `@nexus/plugin-time-context`——讓模型知道現在的日期時間（[#1625](https://github.com/DemianLi/nexus-agent/issues/1625)）。
 * 對上 dsh 的 `@deepseek-ai/dsh-time-context`（`packages/context/time-context`，`687f282e`），web-app 的 standard、cordis、ptc 三個 preset
 * 都掛它（`packages/bundle/web-app/presets/*.patch.yml`），所以是出廠就開的。
 *
 * 在一次 agent 呼叫開頭追加**一則持久的讀數**（同一條 thread 至多每 `refreshIntervalMs` 一次），三行：
 *
 * ```text
 * Time sampled while preparing turn <turn>, step <step>: <timestamp>
 * Browser time zone for this request: <policy>
 * Elapsed since the preceding <baseline>: <duration>.
 * ```
 *
 * 讀數**只追加在請求尾端，不進 system prompt**：prompt cache 的前綴不會因此失效（dsh README 的同一個理由）。文字照 dsh 的英文逐字搬，
 * 不翻成中文——這是給模型看的，跟 agent-instructions 一樣。
 *
 * ## 瀏覽器時區（第二行）今天只有 `missing` 一種
 *
 * wire 還沒有帶 `client_time_zone`（#1629、#1630），所以第二行一律是「unavailable，請向使用者確認」。回退時區（`timeZone` 設定，沒設就用
 * 載入時解析一次的行程時區）**只拿來格式化第一行的時鐘**，不代表使用者的時區（dsh README 同一句）。`resolved`、`mixed` 兩支與
 * `deriveBrowserTimeZoneContext` 今天沒有生產者，跟著 #1629 一起進（`packages/AGENTS.md`「Require a current owner and need」）。
 *
 * ## 攔截時刻：dsh 第 2 格 `agent/pre-step`
 *
 * 和 `@nexus/plugin-agent-instructions` 同一格、同一個接縫，是它之外的第二位消費者：dsh 在 `agent/pre-step` 把讀數 splice 進那一步的批次
 * （`src/index.ts:185-229`）；我們這側經 `@nexus/agent-loop` 的 `preStep` 登記 listener（宿主以 `beforeAgent` 承載），**只佔注入那半**，
 * 只能追加、落點由基座決定。位置由列的位置決定：`cordis.yml` 上這一列在 `agent-instructions` 正下方，所以同一次 invoke 裡讀數排在 AGENTS.md
 * 基線之後。逐欄的差與頻率量在 `apps/harness/src/interception-index.test.ts` 第 2 列。
 *
 * ## 偏離登記（AGENTS.md 的偏離規則；dsh 以 `687f282e` 為準）
 *
 * 五條都是理由 (1)「基座表達不出來」。前三條是 pre-step 接縫（`@nexus/agent-loop`）已登記的偏離，這顆插件繼承下來；第四條同 goal 的前例；
 * 第五條是出貨層的限制。
 *
 * 1. **頻率：每次 invoke 一次，不是每步一次。**
 *    dsh 每個 step 都跑 pre-step（`src/index.ts:185`）；我們的宿主把 listener 掛在 `beforeAgent`，一次 invoke 只跑一次。每步要 `beforeModel`，
 *    那是圖裡每輪多一格的節點，#389 拍板每步那一半先不做。**後果**：同一次 invoke 裡，後面幾步看不到新的讀數（dsh 預設間隔 10 分鐘，一次
 *    invoke 很少跨過，差別小）。`step` 照實填：用日誌裡這一輪已經有幾顆 `model/start` 算（核准後續接的 invoke 不是第 1 步）。**撤除條件**：
 *    #389 重開，或 core 開了多個貢獻者共用一格的 pre-step 節點。
 * 2. **不能 `reject`，也沒有 `signal`。** dsh 的下游決定 `reject`、或 signal 已中止時不注入（`:190`）；我們的 listener 只拿到
 *    `(visible, invocation)`、只能回要追加的訊息。**退到**：被叫到就照節流規則判斷。撤除條件同第 1 條。
 * 3. **來源的 kind。** dsh 是 `{ kind: 'time-context', form: 'snapshot', sections }`；宿主一律蓋成 `{ kind: 'plugin', plugin: <名字> }`。
 *    插件認自己的讀數，靠 `source.plugin` 等於 {@link TIME_CONTEXT_MIDDLEWARE_NAME}，另外在 `additional_kwargs` 放 {@link TIME_CONTEXT_MARKER}。
 *    這是接縫的形狀，不是新做法。撤除條件同第 1 條。
 * 4. **節流狀態不走投影，改重播日誌。** dsh 用 `ctx.sessionProjections.register` 加 `stateOf`（`:157-192`）；`@nexus/projections` 沒有讓插件
 *    讀回狀態的 `stateOf`（goal 同一件事，`packages/nexus-goal/src/index.ts:18-22`）。插件經會話查找拿這條 thread 的 `log.events`，自己照 dsh 的
 *    `apply` 規則摺出三格。**撤除條件**：`@nexus/projections` 長出 `stateOf(log, key)` 時改走投影，另開卡。
 *    **基線的規則改寫了，不是逐字搬 dsh 的 `apply`**：兩邊日誌的形狀不同。dsh 第 1 步時，這一輪的人話和 agent-instructions 的基線都還在「提議的
 *    批次」裡，沒進 session；我們一輪開頭那句人話記在 `turn/start`（不是 `user/message`），而且同一次 `beforeAgent` 裡 agent-instructions 的基線在
 *    本插件之前就寫進日誌了。照搬有兩種錯法：不把 `turn/start` 當成模型看得到的事件，前幾輪的人話會漏算；把這一輪的事件也算進去，有 `AGENTS.md`
 *    時第三行永遠是 `0s`。**規則**：第 1 步的基線取**這一輪（最後一顆非 `resume` 的 `turn/start`）之前**最後一則模型看得到的事件——前幾輪
 *    `turn/start` 帶的人話、`assistant/message`、`tool/result`、`user/message` 都算；這一輪裡的事件都不算。後面的步照 dsh，取這一輪上一次讀數
 *    的時間。日誌上找不到這一輪的 `turn/start`（例如同步子代理，它的日誌沒有 `turn/start`）時沒有基線，寫 `unavailable`。
 *    **查找不是 `ok`**（例如落盤關掉）：照樣注入，經過時長寫 `unavailable`，`turn`／`step` 寫 1；節流退回看 `visible`——讀數的記號裡放這次
 *    取樣的時間，從模型看得到的那一串找最近一則。這樣不會每次 invoke 都多一則，也不靜靜不注入。
 * 5. **CLI 也掛。** dsh 只有 web-app 的三個 preset 掛，headless、base 不掛，照 dsh 該只掛 serve。serve 專屬層（`cordis.serve.yml`）的函式插件
 *    上不了樹（`apps/harness/src/plugin-tree.ts:51-52`），這顆是樹上的插件，只能寫在 `cordis.yml`，CLI 和 serve 一起掛。CLI 沒有瀏覽器，第二行
 *    一律 `unavailable`，跟 dsh 的 CLI 一樣不知道使用者的時區。**撤除條件**：serve 層改成經 Include 上樹時，把這一列搬到 `cordis.serve.yml`。
 *
 * **和 schedule 不同行，不算偏離。** dsh 把它和提醒工具放在同一個 preset，我們不做 schedule（L-18、#1614 拍板第 2 條）；dsh 拿掉 `minimal` 的理由
 * 是那個組合裡沒有人用得到讀數，它的掛載條件是一般性的（`README.zh.md:28`：要解讀沒寫明時區的日期就掛）。我們的 serve 出廠組合比較接近 standard，
 * 所以照 standard 掛（#1614 Q5 已拍板）。
 *
 * ## 函式插件
 *
 * 套 SDK lint，**不 import `@nexus/core`**，也不碰 langchain 的 middleware：要在一次呼叫開頭追加訊息，經 `agentLoop` 服務登記一位 `preStep`
 * listener（宿主建 middleware、建訊息、記日誌）；要讀這條 thread 的日誌，經 `sessionLookup` 服務。這個檔只剩「讀什麼、渲染什麼、什麼時候不加」。
 * 兩個服務都在 `apply` 當下抓進閉包，**呼叫當下才 `forCall`**（列卸載之後經 `ctx` 取服務會拋，抓住的那份仍可呼叫）。
 *
 * @module
 */

import type { BaseMessage } from '@langchain/core/messages';
import { agentLoopToken } from '@nexus/agent-loop';
import type { PreStepInjection, PreStepInvocation, PreStepListener } from '@nexus/agent-loop';
import type { Context } from '@nexus/cordis';
import { defineManifest, injectOf, need, service } from '@nexus/sdk';
import { sessionLookupToken } from '@nexus/session';
import type { SessionEvent, SessionLookup } from '@nexus/session';
import { z } from 'zod';

import { createTimestampFormatter, formatTimestamp } from './timestamp.js';

export { createTimestampFormatter, formatTimestamp } from './timestamp.js';

/**
 * middleware 的名字，也是 listener 登記時給宿主的名字（宿主用它當 middleware 名與日誌 `source.plugin`）。插件靠它從日誌認出自己的讀數。
 */
export const TIME_CONTEXT_MIDDLEWARE_NAME = 'TimeContextMiddleware';

/**
 * 讀數訊息上的記號（`additional_kwargs`），值是 `{ sampledAt: <epoch 毫秒> }`。**查找不是 `ok` 時節流用它**（見檔頭偏離 4）；
 * 判準放在訊息上、不放在閉包裡，理由同 agent-instructions（一份 listener 服務好幾條 thread）。
 */
export const TIME_CONTEXT_MARKER = 'nexus.timeContext';

/** 兩次注入之間至少隔多久（毫秒）的預設值：10 分鐘，照 dsh。 */
export const DEFAULT_REFRESH_INTERVAL_MS = 600_000;

/** 第二行：今天只有「不知道」一種（見檔頭「瀏覽器時區」）。 */
const BROWSER_TIME_ZONE_MISSING =
  'Browser time zone for this request: unavailable. ' +
  'Ask the user to clarify otherwise-unqualified dates and times.';

/**
 * 這個 plugin 的設定。
 *
 * **`refreshIntervalMs` 是 `0` 表示每次都注入，不是關掉**（照 dsh）；要關就 `disabled: true`。
 */
export const timeContextConfigSchema = z.strictObject({
  /** 回退顯示時區（IANA 名）。省略就用載入時解析一次的行程時區。 */
  timeZone: z.string().optional(),
  /** 同一條 thread 兩次注入之間至少隔多少毫秒；非負的安全整數，省略即 {@link DEFAULT_REFRESH_INTERVAL_MS}。 */
  refreshIntervalMs: z.number().optional(),
});

/** 驗過的設定。 */
export type TimeContextConfig = z.infer<typeof timeContextConfigSchema>;

/**
 * 把毫秒數格成整秒的 `1d 1h 1m 1s`，零的單位省略（秒一定寫）。負數鉗成 0。逐字照 dsh `formatDuration`。
 *
 * @param elapsedMs - 經過的毫秒。
 * @returns 例如 `15m 0s`、`1d 1h 1m 1s`。
 */
export function formatDuration(elapsedMs: number): string {
  let seconds = Math.floor(Math.max(0, elapsedMs) / 1000);
  const days = Math.floor(seconds / 86_400);
  seconds %= 86_400;
  const hours = Math.floor(seconds / 3600);
  seconds %= 3600;
  const minutes = Math.floor(seconds / 60);
  seconds %= 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(' ');
}

/**
 * 渲染一則讀數。逐字照 dsh `renderText`，只是第二行固定是 `missing`。
 *
 * @param now - 取樣時間（epoch 毫秒）。
 * @param turn - 第幾輪。
 * @param step - 這一輪的第幾步。
 * @param previous - 基線時間；沒有就 `undefined`，經過時長寫 `unavailable`。
 * @param formatter - 第一行用的格式器。
 * @param timeZone - 第一行方括號裡的時區名。
 * @returns 三行文字。
 */
export function renderTimeContext(
  now: number,
  turn: number,
  step: number,
  previous: number | undefined,
  formatter: Intl.DateTimeFormat,
  timeZone: string,
): string {
  const elapsed = previous === undefined ? 'unavailable' : formatDuration(now - previous);
  const baseline = step === 1 ? 'model-visible message' : 'step context';
  return (
    `Time sampled while preparing turn ${turn}, step ${step}: ${formatTimestamp(now, formatter, timeZone)}\n` +
    `${BROWSER_TIME_ZONE_MISSING}\n` +
    `Elapsed since the preceding ${baseline}: ${elapsed}.`
  );
}

/**
 * 檢查間隔：非負的安全整數，否則拋（載入失敗）。照 dsh `validateRefreshInterval`。
 *
 * @param refreshIntervalMs - 設定給的間隔。
 */
export function validateRefreshInterval(refreshIntervalMs: number): void {
  if (!Number.isSafeInteger(refreshIntervalMs) || refreshIntervalMs < 0) {
    throw new TypeError(
      `time-context: refreshIntervalMs must be a non-negative safe integer, got ${String(refreshIntervalMs)}`,
    );
  }
}

/** 從一份日誌摺出來的讀數用事實。 */
export interface TimeContextFacts {
  /** 第幾輪：非 `resume` 的 `turn/start` 的數量，至少 1。 */
  readonly turn: number;
  /** 這一輪的第幾步：這一輪裡 `model/start` 的數量加 1。 */
  readonly step: number;
  /** 本插件最近一次注入的時間（那顆 `user/message` 的 `time`），沒有是 `null`。 */
  readonly lastInjectionTime: number | null;
  /** 這一輪最近一次注入的時間；每個 `turn/start`、`turn/end` 清掉（照 dsh `apply`）。 */
  readonly lastTurnInjectionTime: number | null;
  /** 這一輪之前最後一則模型看得到的事件的時間，沒有是 `null`（規則見檔頭偏離 4）。 */
  readonly baselineBeforeTurn: number | null;
}

/** 這一顆事件是不是「模型看得到的訊息」（第 1 步的基線候選）。 */
function isModelVisible(event: SessionEvent): boolean {
  switch (event.type) {
    case 'turn/start':
      return event.data.kind !== 'resume';
    case 'user/message':
    case 'assistant/message':
    case 'tool/result':
      return true;
    default:
      return false;
  }
}

/**
 * 重播一份日誌，摺出 {@link TimeContextFacts}。純函式：給事件、得事實。
 *
 * @param events - 這條日誌到現在的全部事件，照 `seq` 排。
 * @returns 事實。
 */
export function foldTimeContext(events: readonly SessionEvent[]): TimeContextFacts {
  let cut = -1;
  let turns = 0;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event?.type === 'turn/start' && event.data.kind !== 'resume') {
      cut = index;
      turns += 1;
    }
  }
  let step = 1;
  let lastInjectionTime: number | null = null;
  let lastTurnInjectionTime: number | null = null;
  let baselineBeforeTurn: number | null = null;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event === undefined) continue;
    if (index < cut && isModelVisible(event)) baselineBeforeTurn = event.time;
    if (event.type === 'turn/start' || event.type === 'turn/end') lastTurnInjectionTime = null;
    if (index > cut && event.type === 'model/start') step += 1;
    if (
      event.type === 'user/message' &&
      event.data.source.kind === 'plugin' &&
      event.data.source.plugin === TIME_CONTEXT_MIDDLEWARE_NAME
    ) {
      lastInjectionTime = event.time;
      lastTurnInjectionTime = event.time;
    }
  }
  return {
    turn: Math.max(1, turns),
    step,
    lastInjectionTime,
    lastTurnInjectionTime,
    baselineBeforeTurn: cut === -1 ? null : baselineBeforeTurn,
  };
}

/** 從模型看得到的那一串，找最近一則讀數取樣的時間（查找不是 `ok` 時節流用）。 */
function lastSampledAt(visible: readonly BaseMessage[]): number | null {
  for (let index = visible.length - 1; index >= 0; index -= 1) {
    const marker: unknown = visible[index]?.additional_kwargs?.[TIME_CONTEXT_MARKER];
    if (typeof marker === 'object' && marker !== null && 'sampledAt' in marker) {
      const { sampledAt } = marker;
      if (typeof sampledAt === 'number') return sampledAt;
    }
  }
  return null;
}

/** {@link createTimeContextListener} 的輸入。 */
export interface TimeContextListenerOptions {
  /** 兩次注入之間至少隔多少毫秒；`0` 每次都注入。已驗過。 */
  readonly refreshIntervalMs: number;
  /** 第一行用的格式器（回退時區）。 */
  readonly formatter: Intl.DateTimeFormat;
  /** 第一行方括號裡的時區名（回退時區解析後的正規名）。 */
  readonly timeZone: string;
  /** 這次呼叫那條 thread 的日誌查找（`sessionLookup.forCall`）。 */
  readonly lookup: (invocation: PreStepInvocation) => SessionLookup;
  /** 現在的 epoch 毫秒。預設 `Date.now`，只給單元測試換。 */
  readonly now?: () => number;
}

/**
 * 建 listener：每次 invoke 被叫一次，節流通過就回一則讀數。
 *
 * @param options - 見 {@link TimeContextListenerOptions}。
 * @returns 登記給 `agentLoop.preStep` 的 listener。
 */
export function createTimeContextListener(options: TimeContextListenerOptions): PreStepListener {
  const now = options.now ?? Date.now;
  return (visible, invocation): readonly PreStepInjection[] | undefined => {
    const at = now();
    const found = options.lookup(invocation);
    let facts: TimeContextFacts | undefined;
    let last: number | null;
    if (found.kind === 'ok') {
      facts = foldTimeContext(found.log.events);
      last = facts.lastInjectionTime;
    } else {
      last = lastSampledAt(visible);
    }
    // 節流：照 dsh——牆鐘倒退（`at < last`）時不擋，免得時鐘被調回之後永遠不再注入。
    if (options.refreshIntervalMs > 0 && last !== null && at >= last) {
      if (at - last < options.refreshIntervalMs) return undefined;
    }
    const turn = facts?.turn ?? 1;
    const step = facts?.step ?? 1;
    const base = step === 1 ? facts?.baselineBeforeTurn : facts?.lastTurnInjectionTime;
    const text = renderTimeContext(
      at,
      turn,
      step,
      base ?? undefined,
      options.formatter,
      options.timeZone,
    );
    return [{ content: text, additionalKwargs: { [TIME_CONTEXT_MARKER]: { sampledAt: at } } }];
  };
}

export const name = 'time-context';

/**
 * 要的服務：`agentLoop`（`^1.0.0`，登記 `preStep` listener）與 `sessionLookup`（`^1.0.0`，呼叫當下拿這條 thread 的日誌）。
 */
export const inject = injectOf(need(agentLoopToken, '^1.0.0'), need(sessionLookupToken, '^1.0.0'));

/** 這個插件的設定（manifest 的 `config`）：見 {@link timeContextConfigSchema}。`strictObject`：未知欄位讓載入失敗。 */
export const Config = timeContextConfigSchema;

export const manifest = defineManifest({
  id: 'time-context',
  version: '0.1.0',
  owner: '平台團隊',
  provides: [],
  consumes: [
    { token: agentLoopToken.name, range: '^1.0.0' },
    { token: sessionLookupToken.name, range: '^1.0.0' },
  ],
  config: Config,
  // 換程式碼要重啟行程；設定（`timeZone`、`refreshIntervalMs`）只給新的 thread（組 thread 時取快照，決議 §3-2 第 6 條）。
  reload: { code: 'restart', config: 'next-thread' },
  capabilities: [],
});

/**
 * 掛上：驗設定、解析回退時區、登記一位 `preStep` listener。
 *
 * **回退時區在這裡解析一次並留住**，同 dsh（`src/index.ts:136-146`）：載入之後行程的 `TZ` 再變不影響。設定不合法（間隔不是非負安全整數、
 * 時區解析不了）時拋，這一列掉、啟動印警告。
 *
 * @param ctx - 這一列的 Cordis context。
 * @param config - 驗過的設定。
 * @throws 間隔不合法，或設定的（或行程的）時區解析不了。
 */
export function apply(ctx: Context, config: TimeContextConfig): void {
  const refreshIntervalMs = config.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
  validateRefreshInterval(refreshIntervalMs);
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = createTimestampFormatter(config.timeZone);
  } catch (error: unknown) {
    const message =
      config.timeZone === undefined
        ? 'time-context: failed to resolve the system time zone'
        : `time-context: invalid IANA timeZone ${JSON.stringify(config.timeZone)}`;
    throw new Error(message, { cause: error });
  }
  const agentLoop = service(ctx, agentLoopToken);
  const sessionLookup = service(ctx, sessionLookupToken);
  agentLoop.preStep(
    TIME_CONTEXT_MIDDLEWARE_NAME,
    createTimeContextListener({
      refreshIntervalMs,
      formatter,
      timeZone: formatter.resolvedOptions().timeZone,
      lookup: (invocation) => sessionLookup.forCall(invocation),
    }),
  );
}

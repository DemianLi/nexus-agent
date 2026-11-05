/**
 * `agent/pre-step` 接縫的**宿主端**（[#1474](https://github.com/DemianLi/nexus-agent/issues/1474) Q1 (a)、Q2 (a)）：把樹上插件登記的
 * listener（`@nexus/agent-loop` 的 `preStep`）建成 middleware。
 *
 * 建 middleware 要 core 的 `applySummaryCutoff`／`sourceKwargs`／`toLoggedMessage`／`createHookStepMiddleware`，定義套件
 * 不 import core，所以這段程式放在宿主，跟 `plugin-config.ts` 的 `registerFolded` 一起用（橋接列把每位 listener 折進**這條 thread
 * 自己的** `registry.middleware`）。接縫的契約、偏離登記與 dsh 的對照寫在 `@nexus/agent-loop` 的檔頭。
 *
 * ## 一顆 listener 一顆 middleware，落點不變
 *
 * 每位 listener 建**一顆**、掛在 `beforeAgent`、名字用登記時給的名字，經 `registry.middleware.use(mw)` 折進——**不帶 `prepend`
 * 或 `last`**，所以它在 middleware 鏈上的位置就是那一列在出貨清單上的位置，跟遷移之前 `useWithBackend` 的落點相同。一份實例走遍
 * root 與每個子代理（`registry.middleware` 的契約，#327）：逐 agent 的狀態不能放在閉包裡，listener 從訊息上的記號與呼叫設定查。
 *
 * ## 每次呼叫做的事（順序就是行為）
 *
 * 1. 算出「模型看得到的那一串」。摘要器不改寫 `state.messages`，切點記在這次組裝的切點表（`@nexus/core` 的 `summary-cutoffs.ts`），
 *    模型呼叫時才組 `[summary, ...messages.slice(cutoffIndex)]`；listener 要看的是後者（#397）。切點由呼叫端交進來的查找函式問，
 *    跟摘要器問的是同一張表；這裡在一次 invoke 開始時（第一步之前）問一次，讀到的跟摘要器在這次 invoke 第一步開始時讀到的是同一個值；
 *    同一次 invoke 後面幾步不再問。`history-source=log` 時 root
 *    從日誌推同一個視圖（`createVisibleHistoryReader`，#2355），不讀 state；子代理的歷史由 state 送，讀 state。
 * 2. 呼叫 listener，交 `{ configurable: runtime.configurable, signal }`（**這個形狀**：原樣交給會話查找與 fs 查找才認得出這次呼叫；交裸的
 *    `configurable` 兩個查找都回 `unknown-caller`，注入會靜靜消失）。`signal` 是這一輪的中止訊號（契約 1.1.0，#1533），見 {@link stepSignal}。
 * 3. 把 listener 回的每一則建成使用者訊息：`additional_kwargs` 先放 listener 給的記號、**再**蓋 `source`（順序影響位元組，golden
 *    比對）；不加 `id`。`source` 是 listener 給的那一格（契約 1.2.0，#1574），沒給是 `{ kind: 'plugin', plugin: <名字> }`；
 *    給了 listener 不能交的來源就拋，見 {@link injectionSource}。
 * 4. 經**這條 thread 的** `registry.sessions.forCall` 記一筆 `user/message`；找不到就不記、訊息照送，寫不進去原錯往外拋（#1665，
 *    見 `record`）。`history-source=log` 時找不到日誌在第 1 步就拋了，走不到這裡：記不進去的那則模型看不到（#2355）。**不走行程級的
 *    `session-lookup`**：那條多 thread 時可能 `ambiguous`，而這顆 middleware 本來就是這條 thread 的。
 * 5. 回 `{ messages }`，由基座追加。
 *
 * listener 拋錯**不吞**：它是插件寫的程式，吞掉會讓注入靜靜消失；同今天（舊外殼的 `discover` 自己吞檔案讀取錯誤，其餘不吞）。
 *
 * @module
 */

import { HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { PreStepInjection, PreStepListener } from '@nexus/agent-loop';
import {
  applySummaryCutoff,
  createHookStepMiddleware,
  createVisibleHistoryReader,
  isHistoryFromLog,
  sourceKwargs,
  toLoggedMessage,
  turnCancelSignalOf,
} from '@nexus/core';
import type { SessionLog, SessionLookup, SummaryCutoff, UserMessageSource } from '@nexus/core';
import type { AgentMiddleware } from 'langchain';
import { z } from 'zod';

import { toolResultAsSeen } from './conversation-restore.js';

/**
 * 這次呼叫的摘要切點：收 `{ configurable }` 與這一步 state 的訊息串，回切點或 `undefined`。宿主交的是這次組裝切點表的
 * `lookup`（`summaryCutoffsOf(registry)`），不交整張表。
 */
export type SummaryCutoffOf = (
  config: { readonly configurable: unknown },
  messages: readonly BaseMessage[],
) => SummaryCutoff | undefined;

/**
 * listener 交得出的來源：`plugin`（可帶 `form: 'instructions'`，契約 1.3.0，#1567）與 `skill-invocation` 兩種，形狀同 `session-log.ts` 的
 * `UserMessageSource`，另外 `name` 不能是空字串、多一個鍵都不收。`plugin` 要是自己的名字，在 {@link injectionSource} 驗。新的 listener 生產者要在 `session-log.ts` 補它的 variant，
 * 也在這裡補一支。
 */
const LISTENER_SOURCE = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('plugin'),
    plugin: z.string(),
    form: z.literal('instructions').optional(),
  }),
  z.strictObject({
    kind: z.literal('skill-invocation'),
    name: z.string().min(1),
    form: z.literal('instructions'),
  }),
]);

/**
 * 建一位 `agent/pre-step` listener 的 middleware。
 *
 * @param name - listener 登記時給的名字：middleware 的名字，也是日誌 `source.plugin`。
 * @param listener - 要叫的 listener。
 * @param sessions - **這條 thread 的**會話註冊表的 `forCall`（`registry.sessions`）：注入的訊息也記進日誌。
 * @param cutoffOf - 這次呼叫的摘要切點，見 {@link SummaryCutoffOf}。
 * @returns 可以掛在任意多個 agent 上的 middleware。
 */
export function createPreStepMiddleware(
  name: string,
  listener: PreStepListener,
  sessions: { forCall(config: unknown): SessionLookup },
  cutoffOf: SummaryCutoffOf,
): AgentMiddleware {
  const fromLog = createVisibleHistoryReader(toolResultAsSeen);
  return createHookStepMiddleware({
    name,
    beforeAgent: async (state, hookRuntime) => {
      const runtime = hookRuntime as
        { readonly configurable?: unknown; readonly signal?: AbortSignal } | undefined;
      const current = (state as { messages?: readonly BaseMessage[] }).messages ?? [];
      const visible =
        visibleFromLog(sessions, runtime?.configurable, fromLog) ??
        applySummaryCutoff(current, cutoffOf({ configurable: runtime?.configurable }, current));
      const signal = stepSignal(runtime);
      const injections = await listener(visible, {
        configurable: runtime?.configurable,
        ...(signal !== undefined && { signal }),
      });
      if (injections === undefined || injections.length === 0) return undefined;
      // 先驗完全部的來源再記：一則被拒時，前面那幾則也不落盤（不然日誌上有、state 裡沒有）。
      const sources = injections.map((injection) => injectionSource(name, injection));
      const messages = injections.map((injection, index) => {
        const source = sources[index]!;
        const message = new HumanMessage({
          content: injection.content,
          // 來源預設是 `plugin`（#662）：它注入的時機是一輪的開頭，今天緊接在人那句話之後所以沒事；以後哪個時刻
          // 它被補在一輪中間，重複提醒的鏈不會因它被悄悄清零。listener 給了自己的來源（#1574）就用它，同樣不是人。
          additional_kwargs: {
            ...injection.additionalKwargs,
            ...sourceKwargs(source),
          },
        });
        record(sessions, runtime?.configurable, source, message);
        return message;
      });
      return { messages };
    },
  }) as unknown as AgentMiddleware;
}

/**
 * 一則注入的來源：listener 給了就用它（契約 1.2.0，[#1574](https://github.com/DemianLi/nexus-agent/issues/1574)；dsh 的 listener 自己帶
 * `source`，例如 `tool-skill/src/index.ts:198-202`，`687f282e`），沒給是 `{ kind: 'plugin', plugin: <名字> }`。
 *
 * **只收兩種**（[#1920](https://github.com/DemianLi/nexus-agent/issues/1920)）：`plugin` 而且是自己的名字（可帶 `form: 'instructions'`，
 * 契約 1.3.0），或形狀完整的 `skill-invocation`。
 * 其餘的宿主擋下：拋錯、這一輪失敗（listener 的錯本來就不吞，見檔頭）。`source` 這一格任何 listener 都寫得出任何一種：
 * - `user` 是「有人在場」的判別，goal 的直接人類授權認它，`session-log.ts` 的 `user/message` 寫明外掛不能寫這一種；
 * - 別人的 `plugin` 名字會被那位插件當成自己的讀數（time-context 從日誌認 `source.plugin`）；
 * - `session-reference`、`subagent-settled`、`agent-message` 是宿主自己記的，冒出來會在歷史畫面長出假的引用或通知，形狀不全時讀的那側還會拋。
 */
function injectionSource(name: string, injection: PreStepInjection): UserMessageSource {
  const source = injection.source;
  if (source === undefined) return { kind: 'plugin', plugin: name };
  if (source.kind === 'user') {
    throw new Error(
      `pre-step listener "${name}" 交了 user 來源：只有人話能記成 user，listener 注入的訊息不能冒充`,
    );
  }
  const parsed = LISTENER_SOURCE.safeParse(source);
  if (!parsed.success) {
    throw new Error(
      `pre-step listener "${name}" 交了 ${JSON.stringify(source)}：listener 只能交 plugin（自己的名字）或 skill-invocation 來源`,
    );
  }
  if (parsed.data.kind === 'plugin' && parsed.data.plugin !== name) {
    throw new Error(
      `pre-step listener "${name}" 交了別人的 plugin 來源 "${parsed.data.plugin}"：只能用自己的名字`,
    );
  }
  return parsed.data;
}

/**
 * 交給 listener 的中止訊號（[#1533](https://github.com/DemianLi/nexus-agent/issues/1533)）：dsh 交的是這一步的 `signal`
 * （`packages/core/agent-loop/src/agent.ts:275`），也就是人按停止時舉起的那一顆。
 *
 * 我們這一顆**不在 `runtime.signal`**：pump 把這一輪的中止訊號放在 `configurable` 的 `TURN_CANCEL_CONFIG_KEY`，刻意不交給
 * LangGraph（交了會丟下正在跑的工具，見 `@nexus/core` 的 `turn-cancel.ts`）。所以先讀那一顆；呼叫端若另外給了 LangGraph 的
 * `signal`（`runtime.signal`，langchain `dist/agents/nodes/middleware.js:52`），兩顆任一舉起都算。CLI 與 eval 兩顆都沒有，就不交。
 */
function stepSignal(
  runtime: { readonly configurable?: unknown; readonly signal?: AbortSignal } | undefined,
): AbortSignal | undefined {
  const turn = turnCancelSignalOf({ configurable: runtime?.configurable });
  const graph = runtime?.signal;
  if (turn === undefined) return graph;
  if (graph === undefined) return turn;
  return AbortSignal.any([turn, graph]);
}

/**
 * `history-source=log` 時 root 的 listener 看到的那一串，從日誌推；不是 `log`、或是子代理的呼叫，回 `undefined`（讀 state）。
 * `log` 時找不到日誌就拋：不退回 state。
 */
function visibleFromLog(
  sessions: { forCall(config: unknown): SessionLookup },
  configurable: unknown,
  read: (log: SessionLog) => BaseMessage[],
): BaseMessage[] | undefined {
  if (!isHistoryFromLog(sessions)) return undefined;
  const found = sessions.forCall({ configurable });
  if (found.kind !== 'ok') {
    throw new Error(
      `pre-step listener 找不到這次呼叫的日誌（${found.kind}）：history-source=log 不退回 state`,
    );
  }
  return found.address.kind === 'root' ? read(found.log) : undefined;
}

/**
 * 把注入的訊息記成 `user/message`。認不出屬於哪一份就不記。
 *
 * **寫不進去原錯往外拋，這一輪失敗**（[#1665](https://github.com/DemianLi/nexus-agent/issues/1665)）：注入的訊息進模型歷史，
 * 照 dsh 不吞——`agent/pre-step` 交回的訊息在步驟裡直接 append（`packages/core/agent-loop/src/agent.ts:427-436`，`687f282e`）。
 * 吞掉的話這則照樣進 state、日誌上沒有，續接後模型看到的歷史跟之前不同。插件交來的 `additionalKwargs` 帶了有損值或巢狀超過
 * 上限，就會從這裡拋。
 */
function record(
  sessions: { forCall(config: unknown): SessionLookup },
  configurable: unknown,
  source: UserMessageSource,
  message: HumanMessage,
): void {
  const found = sessions.forCall({ configurable });
  if (found.kind !== 'ok') return;
  found.log.append('user/message', { message: toLoggedMessage(message), source });
}

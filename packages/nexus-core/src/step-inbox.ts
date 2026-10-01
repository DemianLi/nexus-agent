/**
 * 插話的載體：跑著的那一輪每次叫模型之前，領走收件匣的 `next-step`，送進模型
 * （[#710](https://github.com/DemianLi/nexus-agent/issues/710)）。
 *
 * ## dsh 怎麼做
 *
 * dsh 的迴圈在 driver 裡，一步一步走：每一步的 `preStep` 領走整條 `next-step`（一輪開頭再多領一件 `next-turn`），
 * 寫成 `user/message` 送進模型；模型說完了但 `next-step` 不空時，這一輪不收，接著跑下一步
 * （`packages/core/agent-loop/src/agent.ts:271`、`:342-347`、`:403-405`，`477b4f4`）。
 *
 * ## 我們的縫
 *
 * 我們的迴圈是基座的圖，pump（`apps/harness/src/thread-pump.ts`）在圖外。收件匣由 pump 持有，經由 `configurable` 的
 * {@link STEP_INBOX_CONFIG_KEY} 把一個 {@link StepInbox} 交進圖裡，同 `turn-cancel.ts` 交中止訊號的做法。圖裡兩個掛點，
 * 對到 dsh 的兩件事，**都是基座表達得出來的，不是偏離**（2026-09-28 用真組裝的探針量過）：
 *
 * - **`beforeModel`：工具結果回來了、模型還沒被叫**。領走的那幾句當成 `HumanMessage` 併進 state，這一次模型呼叫就看得到。
 * - **`afterAgent`：模型說完了、圖要收尾**。這時還有插話就併進 state、`jumpTo: 'model'`，同一次執行裡再叫一次模型；
 *   沒有就關窗（{@link StepInbox.finish}），之後到的插話不再屬於這一輪。
 *   - **非得把訊息併進去不可**：只回 `jumpTo` 的話，路由器看到最後一則是說完了的 AI 就收尾（langchain 1.5.10 的
 *     `ReactAgent.js` 的 `#createAfterModelRouter`），跳不回去。
 *   - 跳回去直達模型節點，**不經 `beforeModel`**，也不重跑 `beforeAgent`（量過）。今天產品組裝上唯一另一顆
 *     `beforeModel` 是重複提醒，而最後一則是人插的話時它本來就清零、沒有話要講。
 *
 * ## 為什麼是 `afterAgent` 而不是 `afterModel`
 *
 * 兩個都跳得回模型。差在價錢：每一顆 `beforeModel`／`afterModel` 都是圖裡的一個節點，**每一步多一個 super-step**；
 * `afterAgent` 一次執行只走一次。`beforeModel` 省不掉（工具邊界只有它），「說完了還有插話」那一半改掛 `afterAgent`，
 * 每一步只多一格。換算見 `apps/harness/src/settings/recursion-limit.ts`。
 *
 * **只掛在要插話的組裝上**（`FoldOptions.stepInbox`）：CLI 一行一輪，沒有插話，不必付那一格。
 *
 * ## 只在 root
 *
 * deepagents 叫子代理時把 `configurable` 原樣展開（見 `turn-cancel.ts`），所以子代理的圖裡也讀得到 pump 的那個
 * handle。插話是給 root 那一輪的，子代理領走的話 root 的模型永遠看不到，所以兩個掛點在子代理裡什麼都不做。這一顆也
 * 只折進 root 的 middleware 陣列，這條判斷是保險。
 *
 * ## 背景子代理有自己的一份（[#858](https://github.com/DemianLi/nexus-agent/issues/858)）
 *
 * 背景續行的子代理（#737）是最上層的圖，靠顯式的身分鍵認人。`compileSubagentGraph` 替它掛 `createStepInboxMiddleware('background')`，
 * host（`apps/harness/src/background-subagents.ts`）替每個正在跑的子代理持有一份 handle，經同一把 {@link STEP_INBOX_CONFIG_KEY}
 * 交進它的 `configurable`。`send_message` 給跑著的子代理就在它的下一步領走，同 dsh 的「a working agent receives it at its next step」。
 * 一次性子代理的圖裡沒有這顆，所以 `configurable` 被原樣展開也領不到。
 *
 * ## 中止之後
 *
 * 中止訊號已經觸發時 `afterAgent` 不領也不跳：同 dsh，中止之後送來的插話進 `next-turn`（`agent.ts:154-169`），
 * 留在 `next-step` 的由下一輪開頭領走。root 被中止時 `turn-cancel.ts` 會拋，照理到不了這裡；這條判斷同樣是保險。
 *
 * @module
 */

import type { HumanMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import type { AgentMiddleware } from 'langchain';

import { BACKGROUND_SESSION_CONFIG_KEY, toolCallSessionAddress } from './session-address.js';
import { turnCancelSignalOf } from './turn-cancel.js';

/** 進入點把收件匣的 handle 放在 `configurable` 的這個鍵上。 */
export const STEP_INBOX_CONFIG_KEY = 'nexus_step_inbox';

/** 這顆 middleware 的名字。 */
export const STEP_INBOX_MIDDLEWARE_NAME = 'nexusStepInbox';

/**
 * pump 交進圖裡的那一個 handle。**領走的那一刻就落日誌**（領走那顆 `inbox/spliced` 加每一句一顆 `user/message`），
 * 回傳的訊息要原封不動併進 state：推回模型時是照日誌推的，兩邊要對得上。
 */
export interface StepInbox {
  /**
   * 領走整條 `next-step`。空的就回空陣列，日誌不動。
   *
   * **回 Promise**（[#713](https://github.com/DemianLi/nexus-agent/issues/713)）：插話裡 `@` 了別的會話的話，要先讀那條會話、
   * 凍成快照才寫進日誌，那一步是非同步的。**領走本身仍然是同步的**——實作在呼叫的那一刻就把整條 `next-step` 從收件匣拿掉，
   * await 的只有準備與落日誌，所以領走與領走之後到的插話之間的界線沒有變。
   */
  claim(): Promise<readonly HumanMessage[]>;
  /**
   * 這一次執行要收尾了：有插話就同 {@link claim} 領走（呼叫端接著再叫一次模型），**沒有就關窗**——之後到的插話
   * 不再屬於這一輪，改排 `next-turn`。**領與關在同一個同步段裡，中間插不進一句話**：實作在呼叫的那一刻同步做完
   * 領走與關窗的判斷，回傳的 Promise 只等準備與落日誌。
   */
  finish(): Promise<readonly HumanMessage[]>;
}

/**
 * 從一次呼叫的 `configurable` 讀出收件匣的 handle。沒放就是 `undefined`（CLI、手搭的組裝、測試）。
 *
 * @param config - 有 `configurable` 的東西，同 {@link turnCancelSignalOf}。
 */
export function stepInboxOf(config: unknown): StepInbox | undefined {
  const configurable = (config as { configurable?: Record<string, unknown> } | null | undefined)
    ?.configurable;
  const value = configurable?.[STEP_INBOX_CONFIG_KEY] as Partial<StepInbox> | undefined;
  return typeof value?.claim === 'function' && typeof value.finish === 'function'
    ? (value as StepInbox)
    : undefined;
}

/** 這顆 middleware 掛在哪一種圖上。 */
export type StepInboxScope = 'root' | 'background';

/**
 * 這一次呼叫該讀哪一個 handle。
 *
 * - `root`：root 那一層的；子代理（含背景子代理）、沒放都是 `undefined`。
 * - `background`：**只認帶背景身分鍵的呼叫**（[#858](https://github.com/DemianLi/nexus-agent/issues/858)）。背景圖是最上層的圖，
 *   身分不靠 `checkpoint_ns`（見 `session-address.ts`），所以這裡直接看那把鍵；沒有鍵（root、測試手搭）就什麼都不做。
 */
function inboxOf(scope: StepInboxScope, runtime: unknown): StepInbox | undefined {
  const configurable = (runtime as { configurable?: unknown } | null | undefined)?.configurable;
  if (scope === 'background') {
    const tagged =
      typeof configurable === 'object' &&
      configurable !== null &&
      Object.hasOwn(configurable, BACKGROUND_SESSION_CONFIG_KEY);
    return tagged ? stepInboxOf({ configurable }) : undefined;
  }
  if (toolCallSessionAddress({ configurable })?.kind === 'subagent') return undefined;
  return stepInboxOf({ configurable });
}

/**
 * 建那一顆。**無狀態**：handle 每次從那一次呼叫的 `configurable` 現讀，同 `turn-cancel.ts`。
 *
 * @param scope - 掛在 root 的圖（預設）還是背景子代理的圖（{@link StepInboxScope}）。
 * @returns 可以放進 middleware 陣列的實例。
 */
export function createStepInboxMiddleware(scope: StepInboxScope = 'root'): AgentMiddleware {
  return createMiddleware({
    name: STEP_INBOX_MIDDLEWARE_NAME,
    beforeModel: async (_state: unknown, runtime: unknown) => {
      const messages = (await inboxOf(scope, runtime)?.claim()) ?? [];
      return messages.length > 0 ? { messages: [...messages] } : undefined;
    },
    afterAgent: {
      canJumpTo: ['model'],
      hook: async (_state: unknown, runtime: unknown) => {
        const inbox = inboxOf(scope, runtime);
        if (inbox === undefined) return undefined;
        // 不領：留在 `next-step` 的由下一輪開頭領走，同 dsh 按停止帶 `keepInbox`。窗不必在這裡關：pump 看到
        // 中止訊號就把之後的插話排進 `next-turn`。
        if (turnCancelSignalOf(runtime)?.aborted === true) return undefined;
        const messages = await inbox.finish();
        return messages.length > 0
          ? { messages: [...messages], jumpTo: 'model' as const }
          : undefined;
      },
    },
  }) as unknown as AgentMiddleware;
}

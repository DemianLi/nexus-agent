/**
 * `agent/pre-step` 接縫的**宿主端**（[#1474](https://github.com/DemianLi/nexus-agent/issues/1474) Q1 (a)、Q2 (a)）：把樹上插件登記的
 * listener（`@nexus/agent-loop` 的 `preStep`）建成 middleware。
 *
 * 建 middleware 要 core 的 `effectiveMessages`／`sourceKwargs`／`toLoggedMessage` 與 langchain 的 `createMiddleware`，定義套件
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
 * 1. 用 `effectiveMessages` 算出「模型看得到的那一串」。基座的摘要器不改寫 `state.messages`，只記一顆 `_summarizationEvent`，模型
 *    呼叫時才組 `[summary, ...messages.slice(cutoffIndex)]`；listener 要看的是後者（#397）。讀那顆私有鍵要宣告 `stateSchema`，
 *    見 {@link SUMMARIZATION_EVENT_VIEW}——插件因此不碰基座的私有鍵。
 * 2. 呼叫 listener，交 `{ configurable: runtime.configurable }`（**這個形狀**：原樣交給會話查找與 fs 查找才認得出這次呼叫；交裸的
 *    `configurable` 兩個查找都回 `unknown-caller`，注入會靜靜消失）。
 * 3. 把 listener 回的每一則建成使用者訊息：`additional_kwargs` 先放 listener 給的記號、**再**蓋 `source`（順序影響位元組，golden
 *    比對）；不加 `id`。
 * 4. 經**這條 thread 的** `registry.sessions.forCall` 記一筆 `user/message`；找不到或寫不進去就不記，訊息照送。**不走行程級的
 *    `session-lookup`**：那條多 thread 時可能 `ambiguous`，而這顆 middleware 本來就是這條 thread 的。
 * 5. 回 `{ messages }`，由基座追加。
 *
 * listener 拋錯**不吞**：它是插件寫的程式，吞掉會讓注入靜靜消失；同今天（舊外殼的 `discover` 自己吞檔案讀取錯誤，其餘不吞）。
 *
 * @module
 */

import { HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { PreStepListener } from '@nexus/agent-loop';
import { effectiveMessages, sourceKwargs, toLoggedMessage } from '@nexus/core';
import type { SessionLookup } from '@nexus/core';
import { createMiddleware } from 'langchain';
import type { AgentMiddleware } from 'langchain';
import { z } from 'zod';

/**
 * 讓 `beforeAgent` 讀得到基座摘要器的切點。
 *
 * middleware 的鉤子只看得到自己（與基座）宣告過的 state 鍵；不宣告的話 `state` 裡只有 `messages`（2026-09-18 實測）。
 * **這是基座的私有鍵**（`deepagents@1.13.1` 的 `SummarizationStateSchema`，原文註解就寫 “private state, not visible to agent”），
 * 所以型別刻意放寬成 `unknown`、只宣告「有這一格」，形狀交給 {@link effectiveMessages} 去認——認不出來就當沒摘要過，退回舊行為。
 * 鍵名與切點語意的上游絆索在 `apps/harness/src/agent-instructions.test.ts`。
 */
const SUMMARIZATION_EVENT_VIEW = z.object({ _summarizationEvent: z.unknown().optional() });

/**
 * 建一位 `agent/pre-step` listener 的 middleware。
 *
 * @param name - listener 登記時給的名字：middleware 的名字，也是日誌 `source.plugin`。
 * @param listener - 要叫的 listener。
 * @param sessions - **這條 thread 的**會話註冊表的 `forCall`（`registry.sessions`）：注入的訊息也記進日誌。
 * @returns 可以掛在任意多個 agent 上的 middleware。
 */
export function createPreStepMiddleware(
  name: string,
  listener: PreStepListener,
  sessions: { forCall(config: unknown): SessionLookup },
): AgentMiddleware {
  return createMiddleware({
    name,
    stateSchema: SUMMARIZATION_EVENT_VIEW,
    beforeAgent: async (
      state: { messages?: readonly BaseMessage[]; _summarizationEvent?: unknown },
      runtime?: { readonly configurable?: unknown },
    ) => {
      const visible = effectiveMessages(state.messages ?? [], state);
      const injections = await listener(visible, { configurable: runtime?.configurable });
      if (injections === undefined || injections.length === 0) return undefined;
      const messages = injections.map((injection) => {
        const message = new HumanMessage({
          content: injection.content,
          // 來源是 `plugin`（#662）：它注入的時機是一輪的開頭，今天緊接在人那句話之後所以沒事；以後哪個時刻
          // 它被補在一輪中間，重複提醒的鏈不會因它被悄悄清零。
          additional_kwargs: {
            ...injection.additionalKwargs,
            ...sourceKwargs({ kind: 'plugin', plugin: name }),
          },
        });
        record(sessions, runtime?.configurable, name, message);
        return message;
      });
      return { messages };
    },
  }) as unknown as AgentMiddleware;
}

/** 把注入的訊息記成 `user/message`。認不出屬於哪一份、或寫不進去，都不記。 */
function record(
  sessions: { forCall(config: unknown): SessionLookup },
  configurable: unknown,
  name: string,
  message: HumanMessage,
): void {
  const found = sessions.forCall({ configurable });
  if (found.kind !== 'ok') return;
  try {
    found.log.append('user/message', {
      message: toLoggedMessage(message),
      source: { kind: 'plugin', plugin: name },
    });
  } catch {
    // 訊息照樣送出。記不進去的後果是續接時重建不回來，不是這一輪少了這則訊息。
  }
}

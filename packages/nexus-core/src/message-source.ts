/**
 * 圖裡的 `HumanMessage` 是誰造的——**生產者自己宣告，讀的一端只認「人」**
 * （[#662](https://github.com/DemianLi/nexus-agent/issues/662)）。
 *
 * ## 為什麼要有這一格
 *
 * 重複工具提醒要在「人講話」時把鏈清零，而續行輪次的頭、結算通知、外掛塞進來的基線，在圖上全是素的
 * `HumanMessage`。以前的判準是 core 裡寫死的記號白名單，不在名單上的一律當成人：續行輪次每到頭就清零，
 * 模型在每個續行輪裡把同一個失敗呼叫重複兩次，提醒永遠不會到；以後哪個插件在一輪中間注入一則
 * `HumanMessage`，鏈會被悄悄清零，而且沒有測試會紅。
 *
 * 照 dsh：每則訊息帶 `source`，每個生產者在自己的模組宣告自己的 kind；提醒器只看 `source.kind === 'user'`
 * （`packages/guard/repeat-tool-reminder/src/index.ts:236-238`，`477b4f4`）。續行訊息帶
 * `{ kind: 'goal', goalId, revision, round }`（`packages/goal/goal-round-driver/src/index.ts:176-179`）。
 * 讀的一端沒有白名單，新的生產者不必改提醒器。
 *
 * ## 載體
 *
 * LangChain 的 `HumanMessage` 沒有 `source` 欄位，放在 `additional_kwargs` 上——跟提醒本身的
 * {@link REPEAT_REMINDER_MARKER} 同一個地方，會跟著 {@link toLoggedMessage} 進日誌、跟著重放回來。
 * **不偏離 dsh**：載體換了，判準沒換。
 *
 * ## 缺席就是人
 *
 * 沒有這一格的 `HumanMessage` 是人講的話（人打的字、插話）。**這是刻意的方向**：生產者忘了宣告，
 * 後果是它被當成人（鏈清零，提醒晚到），而不是被當成機器（人真的插了話卻不清零）。前者是今天的行為，
 * 後者會讓提醒在脈絡已經換掉之後還說「你一直在重複」。
 *
 * @module
 */

import { attachmentBlock } from './attachment-ref.js';
import type { AttachmentRef, FileBlock, ImageBlock } from './attachment-ref.js';
import { mentionHintBlock } from './subagent-mention.js';
import type { SubagentMentionRef } from './subagent-mention.js';
import { pageContextBlock } from './page-context.js';
import type { PageContextRef } from './page-context.js';
import type { MessageContent, NexusMessage } from './nexus-message.js';
import type { SessionEventMap } from './session-log.js';

/** 來源在 `additional_kwargs` 上的鍵。 */
export const MESSAGE_SOURCE_KWARG = 'nexus_source';

/**
 * 一則訊息的來源。`kind` 是判別欄，其餘是這個生產者想帶的細節。
 *
 * **`user` 是唯一「有人在」的那一種**；其餘一律是機器造的：`goal`（續行輪）、`plugin`（外掛注入）、
 * `subagent-settled`／`agent-message`（背景子代理）、`session-reference`（引用別的會話的快照）。
 * 新的生產者加自己的 kind，不必動讀的人。
 */
export interface MessageSource {
  readonly kind: string;
  readonly [detail: string]: unknown;
}

/** 讀一則訊息的來源。沒有、或形狀不對（不是帶字串 `kind` 的物件）就是 `undefined`。 */
export function messageSourceOf(
  message: { readonly additional_kwargs?: Record<string, unknown> } | undefined,
): MessageSource | undefined {
  if (message === undefined) return undefined;
  const raw: unknown = message.additional_kwargs?.[MESSAGE_SOURCE_KWARG];
  if (typeof raw !== 'object' || raw === null) return undefined;
  return typeof (raw as { kind?: unknown }).kind === 'string' ? (raw as MessageSource) : undefined;
}

/** 這則人話的來源是不是機器造的：**有來源、而且不是 `user`**。`BaseMessage` 那一支（`isMachineMessage`）在 `langchain-message-adapter.ts`。 */
export function isMachineSource(source: MessageSource | undefined): boolean {
  return source !== undefined && source.kind !== 'user';
}

/** 造一份只帶來源的 `additional_kwargs`，給 `new HumanMessage({ additional_kwargs })` 展開用。 */
export function sourceKwargs(source: MessageSource): Record<string, MessageSource> {
  return { [MESSAGE_SOURCE_KWARG]: source };
}

/**
 * 一顆 `turn/start` 的頭在圖上是哪一種來源。**每一種輸入各一個 kind**，跟日誌上 `turn/start.kind` 一一對應：
 * 人打的字（`message`）沒有來源，其餘四種都是機器造的。`resume` 沒有訊息（送進圖的是 `Command`），回 `undefined`。
 *
 * 窮舉（沒有 `default`）：日誌多一種 `turn/start` 時這裡編不過，而不是悄悄被當成人。
 */
export function turnStartSource(data: SessionEventMap['turn/start']): MessageSource | undefined {
  switch (data.kind) {
    case 'message':
    case 'resume':
      return undefined;
    case 'goal':
      return { kind: 'goal', goalId: data.goalId, revision: data.revision, round: data.round };
    case 'subagent-settled':
      return { kind: 'subagent-settled', senderSessionId: data.senderSessionId };
    case 'agent-message':
      return { kind: 'agent-message', senderSessionId: data.senderSessionId };
  }
}

/**
 * 人說的一句話在 `HumanMessage` 裡的內容（[#732](https://github.com/DemianLi/nexus-agent/issues/732)）：沒有附件就是那串字（跟以前
 * 逐位元組相同），有附件就是**附件區塊照選取順序在前、文字在後**（dsh 前端一律送 `[...附件, 文字]`，
 * `ui-conversation/src/client/service.ts:261-267`）；只有附件、沒有字時不放文字區塊。
 *
 * 存進圖與日誌的是**參照**（{@link attachmentBlock}）；變成模型看得到的字或圖是組請求時的事（`apps/harness` 的
 * `attachment-projection.ts`）。
 *
 * **點名**（[#328](https://github.com/DemianLi/nexus-agent/issues/328) 第 2 項）不是參照，是一個固定的文字區塊，接在文字之後（`subagent-mention.ts`）；
 * 沒有點名的訊息跟以前逐位元組相同。
 *
 * **畫面情境**（[#2367](https://github.com/DemianLi/nexus-agent/issues/2367)，嵌入的對話框附的）同點名，是接在點名之後的固定文字區塊（`page-context.ts`）。
 */
export function userContent(
  text: string,
  attachments?: readonly AttachmentRef[],
  mention?: SubagentMentionRef,
  context?: PageContextRef,
): string | (FileBlock | ImageBlock | { readonly type: 'text'; readonly text: string })[] {
  const hasAttachments = attachments !== undefined && attachments.length > 0;
  if (!hasAttachments && mention === undefined && context === undefined) return text;
  return [
    ...(hasAttachments ? attachments.map(attachmentBlock) : []),
    ...(text === '' ? [] : [{ type: 'text' as const, text }]),
    // 點名（#328 第 2 項）：接在使用者那句話**之後**，見 `subagent-mention.ts`。
    ...(mention === undefined ? [] : [mentionHintBlock(mention)]),
    ...(context === undefined ? [] : [pageContextBlock(context)]),
  ];
}

/**
 * 一顆 `turn/start` 送進圖的那則人話：文字加上它的來源。
 * **live 路徑（pump、CLI）與重放共用這一個函式**（live 路徑經 `langchain-message-adapter.ts` 的 `humanMessageForTurnStart` 轉成 `HumanMessage`），
 * 不然續接之後同一個位置的訊息會和即時的分岔。
 */
export function turnStartMessage(data: SessionEventMap['turn/start']): NexusMessage {
  // `resume` 送進圖的是 `Command`，不是訊息：呼叫端已經分開走，走到這裡是接線錯了，大聲拋。
  if (data.kind === 'resume') throw new Error('`resume` 沒有訊息可造：它送進圖的是 Command');
  const source = turnStartSource(data);
  return {
    type: 'human',
    data: {
      content: userContent(
        data.text,
        data.kind === 'message' ? data.attachments : undefined,
        data.kind === 'message' ? data.mention : undefined,
        data.kind === 'message' ? data.context : undefined,
      ) as MessageContent,
      ...(source === undefined ? {} : { additional_kwargs: sourceKwargs(source) }),
    },
  };
}

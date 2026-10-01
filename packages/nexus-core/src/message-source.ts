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

import { HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';

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
export function messageSourceOf(message: BaseMessage | undefined): MessageSource | undefined {
  if (message === undefined) return undefined;
  const raw: unknown = message.additional_kwargs?.[MESSAGE_SOURCE_KWARG];
  if (typeof raw !== 'object' || raw === null) return undefined;
  return typeof (raw as { kind?: unknown }).kind === 'string' ? (raw as MessageSource) : undefined;
}

/**
 * 這則 `HumanMessage` 是機器造的嗎——**有來源、而且不是 `user`**。
 * 不是 `HumanMessage` 也回 `false`：這個述詞問的是「人講話以外的 user-role 訊息」。
 */
export function isMachineMessage(message: BaseMessage | undefined): boolean {
  if (!HumanMessage.isInstance(message)) return false;
  const source = messageSourceOf(message);
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
 * 一顆 `turn/start` 送進圖的那則 `HumanMessage`：文字加上它的來源。
 * **live 路徑（pump、CLI）與重放共用這一個函式**，不然續接之後同一個位置的訊息會和即時的分岔。
 */
export function humanMessageForTurnStart(data: SessionEventMap['turn/start']): HumanMessage {
  // `resume` 送進圖的是 `Command`，不是訊息：呼叫端已經分開走，走到這裡是接線錯了，大聲拋。
  if (data.kind === 'resume') throw new Error('`resume` 沒有訊息可造：它送進圖的是 Command');
  const source = turnStartSource(data);
  return new HumanMessage({
    content: data.text,
    ...(source === undefined ? {} : { additional_kwargs: sourceKwargs(source) }),
  });
}

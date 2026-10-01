/**
 * 「這一項是不是一輪的開頭」（[#859](https://github.com/DemianLi/nexus-agent/issues/859)）：畫面按輪歸位
 * （交付卡、改動卡）與按輪配對（提問的答案、停在提問上的判斷）時，用這一格切輪，不靠 `turnTail`。
 *
 * 三種都算：**人的話**、背景子代理的**結算通知**、背景子代理**寄來的話**。後兩種在主對話閒著時叫醒新的一輪，
 * 那一輪沒有人的話；放在人話本來會出現的位置（見 `NoticeEntry`、`AgentMessageEntry`）。
 *
 * **輪中插進來的那一種也照樣切**：忙著時被領走的通知與子代理的話，跟人在輪中插話一樣——原本就把交付卡切成兩張
 * （`transcriptItems`），這裡不另立規則。即時（`inbox:<id>`）與歷史重播（`history-<seq>`）長在同一個位置，重新整理
 * 前後切出來的輪一樣。
 *
 * @module
 */

import type { ConversationEntry } from '@nexus/wire';

/** 這一項是不是把一輪切開的那一格。 */
export function startsTurn(entry: ConversationEntry): boolean {
  return entry.kind === 'human' || entry.kind === 'notice' || entry.kind === 'agent-message';
}

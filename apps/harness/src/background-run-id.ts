/**
 * 背景子代理的編號長什麼樣（[#832](https://github.com/DemianLi/nexus-agent/issues/832)）。
 *
 * 單獨一個檔，是因為認編號的兩頭互相引用：產生編號的 `background-subagents.ts` 已經引用 pump 的
 * 投影型別，pump 再引回去就成環。
 *
 * @module
 */

import type { SessionAddress } from '@nexus/core';

/** 編號的前綴：`bg-` 加隨機，不是計數器（root 續接之後不能撞上舊日誌）。 */
export const BACKGROUND_RUN_PREFIX = 'bg-';

/** 這個地址是不是背景子代理的：它的串流由 host 自己排空，線上不會有基座的 frame，卡只能由日誌開、日誌收。 */
export function isBackgroundAddress(address: SessionAddress): boolean {
  return address.kind === 'subagent' && address.runId.startsWith(BACKGROUND_RUN_PREFIX);
}

/**
 * 背景子代理寫給主對話（或主對話追加給它）的話，送進模型時的前綴（dsh 原文，`477b4f4`）。
 *
 * **前綴是給模型看的，web 不解析它**（[#863](https://github.com/DemianLi/nexus-agent/issues/863)）：折疊器拿到的是
 * {@link agentMessageBody} 拿掉前綴的版本。
 */
export function agentMessagePrefix(senderSessionId: string): string {
  return `Agent ${senderSessionId} sent a message: `;
}

/** 送進模型的整段字：{@link agentMessagePrefix} 加上話本身。 */
export function agentMessageText(senderSessionId: string, message: string): string {
  return `${agentMessagePrefix(senderSessionId)}${message}`;
}

/** 拿掉 {@link agentMessagePrefix}；不是這個寄件人的前綴開頭就原樣回（不猜）。 */
export function agentMessageBody(senderSessionId: string, text: string): string {
  const prefix = agentMessagePrefix(senderSessionId);
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

/** 背景子代理的會話 id（`<root>/<runId>`）裡的編號。 */
export function runIdOfSession(sessionId: string): string {
  return sessionId.slice(sessionId.lastIndexOf('/') + 1);
}

import { DELEGATION_TOOL_NAMES, isBackgroundSubagentMeta } from '@nexus/wire';
import type { Attribution, ConversationEntry } from '@nexus/wire';

import { firstLine } from '@/lib/tool-view';

/**
 * 背景子代理在對話裡怎麼被叫出來（[#861](https://github.com/DemianLi/nexus-agent/issues/861)）。資料是折疊器的項目：
 * 派出那顆委派卡的結果 meta 帶著 `runId` 與子代理的名字（`subagentType`），子代理寄來的話
 * （`AgentMessageEntry`）與管理工具的參數都只帶 `runId`，名字要從那顆委派卡對回來。
 *
 * @module
 */

/** 模型看到的工具名（`apps/harness/src/background-delegation.ts` 的 `SEND_MESSAGE_TOOL_NAME`，照 dsh）。 */
export const SEND_MESSAGE = 'send_message';

/** 對不到名字時的稱呼：重新整理後委派卡不在了、或編號不是這條對話派出去的。寧可說不知道，不要說錯。 */
export const UNKNOWN_SUBAGENT_LABEL = '背景子代理';

/** `runId` → 子代理的名字，從對話裡所有背景委派卡收來。 */
export function subagentNames(entries: readonly ConversationEntry[]): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const entry of entries) {
    if (entry.kind !== 'tool' || !DELEGATION_TOOL_NAMES.includes(entry.name)) continue;
    if (isBackgroundSubagentMeta(entry.meta)) names.set(entry.meta.runId, entry.meta.subagentType);
  }
  return names;
}

/** 這個編號叫什麼；對不到就是 {@link UNKNOWN_SUBAGENT_LABEL}。 */
export function subagentLabel(names: ReadonlyMap<string, string>, runId: string): string {
  const name = names.get(runId);
  return name === undefined || name === '' ? UNKNOWN_SUBAGENT_LABEL : name;
}

/** 子代理寄來的話上面那一行：「某某子代理說」。 */
export function agentMessageCaption(label: string): string {
  return `${label} 說`;
}

/**
 * `send_message` 的標題。**同一個工具兩個方向**：主對話傳給子代理，子代理也用它回報給主對話（#849）。子代理自己
 * 呼叫的那顆卡掛在它名下（歸屬是 `subagent`），寫「傳訊給子代理」是說反了。
 */
export function sendMessageTitle(attribution: Attribution): string {
  return attribution.kind === 'subagent' ? '傳訊給主對話' : '傳訊給子代理';
}

/**
 * `send_message` 收合時那一行：「傳給某某：訊息的第一行」。參數形狀不對（串流中途截斷、壞 JSON）就是 `undefined`，
 * 卡片退回通用的摘要。
 *
 * 子代理回報給主對話時 `agent_id` 是主對話的編號，不在名字表裡，也不該去對：直接寫「主對話」。
 */
export function sendMessageSummary(
  input: string,
  attribution: Attribution,
  names: ReadonlyMap<string, string>,
): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return undefined;
  }
  const { agent_id: agentId, message } = (parsed ?? {}) as {
    agent_id?: unknown;
    message?: unknown;
  };
  if (typeof agentId !== 'string' || typeof message !== 'string' || message.trim() === '') {
    return undefined;
  }
  const to = attribution.kind === 'subagent' ? '主對話' : subagentLabel(names, agentId);
  return `傳給 ${to}：${firstLine(message.trim())}`;
}

import { DELEGATION_TOOL_NAMES, isBackgroundSubagentMeta } from '@nexus/wire';
import type { Attribution, BackgroundSubagentMeta, ConversationEntry } from '@nexus/wire';

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

/**
 * 推理等級的名字在畫面上怎麼說。harness 那邊是型錄條目宣告過的名字，今天只有 `off`；不認得的（型錄以後多出來的）
 * 照原樣畫，不猜它的意思。
 */
export const SUBAGENT_REASONING_LABEL: Readonly<Record<string, string>> = { off: '關閉' };

/**
 * 委派卡展開時那一行「這個子代理跑哪一顆模型」（[#889](https://github.com/DemianLi/nexus-agent/issues/889)）。
 * 資料是派出那一刻就定的事實，放在委派卡結果的 `meta`、隨日誌落盤，所以重新整理後還在。
 *
 * - 兩欄都沒有（模型沒替它挑）：沒有這一行，**不寫「跟著主對話」**——那是推論，不是 wire 說的。
 * - 只給推理等級時 harness 會把 `model` 填成主對話當時那一顆，所以正常不會只剩一欄；只剩推理等級（資料不完整）
 *   就只說推理，不編模型名。
 * - 空字串當沒有。
 */
export function subagentModelText(
  meta: Pick<BackgroundSubagentMeta, 'model' | 'reasoningEffort'>,
): string | undefined {
  const model = meta.model === undefined || meta.model === '' ? undefined : meta.model;
  const effort =
    meta.reasoningEffort === undefined || meta.reasoningEffort === ''
      ? undefined
      : (SUBAGENT_REASONING_LABEL[meta.reasoningEffort] ?? meta.reasoningEffort);
  if (model === undefined) return effort === undefined ? undefined : `推理：${effort}`;
  return effort === undefined ? `模型：${model}` : `模型：${model}（推理：${effort}）`;
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

/**
 * 背景子代理「現在」的狀態，從折疊器的 `subagentStatus`（#870）與委派卡的 `runId` 算出來。
 *
 * - `null`（還沒收到快照）：分不出來，`unknown`。有背景派出的組裝一接上就會送快照，所以這只是短暫的。
 * - 在快照裡：`running`／`idle`。**`idle` 含兩種**：已結算還能被叫醒的，和被單獨停止而暫停的，分不出來；對人來說都是
 *   「現在沒在跑，再對它說話會讓它再跑一輪」。
 * - 收過快照而不在裡面：`closed`（收線）。委派卡來自 root 日誌，重新整理後還在，所以歷史裡有、這裡沒有的編號一律是收線。
 */
export type SubagentRunState = 'running' | 'idle' | 'closed' | 'unknown';

export function subagentRunState(
  status: Readonly<Record<string, 'running' | 'idle'>> | null,
  runId: string,
): SubagentRunState {
  if (status === null) return 'unknown';
  return status[runId] ?? 'closed';
}

/** 委派卡標頭上那個小狀態字；還不知道就不畫。 */
export const SUBAGENT_STATE_LABEL = {
  running: '跑著',
  idle: '閒著',
  closed: '已收線',
  unknown: undefined,
} as const satisfies Record<SubagentRunState, string | undefined>;

/**
 * 輸入框的佔位字（#869 Q2）。**還不知道（`unknown`）當跑著**，避免一接上就閃一下停用。
 * 連線斷了是另一件事，由呼叫端先擋（連線中…）。
 */
export function subagentPlaceholder(state: SubagentRunState): string {
  switch (state) {
    case 'idle':
      return '對它說話（會喚醒它）';
    case 'closed':
      return '這個子代理已結束';
    case 'running':
    case 'unknown':
      return '對它說話（下一步送進去）';
  }
}

/** 收線了就沒有人可以說話；其餘都送得出去（連線另外看）。 */
export function canSendToSubagent(state: SubagentRunState, connected: boolean): boolean {
  return connected && state !== 'closed';
}

/** 單獨停止只在它跑著時有意思；`unknown` 當跑著。 */
export function canStopSubagent(state: SubagentRunState): boolean {
  return state === 'running' || state === 'unknown';
}

/** `subagent.send` 被拒時講給人聽的一句（#869 Q1）。不認得的碼退回伺服器的 `message`。 */
export function subagentSendError(code: string, message: string): string {
  switch (code) {
    case 'subagent_not_found':
      return '找不到這個子代理，它可能已經結束。';
    case 'subagent_at_capacity':
      return '同時運作的子代理已滿，請等其中一個做完再試。';
    case 'subagent_closed':
      return '這條對話正在關閉，沒辦法再送話。';
    case 'invalid_argument':
      return '內容不能是空白。';
    default:
      return `沒送出去：${message}`;
  }
}

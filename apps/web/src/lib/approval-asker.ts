import type { ConversationState, PendingInput } from '@nexus/wire';

import { firstLine } from '@/lib/tool-view';

/**
 * 這顆待答的中斷是誰在問（[#328](https://github.com/DemianLi/nexus-agent/issues/328) 第 1 項：前景子代理要核准時交給人）。
 *
 * 前景子代理在 `task` 的同一次呼叫裡跑，它要核准的操作會往上傳到 root，下行只有一顆 `input.requested`，`namespace[0]` 是
 * `tools:<uuid>`（root 自己的核准是 `[]`）。畫面靠折疊器已經 join 好的 `state.subagents`（`namespace[0]` → 委派卡的 `callId`
 * 與子代理的名字）認出是誰，再從那張委派卡的參數拿 `description`——**沿用委派卡上的字**，不另編。
 *
 * - `namespace` 是空的：root 自己問的，`undefined`（畫面不多寫一個字，跟以前逐字相同）。實機量過：root 的 write_file、
 *   request_sandbox_escalation 核准都是 `namespace: []`。
 * - 有 `namespace` 但對不到委派卡：**只說「子代理」**，不編名字也不編 `description`。典型是重新整理之後——即時那條線沒有重播、
 *   歷史讀的是 root 那份日誌，`state.subagents` 接不回（實機：核准卡還在、委派卡還是「執行中」，但認不出是哪一位）。
 *   此時 `namespace` 非空本身就是證據：root 的核准是 `[]`，非空只會是委派呼叫底下來的。名字與在做的事沒有證據，所以不寫。
 *
 * @module
 */

export interface PendingAsker {
  /** 例如「子代理「explore」」；對不到名字時是「子代理」。 */
  readonly label: string;
  /** 委派卡上寫的那件事（`description`），單行；沒有就沒有。 */
  readonly description?: string;
}

const UNNAMED = '子代理';

export function pendingAsker(
  state: Pick<ConversationState, 'subagents' | 'entries'>,
  pending: Pick<PendingInput, 'namespace'>,
): PendingAsker | undefined {
  const key = pending.namespace[0];
  if (key === undefined) return undefined;
  const found = state.subagents[key];
  // 對不到委派卡：還是知道是子代理（`namespace` 非空），只是不知道是哪一位（見檔頭）。
  if (found === undefined) return { label: UNNAMED };
  const label = found.name === '' ? UNNAMED : `${UNNAMED}「${found.name}」`;
  const card = state.entries.find(
    (entry) => entry.kind === 'tool' && entry.callId === found.callId,
  );
  const description = card?.kind === 'tool' ? descriptionOf(card.input) : undefined;
  return description === undefined ? { label } : { label, description };
}

function descriptionOf(input: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return undefined;
  }
  const value = (parsed as { description?: unknown } | null)?.description;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  return firstLine(value.trim());
}

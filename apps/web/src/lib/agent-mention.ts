/*
 * 輸入框的 `@子代理` 提及（[#328](https://github.com/DemianLi/nexus-agent/issues/328) 第 2 項）：這一輪委派給哪一個子代理。
 *
 * 跟 `lib/session-mention.ts` 不同的兩件事（那一段是「引用一條已經存在的會話」）：
 *
 * - **選了之後不進草稿**。`@` 那一段從草稿拿掉，換成輸入框上方的一顆標記（{@link AgentMentionState.selected}），
 *   整顆刪掉就是取消。**送出時走 `run.start` 的 `mention` 欄位**，不轉成文字塞進 `input`（那是 harness 的語意）。
 * - **一句話最多一個**：再選一個就取代前一個。
 *
 * **有沒有這個功能看 server**：`subagent.list` 回 `not_supported`（還沒實作的 server）、被拒或拋錯，整個功能就不出現
 * （`hooks/use-agent-mention.ts`），跟模型座同一個做法。附件寫死開關是因為沒有可以先問的 RPC，這裡有。
 * 送出時 `run.start` 帶 `mention`（{@link toMention}）；server 回 `not_supported` 時送出失敗、說出原因、草稿與標記留著
 * （`hooks/use-conversation.ts`）。
 *
 * @module
 */

import type { SubagentKind, SubagentMention } from '@nexus/wire';

import type { MentionHit } from '@/lib/file-mention';

/** 可以被委派的子代理。 */
export interface MentionAgent {
  readonly id: string;
  /** 選單與標記上寫的名字。 */
  readonly name: string;
  /** 一句話說它做什麼；選單上寫在名字後面。 */
  readonly description: string;
}

/** 輸入框收子代理提及需要的三件事；**沒給就沒有這個功能**，同 `fileReferences` 的給法。 */
export interface AgentMentionState {
  readonly agents: readonly MentionAgent[];
  /** 目前選的那一個；沒有就是沒選。 */
  readonly selected: MentionAgent | undefined;
  /** 選了一個（取代前一個），或取消（`undefined`）。 */
  readonly onSelect: (agent: MentionAgent | undefined) => void;
}

/** server 回的一種子代理換成選單用的：註冊的名字就是身分。 */
export function agentsFromKinds(kinds: readonly SubagentKind[]): readonly MentionAgent[] {
  return kinds.map((kind) => ({ id: kind.name, name: kind.name, description: kind.description }));
}

/** 選中的子代理換成 `run.start` 的 `mention`。 */
export function toMention(agent: MentionAgent): SubagentMention {
  return { kind: 'subagent', name: agent.name };
}

/** 選單上的一列子代理。 */
export interface AgentMentionRow {
  readonly source: 'agent';
  readonly agent: MentionAgent;
  readonly name: string;
  readonly hint: string;
}

/** 名字或說明含有查詢（不分大小寫）的子代理，照清單順序。查詢是空的就全列。 */
export function agentRows(
  agents: readonly MentionAgent[],
  query: string,
): readonly AgentMentionRow[] {
  const needle = query.trim().toLowerCase();
  return agents
    .filter(
      (agent) =>
        needle === '' ||
        agent.name.toLowerCase().includes(needle) ||
        agent.description.toLowerCase().includes(needle),
    )
    .map((agent) => ({ source: 'agent', agent, name: agent.name, hint: agent.description }));
}

export interface AgentMentionPick {
  readonly draft: string;
  readonly caret: number;
}

/**
 * 選了一個子代理之後草稿變成什麼：`@` 那一段拿掉，游標留在原處。前後都是空白（或字首）時多出來的那個空白一起收掉，
 * 不留兩個連著的。
 */
export function applyAgentPick(draft: string, hit: MentionHit): AgentMentionPick {
  const before = draft.slice(0, hit.start);
  let after = draft.slice(hit.end);
  if ((before === '' || /\s$/u.test(before)) && after.startsWith(' ')) after = after.slice(1);
  return { draft: before + after, caret: before.length };
}

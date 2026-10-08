/*
 * 輸入框的 `@子代理` 提及（[#328](https://github.com/DemianLi/nexus-agent/issues/328) 第 2 項）：這一輪委派給哪一個子代理。
 *
 * 跟 `lib/session-mention.ts` 不同的兩件事（那一段是「引用一條已經存在的會話」）：
 *
 * - **選了之後不進草稿**。`@` 那一段從草稿拿掉，換成輸入框上方的一顆標記（{@link AgentMentionState.selected}），
 *   整顆刪掉就是取消。**送出時怎麼帶上它是連線契約的事**，不轉成文字塞進 `input`（那是 harness 的語意）。
 * - **一句話最多一個**：再選一個就取代前一個。
 *
 * **整個功能藏在一個寫死的開關後面**（{@link agentMentionEnabled}），同附件（`serverSupportsAttachments`）與會話管理
 * （`threadManagementEnabled`）的做法：沒開時 `@` 選單沒有「委派給」那一段、也沒有標記，畫面與以前逐像素相同。
 * 清單目前是寫死的假資料（{@link FAKE_AGENTS}）；伺服器端的子代理清單與 `run.start` 的提及欄位合進 develop 之後，
 * 另開一張 PR 把清單接上 server、開關改成 `true`。
 *
 * @module
 */

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

/**
 * 有沒有 `@子代理` 提及。**寫死 `false`，不在執行期探測**，理由同 `serverSupportsAttachments`：伺服器端有沒有落地
 * 是出貨時就知道的事。契約（子代理清單、`run.start` 的提及欄位）合進 develop 之後，**另開一張 PR 把這裡改成 `true`**
 * 並把假資料換成 server 的清單。
 */
export function agentMentionEnabled(): boolean {
  return false;
}

/** 假資料：契約定下來之前讓畫面有東西可選。 */
export const FAKE_AGENTS: readonly MentionAgent[] = [
  { id: 'explorer', name: 'explorer', description: '唯讀地探索程式碼、回報結構' },
  { id: 'reviewer', name: 'reviewer', description: '審查一段變更，列出風險' },
  { id: 'planner', name: 'planner', description: '把任務拆成可以逐步驗證的計劃' },
  { id: 'tester', name: 'tester', description: '補測試並實際跑過' },
];

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

/**
 * 「工具名 → 用哪種畫法、專屬標題、專屬摘要」那一張表。形狀照 dsh
 * `packages/client/ui-tool/src/client/tool/models/tool-call-model.ts`（本機 clone `ddefc45`，MIT）——
 * 七類 variant、一張「工具名 → variant」的表、查不到就是 `others`。
 * **表的內容照 nexus 實際的工具名**（deepagents 基座＋各 plugin 匯出的 `*_TOOL_NAME`），不是 dsh 的。
 *
 * 加一顆只有標題的工具：在 {@link TOOLS} 加一列（`adapter` 寫 `others`）。要專屬畫法：在 `adapters.ts` 加一個 adapter，
 * 表上指過去。`view.test.ts` 列著每一個實際工具名，漏了會紅。
 *
 * 工具名清單：
 *
 * - 基座（deepagents 1.13）：`ls`、`read_file`、`write_file`、`edit_file`、`delete`、`glob`、`grep`、`execute`、`task`。
 * - `@nexus/plugin-quickjs`：`run_javascript`。
 * - 委派子代理的 `subagent`（預設關，開了之後模型視野裡取代 `task`）：同 `task`。
 * - 背景子代理的三顆管理工具 `list_agents`、`interrupt_agent`、`send_message`（名字照 dsh，#737）：純文字結果，只有標題，不做專屬卡。
 * - 子代理選模型的 `list_subagent_models`（有政策才有，#877）：同上，純文字、只有標題。
 * - 從會話日誌讀回被摘要原文的 `history_read`、`history_search`（#2777）：純文字結果，不做專屬卡。
 * - `@nexus/plugin-sandbox-policy` 的 `request_sandbox_escalation`。
 *
 * @module
 */

import { HOST_TOOL_PREFIX } from '@nexus/wire';

import { ADAPTERS } from '@/features/tool/adapters';
import type { ToolAdapter } from '@/features/tool/adapter';
import { ESCALATION_TITLE, SANDBOX_ESCALATION_TOOL } from '@/features/tool/sandbox-escalation';

/** 表上的一列。 */
export interface ToolRow {
  readonly adapter: ToolAdapter;
  /** 歸在這一類但有自己名字的工具：標題講它在做什麼，不是這一類的通用標題。照 dsh `TOOL_TITLE_KEYS`（它給 run／stop／undefine 這類歸 others 的工具各自的標題）。 */
  readonly title?: string;
  /**
   * 專屬摘要：回 `undefined` 就退到 adapter 的欄位挑法。字串不必先截，`toolSummary` 統一截第一行。
   * `copy_file` 兩個路徑都有時寫成「來源 → 目的」；只挑一個路徑看不出從哪裡複製到哪裡（#2289）。
   */
  readonly summary?: (args: Readonly<Record<string, unknown>>) => string | undefined;
}

const { read, search, bash, write, edit, code, others } = ADAPTERS;

function copySummary(args: Readonly<Record<string, unknown>>): string | undefined {
  const { source_path: from, destination_path: to } = args;
  return typeof from === 'string' && from !== '' && typeof to === 'string' && to !== ''
    ? `${from} → ${to}`
    : undefined;
}

/** 認得的工具名 → 那一列。`others` 又沒有專屬標題的不用列：查不到就是它。 */
export const TOOLS: Readonly<Record<string, ToolRow>> = {
  ls: { adapter: read },
  read_file: { adapter: read },
  glob: { adapter: search },
  grep: { adapter: search },
  write_file: { adapter: write },
  edit_file: { adapter: edit },
  execute: { adapter: bash },
  run_javascript: { adapter: code },
  echo: { adapter: others, title: '回聲' },
  // 刪檔不能復原（基座的工具說明寫明），標題不能是一句「工具」；參數只有 `file_path`，摘要退到第一個字串值就是它（#672）。
  delete: { adapter: others, title: '刪除檔案' },
  copy_file: { adapter: others, title: '複製檔案', summary: copySummary },
  task: { adapter: others, title: '委派子代理' },
  subagent: { adapter: others, title: '委派子代理' },
  list_agents: { adapter: others, title: '列出子代理' },
  interrupt_agent: { adapter: others, title: '停止子代理' },
  send_message: { adapter: others, title: '傳訊給子代理' },
  list_subagent_models: { adapter: others, title: '列出可選的子代理模型' },
  todo_write: { adapter: others, title: '更新待辦' },
  create_goal: { adapter: others, title: '設定目標' },
  get_goal: { adapter: others, title: '查看目標' },
  update_goal: { adapter: others, title: '更新目標' },
  exit_plan_mode: { adapter: others, title: '交出計劃' },
  ask_user_question: { adapter: others, title: '提問' },
  // #441：harness 那半還沒合；工具名照 dsh `tool-present`，合進來時 `tool-view.test.ts` 會從原始碼讀到它。
  present: { adapter: others, title: '交付檔案' },
  // 同核准面板的名稱（#1292）：同一件事只有一種說法，改字只改 `features/tool/sandbox-escalation.ts`。
  [SANDBOX_ESCALATION_TOOL]: { adapter: others, title: ESCALATION_TITLE },
  submit_record: { adapter: others, title: '提交紀錄' },
  history_read: { adapter: read, title: '讀回被摘要的原文' },
  history_search: { adapter: search, title: '搜尋被摘要的原文' },
};

const UNKNOWN: ToolRow = { adapter: others };

/** 這個工具名在表上有沒有明寫。 */
export function isKnown(name: string): boolean {
  return Object.hasOwn(TOOLS, name);
}

/** 這個工具名對應的那一列；表上沒有的（MCP 的、宿主頁工具）是 `others` 的通用列。 */
export function rowOf(name: string): ToolRow {
  return Object.hasOwn(TOOLS, name) ? (TOOLS[name] ?? UNKNOWN) : UNKNOWN;
}

/** 這個工具名用哪一種畫法。 */
export function adapterOf(name: string): ToolAdapter {
  return rowOf(name).adapter;
}

/** 宿主頁工具（#2374）的標題前面那幾個字，後面接宣告時的名字。 */
const HOST_TOOL_TITLE_PREFIX = '頁面工具：';

/**
 * 工具卡的標題。`page__` 開頭的是宿主頁工具，名字是宿主頁執行期宣告的、不進表，標題是 {@link HOST_TOOL_TITLE_PREFIX} 加上宣告時的名字；
 * 其餘查表上那一列的專屬標題，沒有就用那一類的通用標題。
 */
export function titleOf(name: string): string {
  if (name.startsWith(HOST_TOOL_PREFIX)) {
    return `${HOST_TOOL_TITLE_PREFIX}${name.slice(HOST_TOOL_PREFIX.length)}`;
  }
  const row = rowOf(name);
  return row.title ?? row.adapter.title;
}

/**
 * 工具卡怎麼呈現（規格 §4.2 列 14）：依工具名分類＋通用卡兜底。形狀照 dsh
 * `packages/client/ui-tool/src/client/tool/models/tool-call-model.ts`（本機 clone `ddefc45`，MIT）——
 * 七類 variant、一張「工具名 → variant」的表、查不到就是 `others`、摘要從參數挑一個欄位。
 * **表的內容照 nexus 實際的工具名**（deepagents 基座＋各 plugin 匯出的 `*_TOOL_NAME`），不是 dsh 的。
 *
 * **這一份只管參數，不管輸出**：結果文字現在有了（`ToolEntry.text`，[#439](https://github.com/DemianLi/nexus-agent/issues/439)
 * 之後 harness 從會話日誌的 `tool/result` 抽，即時與重播同一串），但**只有 `ask_user_question` 在用**
 * （`lib/question-view.ts` 解 `{answers}` 逐題配）。其他工具要不要畫輸出是另一個決定，#439 沒有做。
 *
 * 新增工具時在 {@link TOOL_VARIANTS}（或 {@link TOOL_TITLES}）加一列；`tool-view.test.ts` 列著每一個實際工具名，
 * 漏了會紅。
 *
 * @module
 */

/** 工具卡的呈現類別。 */
export type ToolVariant = 'search' | 'read' | 'bash' | 'write' | 'edit' | 'code' | 'others';

/** 每一類的標題。 */
export const VARIANT_TITLE: Record<ToolVariant, string> = {
  search: '搜尋',
  read: '讀取',
  bash: '執行指令',
  write: '寫入檔案',
  edit: '編輯檔案',
  code: '執行程式',
  others: '工具',
};

/**
 * 認得的工具名 → 類別。`others` 不用列：查不到就是它。
 *
 * - 基座（deepagents 1.13）：`ls`、`read_file`、`write_file`、`edit_file`、`glob`、`grep`、`execute`、`task`。
 * - `@nexus/plugin-quickjs`：`run_javascript`。
 * - 標題表另含 `apps/harness` 的 `request_sandbox_escalation`。
 */
const TOOL_VARIANTS: Readonly<Record<string, ToolVariant>> = {
  ls: 'read',
  read_file: 'read',
  glob: 'search',
  grep: 'search',
  write_file: 'write',
  edit_file: 'edit',
  execute: 'bash',
  run_javascript: 'code',
};

/**
 * 歸在 `others` 但有自己名字的工具：標題講它在做什麼，不是一句「工具」。照 dsh `TOOL_TITLE_KEYS`
 * （它給 run／stop／undefine 這類歸 others 的工具各自的標題）。
 */
const TOOL_TITLES: Readonly<Record<string, string>> = {
  echo: '回聲',
  task: '委派子代理',
  todo_write: '更新待辦',
  create_goal: '設定目標',
  get_goal: '查看目標',
  update_goal: '更新目標',
  exit_plan_mode: '交出計劃',
  ask_user_question: '提問',
  // #441：harness 那半還沒合；工具名照 dsh `tool-present`，合進來時 `tool-view.test.ts` 會從原始碼讀到它。
  present: '交付檔案',
  request_sandbox_escalation: '申請放寬沙箱',
  submit_record: '提交紀錄',
};

export function classifyTool(name: string): ToolVariant {
  return TOOL_VARIANTS[name] ?? 'others';
}

/** 這個工具名在表上有沒有明寫（`tool-view.test.ts` 用它確認每個實際工具都分過類）。 */
export function isKnownTool(name: string): boolean {
  return name in TOOL_VARIANTS || name in TOOL_TITLES;
}

export function toolTitle(name: string): string {
  return TOOL_TITLES[name] ?? VARIANT_TITLE[classifyTool(name)];
}

/** 摘要從參數挑哪個欄位（照 dsh `SUMMARY_KEYS`，欄位名換成 nexus 工具實際的）。 */
const SUMMARY_KEYS: Record<ToolVariant, readonly string[]> = {
  read: ['file_path', 'path'],
  search: ['pattern', 'query', 'path'],
  bash: ['description', 'command'],
  write: ['file_path', 'path'],
  edit: ['file_path', 'path'],
  code: ['description'],
  others: ['description', 'objective', 'text', 'message', 'reason'],
};

function parseArgs(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    // 參數不是 JSON（串流中途截斷、壞 JSON #281）：摘要與內容退回原字串。
    return undefined;
  }
}

function firstLine(text: string): string {
  const newline = text.indexOf('\n');
  return newline === -1 ? text : text.slice(0, newline);
}

/** 收合時那一行的摘要。挑不到欄位就拿第一個字串值，再不行就是參數原文的第一行。 */
export function toolSummary(name: string, input: string): string {
  const parsed = parseArgs(input);
  if (typeof parsed !== 'object' || parsed === null) return firstLine(input);
  const args = parsed as Record<string, unknown>;
  for (const key of SUMMARY_KEYS[classifyTool(name)]) {
    const value = args[key];
    if (typeof value === 'string' && value !== '') return firstLine(value);
  }
  for (const value of Object.values(args)) {
    if (typeof value === 'string' && value !== '') return firstLine(value);
  }
  return firstLine(input);
}

/** 展開後的參數：`code` 類直接是那段程式、`bash` 類是那行指令，其他是排好的 JSON（照 dsh `formatToolBody`）。 */
export function toolInputBody(
  name: string,
  input: string,
): { readonly text: string; readonly lang: string } | undefined {
  if (input === '') return undefined;
  const parsed = parseArgs(input);
  if (parsed === undefined) return { text: input, lang: 'text' };
  const variant = classifyTool(name);
  if (typeof parsed === 'object' && parsed !== null) {
    const args = parsed as Record<string, unknown>;
    if (variant === 'code' && typeof args.code === 'string' && args.code !== '') {
      return { text: args.code, lang: 'js' };
    }
    if (variant === 'bash' && typeof args.command === 'string' && args.command !== '') {
      return { text: args.command, lang: 'bash' };
    }
  }
  return { text: JSON.stringify(parsed, null, 2), lang: 'json' };
}

export { firstLine };

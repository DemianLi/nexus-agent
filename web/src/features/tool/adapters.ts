/**
 * 七種畫法（`ToolVariant`），一種一個 {@link ToolAdapter}。沒有專屬行為的畫法（`others`）只帶標題與摘要欄位。
 * 哪顆工具用哪一種見 `features/tool/tools.ts`。
 *
 * 摘要欄位照 dsh `SUMMARY_KEYS`，欄位名換成 nexus 工具實際的。
 *
 * @module
 */

import type { ToolAdapter, ToolVariant } from '@/features/tool/adapter';
import { readCardOf, searchCardOf } from '@/features/tool/result-card';
import { toolDiffView } from '@/shared/lib/tool-diff';

/** `code` 類展開後直接是那段程式。 */
function codeBody(args: Readonly<Record<string, unknown>>) {
  return typeof args.code === 'string' && args.code !== ''
    ? { text: args.code, lang: 'js' }
    : undefined;
}

/** `bash` 類展開後是那行指令。 */
function commandBody(args: Readonly<Record<string, unknown>>) {
  return typeof args.command === 'string' && args.command !== ''
    ? { text: args.command, lang: 'bash' }
    : undefined;
}

/**
 * 讀檔類的結果檢視：`read_file` 是讀檔卡。`ls` 也歸這一類（標題「讀取」），但 harness 給它的 `meta` 是 glob 的路徑形狀
 * （#948、#1038），畫的是搜尋的路徑卡，所以沒有讀檔卡時退到搜尋卡。兩個驗證函式各自認得自己的工具名，
 * 這一類的其他工具（`history_read`）兩邊都不認，走通用結果文字。
 */
const read: ToolAdapter = {
  variant: 'read',
  title: '讀取',
  summaryKeys: ['file_path', 'path'],
  result(entry) {
    const readCard = readCardOf(entry);
    if (readCard !== undefined) return { kind: 'read', card: readCard };
    const searchCard = searchCardOf(entry);
    return searchCard === undefined ? undefined : { kind: 'search', card: searchCard };
  },
};

const search: ToolAdapter = {
  variant: 'search',
  title: '搜尋',
  summaryKeys: ['pattern', 'query', 'path'],
  result(entry) {
    const card = searchCardOf(entry);
    return card === undefined ? undefined : { kind: 'search', card };
  },
};

const bash: ToolAdapter = {
  variant: 'bash',
  title: '執行指令',
  summaryKeys: ['description', 'command'],
  inputBody: commandBody,
};

/** 寫檔與改檔的 diff 由共用層算（`toolDiffView` 還有切片外的使用者）；這裡只決定這一類要畫它。 */
function diffResult(entry: Parameters<typeof toolDiffView>[0]) {
  const view = toolDiffView(entry);
  return view === undefined ? undefined : ({ kind: 'diff', view } as const);
}

const write: ToolAdapter = {
  variant: 'write',
  title: '寫入檔案',
  summaryKeys: ['file_path', 'path'],
  result: diffResult,
};

const edit: ToolAdapter = {
  variant: 'edit',
  title: '編輯檔案',
  summaryKeys: ['file_path', 'path'],
  result: diffResult,
};

const code: ToolAdapter = {
  variant: 'code',
  title: '執行程式',
  summaryKeys: ['description'],
  inputBody: codeBody,
};

const others: ToolAdapter = {
  variant: 'others',
  title: '工具',
  summaryKeys: ['description', 'objective', 'text', 'message', 'reason'],
};

export const ADAPTERS: Readonly<Record<ToolVariant, ToolAdapter>> = {
  read,
  search,
  bash,
  write,
  edit,
  code,
  others,
};

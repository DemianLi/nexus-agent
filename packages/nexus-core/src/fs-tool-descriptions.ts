/**
 * 基座 `read_file` 的描述，換成講得出我們實際預設行數的那一份（[#1563](https://github.com/DemianLi/nexus-agent/issues/1563)）。
 *
 * ## 只換 `read_file` 一顆
 *
 * 基座 `read_file` 的描述寫死「By default, it reads up to 100 lines」（`READ_FILE_TOOL_DESCRIPTION`，`deepagents@1.13.1`，
 * `dist/langsmith-zm0ILQsV.js:1951-1963`），而我們的預設一頁是 {@link READ_LIMIT} 行（照 dsh，#602）；寫錯的描述會讓模型照 100 行規劃分頁。
 * 以前 `read-continuation.ts` 在 `wrapModelCall` 裡改送給模型的工具定義，理由是「`customToolDescriptions` 沒有往下傳」——那只對
 * `createDeepAgent` 成立（它建 `createFilesystemMiddleware` 時只傳 `{ backend, permissions, tools }`）。自有組裝收得到它
 * （#1776 補正）：`createFilesystemMiddleware` 的 `customToolDescriptions` 認 `ls`、`read_file`、`write_file`、`edit_file`、`delete`、`glob`、
 * `grep`、`execute`，每個工具建立時把 `customDescription || 基座預設` 當 `description`（`dist/langsmith-zm0ILQsV.js:2363-2407`）。所以描述現在由這裡換。
 *
 * **`write_file`／`edit_file` 的描述不換。** 先讀後改的規則照 dsh 寫在系統提示詞的 section（`observation.ts` 的 {@link observationGuidance}），
 * 不是工具描述；dsh 的工具描述只有一句 UTF-8 文字檔的說明。
 *
 * ## 開不開，看 middleware 在不在
 *
 * 描述講的是 middleware 的行為，middleware 沒掛，描述就是在說謊：`read_file` 的「預設 {@link READ_LIMIT} 行」只在
 * {@link READ_CONTINUATION_MIDDLEWARE_NAME} 在場時寫（預設的 `limit` 是它的 `wrapToolCall` 填的）。呼叫端傳這次組裝（或這個子代理）
 * 實際會掛的 middleware 清單進來，這裡看名字。
 *
 * ## 從基座的原文改，不是整段重寫
 *
 * 描述由基座的原文換掉**一句**：升版後基座改了那一句，{@link swap} 找不到它就拋，不會悄悄變成兩套說法並存。
 * 原文從 `createFilesystemMiddleware` 建出來的工具取（不碰 backend，建工具時不會呼叫它），每個進程算一次。
 *
 * ## `read_file` 的 JSON schema 換不掉，留在 `read-continuation.ts`
 *
 * `customToolDescriptions` 只換描述。`limit` 是 `z.coerce.number().optional().default(100)`（`langsmith-zm0ILQsV.js:2129`），
 * 被 langchain 轉成「必填、預設 100」的 JSON schema，`createFilesystemMiddleware` 沒有任何選項換 schema；`tools` 選項只是**名單**
 * （哪幾個基座工具要掛），不收工具實例。換掉實例又會被 langchain 拒絕（同名不同實例的 client tool）。所以 schema 那一半仍由
 * `read-continuation.ts` 的 `wrapModelCall` 在模型那一側換（偏離，理由 1）。
 *
 * @module
 */

import { createFilesystemMiddleware } from 'deepagents';

import type { FileToolsOptions } from './fs-tools-options.js';
import { SEARCH_DESCRIPTIONS_MIDDLEWARE_NAME } from './search-descriptions.js';
import { READ_CONTINUATION_MIDDLEWARE_NAME, READ_LIMIT } from './read-continuation.js';

/** `createFilesystemMiddleware` 的 `customToolDescriptions` 形狀（用到 `read_file`、`grep` 與 `glob`）。 */
export type FilesystemToolDescriptions = Readonly<
  Partial<Record<'read_file' | 'grep' | 'glob', string>>
>;

/**
 * 基座 `grep` 描述最前面講「字面」的那兩段（`GREP_TOOL_DESCRIPTION`，`dist/langsmith-zm0ILQsV.js`）：從開頭到 `\n\nReturns matching files`。
 * 換成 dsh 的第一句（`grep.ts:286`）加一句 `/conversation_history/` 的例外；後面基座講輸出與 `/large_tool_results/` 的部分原樣留著。
 */
const BASE_GREP_LITERAL_HEAD_END = '\n\nReturns matching files';
const BASE_GREP_LITERAL_HEAD_START = 'Search for a LITERAL text pattern across files (NOT regex).';

/** `grep`、`glob` 都不跟連結（#2193，同 dsh），模型要知道搜不到不等於沒有。 */
const SYMLINKS_NOT_SEARCHED =
  'Symbolic links are not followed, so linked files are skipped; `read_file` can still open a link that stays inside the workspace.';

/**
 * 換進去的正規式說法：第一句**照 dsh 原句**（`grep.ts:286`），後面接一句 `/conversation_history/` 的例外。
 *
 * **偏離 dsh（理由 1：基座表達不出來）。** 兩處，都不是我們自己多寫說明：
 *
 * - **不搬 dsh 的輸出句。** dsh 接著講「Returns matching lines with line numbers, grouped by file. Returns up to N matches …」，
 *   那是 dsh 自己的輸出形狀；基座的 `grep` 有 `output_mode`（`files_with_matches`／`content`／`count`），後面那段基座原文（講輸出與 `/large_tool_results/`）照留，
 *   搬 dsh 的句子進來會跟它矛盾。
 * - **加 `/conversation_history/` 的例外句。** 工作區底下這一格路由是記憶體裡的 `StateBackend`，基座的 `grep` 在那裡是字面比對；
 *   描述若只說「正規式」，模型在那裡寫 `foo|bar` 會得到 0 筆並當成「沒有」。這是基座實際的行為，不是我們另外立的規則。
 *
 * 基座原文開頭那段講「regex metacharacters are ordinary characters」的文字，隨著被換掉的開頭一併拿掉，不補我們自己寫的轉義說明。
 */
export const GREP_REGEXP_HEAD =
  'Search file contents with a ripgrep regular expression.\n\n' +
  'Files under `/conversation_history/` are the exception: they are searched as literal text.\n\n' +
  SYMLINKS_NOT_SEARCHED;

/** 基座 `glob` 描述的第一句（`GLOB_TOOL_DESCRIPTION`，`dist/langsmith-zm0ILQsV.js`）。後面講 `*`、`**`、`?` 的一段原樣留著。 */
const BASE_GLOB_HEAD = 'Find files matching a glob pattern, returning absolute paths.';

/**
 * 換進去的 `glob` 說法：第一句照 dsh `glob.ts:308`（「Find files, not directories, … including hidden and ignored files」），
 * 第二句照 dsh 的「in modification-time order」。**偏離（理由 1：基座表達不出來）**：dsh 的第二句還有「Returns up to N paths … a larger result keeps the first paths and reports where the complete list was saved」，
 * 那是外溢層（`tool-fs-search`，可關）的行為，不一定在，所以不寫；「absolute paths」「oldest first」是基座與我們實際的輸出。
 */
export const GLOB_HEAD =
  'Find files, not directories, whose paths match a glob pattern, including hidden and ignored files. ' +
  'Returns absolute paths in modification-time order, oldest first. ' +
  SYMLINKS_NOT_SEARCHED;

/** 基座 `read_file` 描述裡講預設行數的那一句（`READ_FILE_TOOL_DESCRIPTION`，`dist/langsmith-zm0ILQsV.js:1951-1963`）。 */
const BASE_READ_DEFAULT = 'By default, it reads up to 100 lines';

/** 基座檔案工具的原描述，每個進程算一次。 */
let baseDescriptions: Readonly<Record<string, string>> | undefined;

function baseDescriptionsOf(): Readonly<Record<string, string>> {
  if (baseDescriptions !== undefined) return baseDescriptions;
  // 工具建出來不碰 backend（執行時才 `resolveBackend`），所以給個空殼就夠。
  const { tools } = createFilesystemMiddleware({ backend: {} as never });
  baseDescriptions = Object.fromEntries(
    (tools ?? []).map((each) => [each.name, String(each.description)]),
  );
  return baseDescriptions;
}

/** 在基座的原描述裡把 `from` 換成 `to`；找不到就拋，讓升版時的改動顯形。 */
function swap(tool: string, from: string, to: string): string {
  const description = baseDescriptionsOf()[tool];
  if (description === undefined || !description.includes(from)) {
    throw new Error(
      `deepagents 的 ${tool} 工具描述不是預期的樣子，找不到「${from}」：升版後要對一次 fs-tool-descriptions.ts`,
    );
  }
  return description.replace(from, to);
}

/** `grep` 的描述：把基座講字面的開頭換成講正規式的。找不到基座的開頭就拋，同 {@link swap}。 */
function grepRegexpDescription(): string {
  const description = baseDescriptionsOf()['grep'];
  const end = description?.indexOf(BASE_GREP_LITERAL_HEAD_END) ?? -1;
  if (
    description === undefined ||
    !description.startsWith(BASE_GREP_LITERAL_HEAD_START) ||
    end < 0
  ) {
    throw new Error(
      'deepagents 的 grep 工具描述不是預期的樣子，找不到講字面比對的開頭：升版後要對一次 fs-tool-descriptions.ts',
    );
  }
  return `${GREP_REGEXP_HEAD}${description.slice(end)}`;
}

/**
 * 這一組 middleware 掛上之後，基座檔案工具該用的描述。
 *
 * @param middleware - 這次組裝（root）或這個子代理實際會掛的 middleware；只看名字。
 * @param options - `tool-fs` 設定（#1605）：`read_file` 描述裡的預設行數用 `readLimit`；缺席用 {@link READ_LIMIT}。
 * @returns 要交給 `createFilesystemMiddleware({ customToolDescriptions })` 的表；一顆都不用換時是 `undefined`（組成與基座逐位元組相同）。
 */
export function filesystemToolDescriptions(
  middleware: readonly { readonly name: string }[],
  options?: Pick<FileToolsOptions, 'readLimit'>,
): FilesystemToolDescriptions | undefined {
  const names = new Set(middleware.map((each) => each.name));
  const readFile = names.has(READ_CONTINUATION_MIDDLEWARE_NAME);
  const search = names.has(SEARCH_DESCRIPTIONS_MIDDLEWARE_NAME);
  if (!readFile && !search) return undefined;
  return {
    ...(readFile && {
      read_file: swap(
        'read_file',
        BASE_READ_DEFAULT,
        `By default, it reads up to ${options?.readLimit ?? READ_LIMIT} lines`,
      ),
    }),
    ...(search && {
      grep: grepRegexpDescription(),
      glob: swap('glob', BASE_GLOB_HEAD, GLOB_HEAD),
    }),
  };
}

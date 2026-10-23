/**
 * 基座檔案工具的描述，換成講得出我們實際規則的那一份（[#1563](https://github.com/DemianLi/nexus-agent/issues/1563)）。
 *
 * ## 為什麼是描述，不是系統提示詞
 *
 * dsh 把「先讀後改」寫進工具描述（`snapshots/web` 底下每一份 `system-prompt.expected.md`：「read an existing file first (the default
 * fs-observation-policy requires it)」、「Read the file first … unless you just created or edited it in this session」），模型看得到的
 * 只有描述，不寫在那裡它每碰一個新檔就得先撞一次牆。以前 `observation.ts` 退到 `wrapModelCall` 往 `systemMessage` 追加一句，
 * `read-continuation.ts` 也在 `wrapModelCall` 裡改送給模型的 `read_file` 定義，理由是「`customToolDescriptions` 沒有往下傳」——那只對
 * `createDeepAgent` 成立（它建 `createFilesystemMiddleware` 時只傳 `{ backend, permissions, tools }`）。自有組裝收得到它
 * （#1776 補正）：`createFilesystemMiddleware` 的 `customToolDescriptions` 認 `ls`、`read_file`、`write_file`、`edit_file`、`delete`、`glob`、
 * `grep`、`execute`，每個工具建立時把 `customDescription || 基座預設` 當 `description`（`deepagents@1.13.1`，
 * `dist/langsmith-zm0ILQsV.js:2363-2407`）。所以規則現在住在工具描述裡，照 dsh。
 *
 * ## 開不開，看 middleware 在不在
 *
 * 描述講的是 middleware 的行為，middleware 沒掛，描述就是在說謊：
 *
 * - `write_file`／`edit_file` 的「先讀後改」只在 {@link OBSERVATION_POLICY_MIDDLEWARE_NAME} 在場時寫（`observationPolicy: false` 或條目 `disabled` 時
 *   那顆不在，基座的原描述「不必先讀」才是真話）；
 * - `read_file` 的「預設 {@link READ_LIMIT} 行」只在 {@link READ_CONTINUATION_MIDDLEWARE_NAME} 在場時寫（預設的 `limit` 是它的 `wrapToolCall` 填的）。
 *
 * 呼叫端傳這次組裝（或這個子代理）實際會掛的 middleware 清單進來，這裡看名字。
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

import { OBSERVATION_POLICY_MIDDLEWARE_NAME } from './observation.js';
import { READ_CONTINUATION_MIDDLEWARE_NAME, READ_LIMIT } from './read-continuation.js';

/** `createFilesystemMiddleware` 的 `customToolDescriptions` 形狀（只用到這三顆）。 */
export type FilesystemToolDescriptions = Readonly<
  Partial<Record<'read_file' | 'write_file' | 'edit_file', string>>
>;

/** 基座 `read_file` 描述裡講預設行數的那一句（`READ_FILE_TOOL_DESCRIPTION`，`dist/langsmith-zm0ILQsV.js:1951-1963`）。 */
const BASE_READ_DEFAULT = 'By default, it reads up to 100 lines';

/** 基座 `write_file` 描述裡「不必先讀」的那一句（`WRITE_FILE_TOOL_DESCRIPTION`，`:1965-1971`）。 */
const BASE_WRITE_NO_READ = 'You do not need to read the file first.';

/** 基座 `edit_file` 描述裡「要先讀」的那一行（`EDIT_FILE_TOOL_DESCRIPTION`，`:1972-1979`）。 */
const BASE_EDIT_MUST_READ = '- You must read the file before editing; this tool errors otherwise.';

/**
 * 換上去的句子，前半照 dsh `snapshots/web` 的措辭。後半是我們的策略多出來、dsh 那兩句沒講的兩件事（部分讀也算、被改動要重讀），
 * 以前寫在 `OBSERVATION_POLICY_NOTICE` 裡，模型靠它才不會在第一次撞牆時才知道。
 */
const WRITE_OBSERVATION =
  'Existing files are overwritten, so read an existing file first (the default fs-observation-policy requires it); ' +
  'a file that does not exist yet can be created without reading. ' +
  'If the file changed after you read it, read it again first.';
const EDIT_OBSERVATION =
  '- Read the file first (the default fs-observation-policy requires it), unless you just created or edited it in this session; ' +
  'reading only part of it (offset/limit) counts. If the file changed after you read it, read it again first. This tool errors otherwise.';

/** 基座三顆工具的原描述，每個進程算一次。 */
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

/**
 * 這一組 middleware 掛上之後，基座檔案工具該用的描述。
 *
 * @param middleware - 這次組裝（root）或這個子代理實際會掛的 middleware；只看名字。
 * @returns 要交給 `createFilesystemMiddleware({ customToolDescriptions })` 的表；一顆都不用換時是 `undefined`（組成與基座逐位元組相同）。
 */
export function filesystemToolDescriptions(
  middleware: readonly { readonly name: string }[],
): FilesystemToolDescriptions | undefined {
  const names = new Set(middleware.map((each) => each.name));
  const descriptions: Record<string, string> = {};
  if (names.has(READ_CONTINUATION_MIDDLEWARE_NAME)) {
    descriptions['read_file'] = swap(
      'read_file',
      BASE_READ_DEFAULT,
      `By default, it reads up to ${READ_LIMIT} lines`,
    );
  }
  if (names.has(OBSERVATION_POLICY_MIDDLEWARE_NAME)) {
    descriptions['write_file'] = swap('write_file', BASE_WRITE_NO_READ, WRITE_OBSERVATION);
    descriptions['edit_file'] = swap('edit_file', BASE_EDIT_MUST_READ, EDIT_OBSERVATION);
  }
  return Object.keys(descriptions).length === 0 ? undefined : descriptions;
}

/**
 * 列出這台 serve 以前的 thread——[#302](https://github.com/DemianLi/nexus-agent/issues/302)。
 *
 * 照 dsh 的 `ApiSessionList.list()`（`packages/api/session-controller/src/list.ts`，SHA `c291e79`）：
 * **不啟動任何 agent**，讀持久化的會話，跳過 `header.cwd` 沒記的，照 `updatedAt` 由新到舊排。
 * `updatedAt = max(header.createdAt, 最後一則人類提示的時間)`，`blank` 是「還沒有任何 `turn/start`」
 * （`applySessionListMetadata`）。`running` 不在這裡：它來自活著的 agent，歸 `wire-handler.ts`。
 *
 * ## 唯讀，而且比續接更唯讀
 *
 * 不拿寫租約、不截撕裂的尾巴、不動 header。續接（`JsonlSessionStore.resume`）三件都做，所以列表
 * 不能借它——別的行程握著的那一條也要列得出來，而且列一次不能改到任何一個位元組。同 `eval/session-scan.ts`
 * 的 `readSessionLogs`，差在這裡在請求路徑上：**日誌逐行串流，只解析帶 `turn/start` 字樣的那幾行**，
 * 不整份讀進記憶體。
 *
 * ## 列出來的每一列都要切得過去
 *
 * 切換走的是 serve 的續接路徑，所以會在那裡被擋的，這裡就不列：
 *
 * - **header 帶 `parentSession` 的不列**：subagent 的 id 是 `<thread>/<task>`，不是一條 thread。dsh 會列、
 *   標 `origin: 'subagent'`；我們切不進去（#302 拍板的第 3 件）。
 * - **`header.cwd` 不等於這一次的 `cwd` 就不列**，沒記的也不列。**不是按目錄判**：`projectKey` 是有損的，
 *   兩個目錄可能落在同一格，header 的 `cwd` 才是唯一分得開的東西（`resume-guards.ts` 的 `assertSameCwd`，
 *   續接時一樣比它）。dsh 只擋沒記的，因為它的列表跨專案。
 * - **header 讀不懂、版本比這一版新的不列，但數出來**（`unreadable`）。續接會拒絕這兩種；不數的話，
 *   畫面上「少了一條」跟「本來就沒有」分不出來。
 *
 * **日誌本文壞在中間不在這裡擋**：要驗就得逐行解析整份，而這條路只讀需要的那幾行。那一列照樣列出來，
 * 點下去由續接那條路講出原因（`wire-handler.ts` 的 `threadOrError`）。
 *
 * ## 標題
 *
 * 最後一顆 `session/title`（[#647](https://github.com/DemianLi/nexus-agent/issues/647)），同 dsh 列表讀的 `title` 投影
 * （latest-wins）。**一顆都沒有才照規則推**：18 以前的日誌，或第一句還沒開跑。規則與偏離見 `session-title.ts`。
 * dsh 的冷列讀持久化的投影快取，我們沒有那一層，讀的是日誌本身：**多篩一種字樣**，同樣只解析那幾行。
 *
 * @module
 */

import { open, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SESSION_LOG_FORMAT_VERSION } from '@nexus/core';
import type { ThreadSummary } from '@nexus/wire';

import { assertThreadTitleLimits, fallbackThreadTitle } from './session-title.js';
import type { ThreadTitleLimits } from './session-title.js';

/** 從磁碟讀得出來的那一列：線上那一列少掉 `running`（它來自活著的 agent）。 */
export type StoredThreadSummary = Omit<ThreadSummary, 'running'>;

export interface StoredThreadList {
  /** 由新到舊；`updatedAt` 一樣時照 id。 */
  readonly items: readonly StoredThreadSummary[];
  /** header 讀不懂或版本比這一版新而沒列的份數。 */
  readonly unreadable: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ENOENT';
}

/** header 裡列表要的那幾格。讀不懂或版本太新是 `undefined`。 */
interface ListedHeader {
  readonly id: string;
  readonly createdAt: number;
  readonly cwd?: string;
  readonly parentSession?: string;
}

function parseHeader(text: string): ListedHeader | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const { id, createdAt, version, cwd, parentSession } = value;
  if (typeof id !== 'string' || typeof createdAt !== 'number') return undefined;
  if (
    typeof version !== 'number' ||
    !Number.isSafeInteger(version) ||
    version < 1 ||
    version > SESSION_LOG_FORMAT_VERSION
  ) {
    return undefined;
  }
  return {
    id,
    createdAt,
    ...(typeof cwd === 'string' && { cwd }),
    ...(typeof parentSession === 'string' && { parentSession }),
  };
}

/** 一份日誌裡列表要的東西。 */
interface PromptScan {
  readonly blank: boolean;
  readonly title?: string;
  readonly lastPromptAt?: number;
}

const TURN_START = 'turn/start';
const SESSION_TITLE = 'session/title';

/**
 * 逐行掃一份日誌，只解析帶 `turn/start` 或 `session/title` 字樣的行。**字樣只是篩子**：解析之後照樣比 `type`，所以一個
 * 工具參數裡提到這幾個字的行不會被當成一輪，也不會被當成標題。
 *
 * 解析不動的行略過：最後一行寫到一半是當掉的常態（`parseJsonlSessionBody` 也不算它），中間壞掉的見檔頭。
 * 只有 header 沒有日誌是「還沒寫第一筆就當了」，讀成空白。
 */
async function scanPrompts(file: string, limits: ThreadTitleLimits): Promise<PromptScan> {
  let handle;
  try {
    handle = await open(file, 'r');
  } catch (error: unknown) {
    if (isNotFound(error)) return { blank: true };
    throw error;
  }
  let blank = true;
  /** 最後一顆 `session/title` 的。 */
  let logged: string | undefined;
  /** 第一則合格的人話推出來的，一顆 `session/title` 都沒有時才用。 */
  let derived: string | undefined;
  let lastPromptAt: number | undefined;
  try {
    for await (const line of handle.readLines({ encoding: 'utf8' })) {
      if (!line.includes(TURN_START) && !line.includes(SESSION_TITLE)) continue;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(event)) continue;
      const data = event['data'];
      if (event['type'] === SESSION_TITLE) {
        if (isRecord(data) && typeof data['title'] === 'string') logged = data['title'];
        continue;
      }
      if (event['type'] !== TURN_START) continue;
      blank = false;
      if (!isRecord(data) || data['kind'] !== 'message' || typeof data['text'] !== 'string') {
        continue;
      }
      if (typeof event['time'] === 'number') lastPromptAt = event['time'];
      if (derived === undefined) {
        const title = fallbackThreadTitle(data['text'], limits);
        if (title !== '') derived = title;
      }
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  const title = logged ?? derived;
  return {
    blank,
    ...(title !== undefined && { title }),
    ...(lastPromptAt !== undefined && { lastPromptAt }),
  };
}

const HEADER_SUFFIX = '.header.json';
const LOG_SUFFIX = '.jsonl';

/**
 * 列出 `directory` 裡屬於 `cwd` 的 root thread。
 *
 * @param directory - serve 的 `<會話根>/<projectKey(cwd)>` 那一格。還不存在就是空的。
 * @param options - `cwd` 是這台 server 的工作目錄；`title` 的兩個上限必填。
 * @returns 由新到舊的列，與沒列的份數。
 * @throws 上限不是正整數；目錄存在但讀不到。
 */
export async function listStoredThreads(
  directory: string,
  options: { readonly cwd: string; readonly title: ThreadTitleLimits },
): Promise<StoredThreadList> {
  // 先驗，不等到第一則人打的字：一份空的目錄不該讓錯的設定看起來是對的。
  assertThreadTitleLimits(options.title);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error: unknown) {
    if (isNotFound(error)) return { items: [], unreadable: 0 };
    throw error;
  }
  const items: StoredThreadSummary[] = [];
  let unreadable = 0;
  for (const name of names) {
    if (!name.endsWith(HEADER_SUFFIX)) continue;
    let headerText: string;
    try {
      headerText = await readFile(join(directory, name), 'utf8');
    } catch (error: unknown) {
      // 讀目錄與讀檔之間被刪掉：不是壞檔，就是不在了。
      if (isNotFound(error)) continue;
      throw error;
    }
    const header = parseHeader(headerText);
    if (header === undefined) {
      unreadable += 1;
      continue;
    }
    if (header.parentSession !== undefined || header.cwd !== options.cwd) continue;
    const base = name.slice(0, -HEADER_SUFFIX.length);
    const scan = await scanPrompts(join(directory, `${base}${LOG_SUFFIX}`), options.title);
    items.push({
      threadId: header.id,
      updatedAt: Math.max(header.createdAt, scan.lastPromptAt ?? 0),
      blank: scan.blank,
      ...(scan.title !== undefined && { title: scan.title }),
    });
  }
  items.sort(
    (left, right) =>
      right.updatedAt - left.updatedAt ||
      (left.threadId < right.threadId ? -1 : left.threadId > right.threadId ? 1 : 0),
  );
  return { items, unreadable };
}

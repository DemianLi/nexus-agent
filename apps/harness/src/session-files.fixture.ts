/**
 * 測試找會話檔的輔助（[#1868](https://github.com/DemianLi/nexus-agent/issues/1868)）：「這份會話在哪、它的事件、它的 header」
 * 一律從這裡拿，不在測試裡自己拼檔名。佈局換掉時改這一檔，不改幾十個測試。找、讀、改 header（{@link rewriteSessionHeader}）兩種
 * 佈局都認（舊兩檔、每會話目錄裡的世代檔）；寫方從 #1594 ③ 起只寫世代檔，舊兩檔只剩手寫的遷移來源。
 *
 * 檔名經 `@nexus/core` 的 `session-filename.ts`（`sessionPathsIn`、`legacyTwoFilePathsIn` 也是轉呼叫它），讀一份經後端的讀取接縫
 * {@link readSessionEntry} 與 {@link readSessionEntryById}（#1857）。這一檔在 `session-files-single-owner.test.ts` 的掃描範圍內，不寫字面量。
 *
 * **不在這裡的**：刻意手寫舊兩檔來驗舊格式與遷移的測試、量原始位元組的（截尾、補壞行、canary、sha1）、改版號的
 * ——那些要的就是檔本身，直接拿 `sessionPathsIn(...)`、`legacyTwoFilePathsIn(...)` 的路徑。
 */

import { existsSync, readdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  legacyTwoFileSessionFilenames,
  parseGenerationLogFilename,
  parseLegacyTwoFileHeaderFilename,
  sessionDirectoryName,
} from '@nexus/core';
import type { SessionEvent, StoredSessionHeader } from '@nexus/core';

import {
  legacyTwoFilePathsIn,
  readSessionEntry,
  readSessionEntryById,
} from './jsonl-session-store.js';
import type { SessionEntry } from './jsonl-session-store.js';

/**
 * 舊兩檔佈局的最後一版：**手寫舊兩檔的 header 用它，不用 `SESSION_LOG_FORMAT_VERSION`**（#1594 ③，PM 2026-10-30 裁決 Q2）。
 * 版本 52 起舊路徑上的 header 是墓碑：寫這一版的版號，讀方會當成墓碑，旁邊沒有會話目錄就報壞檔。釘成字面量，不從
 * `FIRST_GENERATION_FORMAT_VERSION` 推：v0.5.19 以前寫出來的就是這些版號，之後升版它也不跟著變。
 */
export const LEGACY_TWO_FILE_FORMAT_VERSION = 51;

/** 一份會話：它在哪個目錄、它的 header 與日誌路徑（單檔佈局兩格相同）、經接縫讀出的 header。 */
export interface SessionOnDisk {
  readonly directory: string;
  /** header 記的 id。 */
  readonly id: string;
  /** 舊兩檔是 `<base>.header.json`；單檔佈局的 header 在世代檔第一行，這一格就是世代檔（同 {@link logPath}）。 */
  readonly headerPath: string;
  readonly logPath: string;
  /**
   * 經 {@link readSessionEntry} 讀出來的 header：磁碟上的欄位都在，但 **`version` 已經蓋成這一版**。要比磁碟上寫的那個版號，
   * 比 {@link storedFormatVersion}。
   */
  readonly header: StoredSessionHeader & Readonly<Record<string, unknown>>;
  /** 磁碟上 header 寫的版號。 */
  readonly storedFormatVersion: number;
  readonly entry: SessionEntry;
}

function onDisk(directory: string, entry: SessionEntry): SessionOnDisk {
  return {
    directory,
    id: entry.header.id,
    headerPath:
      entry.layout === 'two-file'
        ? legacyTwoFilePathsIn(directory, entry.header.id).header
        : entry.logPath,
    logPath: entry.logPath,
    header: entry.header as StoredSessionHeader & Readonly<Record<string, unknown>>,
    storedFormatVersion: entry.storedFormatVersion,
    entry,
  };
}

/** `root` 與它底下（遞迴）每一個目錄。 */
function directoriesUnder(root: string): string[] {
  const out = [root];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...directoriesUnder(join(root, entry.name)));
  }
  return out;
}

/**
 * `dir` 底下 `id` 的會話目錄裡，版本最新的正規世代檔（一般檔，而且不是旁邊某個 `<base>.header.json` 的日誌：那是舊兩檔
 * 會話的日誌）；沒有就是 `undefined`。目錄不在、名字太長、同名的是個檔都算沒有，同後端的撞名檢查；其餘的錯照拋。只看檔名，不讀。
 */
function generationFileIn(dir: string, id: string): string | undefined {
  const sessionDirectory = join(dir, sessionDirectoryName(id));
  let entries;
  try {
    entries = readdirSync(sessionDirectory, { withFileTypes: true });
  } catch (error: unknown) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'ENOENT' || code === 'ENAMETOOLONG' || code === 'ENOTDIR') return undefined;
    throw error;
  }
  const legacyLogs = new Set(
    entries.flatMap((entry) => {
      const base = entry.isDirectory() ? undefined : parseLegacyTwoFileHeaderFilename(entry.name);
      return base === undefined ? [] : [legacyTwoFileSessionFilenames(base).log];
    }),
  );
  let latest: { readonly name: string; readonly version: number } | undefined;
  for (const entry of entries) {
    if (!entry.isFile() || legacyLogs.has(entry.name)) continue;
    const version = parseGenerationLogFilename(entry.name);
    if (version !== undefined && (latest === undefined || version > latest.version)) {
      latest = { name: entry.name, version };
    }
  }
  return latest === undefined ? undefined : join(sessionDirectory, latest.name);
}

/**
 * `root` 底下（遞迴）有 `id` 這一份的目錄：舊路徑上有 header（舊兩檔或墓碑），或有單檔佈局的會話目錄。只看檔在不在，
 * 不讀：旁邊那份壞了也不干擾。
 */
function directoriesHolding(root: string, id: string): string[] {
  return directoriesUnder(root).filter(
    (dir) =>
      existsSync(legacyTwoFilePathsIn(dir, id).header) || generationFileIn(dir, id) !== undefined,
  );
}

function onlyOne(root: string, id: string, found: readonly string[]): string | undefined {
  if (found.length > 1) throw new Error(`${root} 底下有不只一份會話 ${id}：${found.join('、')}`);
  return found[0];
}

/**
 * `root` 底下（遞迴）id 是 `id` 的那一份。照 `open(id)` 的做法照 id 算檔名，**只讀那一份**。還沒寫出 header 就是
 * `undefined`；同一棵樹裡有兩份同 id 的（例如兩個 CLI run 目錄都叫 `cli`）就拋錯，要呼叫方把 `root` 給窄一點。
 *
 * @throws 同 {@link readSessionEntryById}：那一份的 header 讀不懂，或同一個目錄裡同一個 id 兩種佈局並存。
 */
export async function findSession(root: string, id: string): Promise<SessionOnDisk | undefined> {
  const directory = onlyOne(root, id, directoriesHolding(root, id));
  if (directory === undefined) return undefined;
  const entry = await readSessionEntryById(directory, id);
  return entry === undefined ? undefined : onDisk(directory, entry);
}

/** 同 {@link findSession}，找不到就拋錯。 */
export async function sessionOf(root: string, id: string): Promise<SessionOnDisk> {
  const session = await findSession(root, id);
  if (session === undefined) throw new Error(`${root} 底下找不到會話 ${id}`);
  return session;
}

/**
 * `root` 底下（遞迴）每一份會話，給**不知道 id** 的地方用（按前綴找子代理、「只有一份」的斷言）。每個 header 都經接縫讀，
 * **讀不懂的照拋，不跳過**：旁邊那份壞檔不會被靜靜略過。讀目錄與讀檔之間不見了的照接縫的規矩略過。
 */
export async function sessionsUnder(root: string): Promise<SessionOnDisk[]> {
  const out: SessionOnDisk[] = [];
  for (const directory of directoriesUnder(root)) {
    const dirents = readdirSync(directory, { withFileTypes: true });
    for (const dirent of dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const entry = await readSessionEntry(directory, dirent);
      if (entry !== undefined) out.push(onDisk(directory, entry));
    }
  }
  return out;
}

/** 一份會話落了盤的事件。 */
export interface SessionEvents {
  /** 每一個完整的行（最後一個換行之前）逐行解開，不驗：這裡要的是寫方落盤的原樣。 */
  readonly events: SessionEvent[];
  /**
   * 最後一個換行之後沒有東西：沒有寫到一半的那一行。等「某一筆已經落盤」的測試要看這一格——只看完整的行的話，
   * 那一筆後面還有半行在寫時會提早放行。
   */
  readonly complete: boolean;
}

/** 經接縫的 `readBody()` 讀日誌本文（穩定快照讀）。舊兩檔的日誌還不在就是空的、完整的；單檔佈局的世代檔不見了照拋。 */
export async function sessionEvents(session: SessionOnDisk): Promise<SessionEvents> {
  const body = await session.entry.readBody();
  const end = body.lastIndexOf(0x0a) + 1;
  const events = body
    .toString('utf8', 0, end)
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as SessionEvent);
  return { events, complete: end === body.length };
}

/**
 * **寫完、關了檔之後**才讀的事件：最後一行只寫了一半就拋錯。關檔之後還留著半行就是撕裂的尾巴，不是還在寫；
 * 靜靜丟掉的話，壞尾巴的紅燈就不見了（#1880 審查）。還在寫、要等尾巴寫完的輪詢讀方，用 {@link sessionEvents} 看 `complete`。
 */
export async function closedSessionEvents(session: SessionOnDisk): Promise<SessionEvent[]> {
  const { events, complete } = await sessionEvents(session);
  if (!complete) throw new Error(`${session.logPath} 的最後一行只寫了一半`);
  return events;
}

/** `root` 底下 id 是 `id` 那一份的事件，同 {@link closedSessionEvents}：尾巴是半行就拋。找不到就拋錯。 */
export async function sessionEventsOf(root: string, id: string): Promise<SessionEvent[]> {
  return closedSessionEvents(await sessionOf(root, id));
}

/** `root` 底下 id 是 `id` 那一份的 header 與磁碟上的版號。找不到就拋錯。 */
export async function sessionHeaderOf(
  root: string,
  id: string,
): Promise<Pick<SessionOnDisk, 'header' | 'storedFormatVersion'>> {
  const { header, storedFormatVersion } = await sessionOf(root, id);
  return { header, storedFormatVersion };
}

/** `text` 解得開而且是 JSON 物件（不是 `null`、陣列、純量）就回它，否則 `undefined`。 */
function jsonObject(text: string): Record<string, unknown> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * 改一份會話的 header：`edit` 拿到磁碟上的**原始 JSON**（不經接縫轉譯；單檔佈局是 header 行，含 `type`），回改好的物件，或回
 * 一段字串原樣寫入。找的時候只看檔名、不讀（原文壞了也找得到）：有世代檔就改版本最新那一份的第一行，其餘的行不動；沒有就改
 * 舊兩檔的 `<base>.header.json`。
 *
 * - **不准改 `version`**：改版號的測試量的是磁碟上那個數字，留在 `sessionPathsIn(...)`／`legacyTwoFilePathsIn(...)` 的路徑直接寫，
 *   佈局換掉時 tsc 會逐處點名（#1868 裁決 Q1）。回的字串解得開 JSON 也照樣比。
 * - 回的字串不是 JSON 物件（解不開，或是 `null`、陣列、數字）就是要寫一份壞的 header，原樣寫入。
 *
 * **原文本身就不是 JSON 物件就拋錯**：這支只改好的 header，`edit` 拿到的一定是物件。寫壞之後要還原，用它回傳的函式，不要再呼叫
 * 一次；還原只換回 header（單檔佈局是第一行），之後追加的事件留著。
 *
 * @returns 把原文寫回去的函式：寫壞之後接縫讀不懂它，還原要靠這個。
 * @throws 找不到那一份；原文不是 JSON 物件；`version` 被改了。
 */
export async function rewriteSessionHeader(
  root: string,
  id: string,
  edit: (header: Record<string, unknown>) => Record<string, unknown> | string,
): Promise<() => Promise<void>> {
  const directory = onlyOne(root, id, directoriesHolding(root, id));
  if (directory === undefined) throw new Error(`${root} 底下找不到會話 ${id}`);
  const generationFile = generationFileIn(directory, id);
  const generation = generationFile !== undefined;
  const path = generationFile ?? legacyTwoFilePathsIn(directory, id).header;
  const original = generation ? await firstLineOf(path) : await readFile(path, 'utf8');
  const before = jsonObject(original);
  if (before === undefined) {
    throw new Error(
      `${path} 原本就不是 JSON 物件：rewriteSessionHeader 只改好的 header（寫壞之後用它回傳的函式還原）`,
    );
  }
  const edited = edit(structuredClone(before));
  const after = typeof edited === 'string' ? jsonObject(edited) : edited;
  if (after !== undefined && after['version'] !== before['version']) {
    throw new Error(
      `rewriteSessionHeader 不改版號（${JSON.stringify(before['version'])} → ` +
        `${JSON.stringify(after['version'])}）：改版號的測試直接寫 sessionPathsIn(...) 的路徑`,
    );
  }
  const text = typeof edited === 'string' ? edited : JSON.stringify(edited);
  const write = (header: string): Promise<void> =>
    generation ? replaceFirstLine(path, header) : writeFile(path, header);
  await write(text);
  return () => write(original);
}

/** 世代檔的第一行（不含換行）。 */
async function firstLineOf(path: string): Promise<string> {
  const text = await readFile(path, 'utf8');
  const newline = text.indexOf('\n');
  return newline === -1 ? text : text.slice(0, newline);
}

/** 把世代檔的第一行換成 `line`，其餘的行原樣。 */
async function replaceFirstLine(path: string, line: string): Promise<void> {
  const text = await readFile(path, 'utf8');
  const newline = text.indexOf('\n');
  await writeFile(path, `${line}${newline === -1 ? '\n' : text.slice(newline)}`);
}

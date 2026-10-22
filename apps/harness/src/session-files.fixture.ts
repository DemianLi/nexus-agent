/**
 * 測試找會話檔的輔助（[#1868](https://github.com/DemianLi/nexus-agent/issues/1868)）：「這份會話在哪、它的事件、它的 header」
 * 一律從這裡拿，不在測試裡自己拼 `<id>.header.json`、`<id>.jsonl`。佈局換掉（#1594 ③）時改這一檔，不改幾十個測試。
 *
 * 檔名經 `@nexus/core` 的 `session-filename.ts`（`sessionPathsIn` 也是轉呼叫它），讀一份經後端的讀取接縫
 * {@link readSessionEntry}（#1857）。照 dsh 的快照基建 `packages/test-support/session-snapshot/src/session-files.ts:192-210`
 * （`persistedSessionFilename` 經格式模組）。這一檔在 `session-files-single-owner.test.ts` 的掃描範圍內，不寫字面量。
 *
 * **不在這裡的**：刻意手寫兩檔來驗舊格式的測試（舊佈局型）、量原始位元組的（截尾、補壞行、canary、sha1）、改版號的
 * ——那些要的就是檔本身，直接拿 `sessionPathsIn(...)` 的路徑。
 */

import { existsSync, readdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type { SessionEvent, StoredSessionHeader } from '@nexus/core';

import { readSessionEntry, sessionPathsIn } from './jsonl-session-store.js';
import type { SessionEntry } from './jsonl-session-store.js';

/** 一份會話：它在哪個目錄、兩個檔的路徑、經接縫讀出的 header。 */
export interface SessionOnDisk {
  readonly directory: string;
  /** header 記的 id。 */
  readonly id: string;
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
    headerPath: sessionPathsIn(directory, entry.header.id).header,
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

/** `root` 底下（遞迴）有 `id` 這一份 header 的目錄。只看檔在不在，不讀：旁邊那份壞了也不干擾。 */
function directoriesHolding(root: string, id: string): string[] {
  return directoriesUnder(root).filter((dir) => existsSync(sessionPathsIn(dir, id).header));
}

function onlyOne(root: string, id: string, found: readonly string[]): string | undefined {
  if (found.length > 1) throw new Error(`${root} 底下有不只一份會話 ${id}：${found.join('、')}`);
  return found[0];
}

/**
 * `root` 底下（遞迴）id 是 `id` 的那一份。照 `open(id)` 的做法照 id 算檔名，**只讀那一份**。還沒寫出 header 就是
 * `undefined`；同一棵樹裡有兩份同 id 的（例如兩個 CLI run 目錄都叫 `cli`）就拋錯，要呼叫方把 `root` 給窄一點。
 *
 * @throws 那一份的 header 讀不懂（同 {@link readSessionEntry}）。
 */
export async function findSession(root: string, id: string): Promise<SessionOnDisk | undefined> {
  const directory = onlyOne(root, id, directoriesHolding(root, id));
  if (directory === undefined) return undefined;
  const entry = await readSessionEntry(directory, basename(sessionPathsIn(directory, id).header));
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
    for (const name of readdirSync(directory).sort()) {
      const entry = await readSessionEntry(directory, name);
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

/** 經接縫的 `readBody()` 讀日誌本文（穩定快照讀）。日誌還不在就是空的、完整的。 */
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

/** `root` 底下 id 是 `id` 那一份的事件（完整的行）。找不到就拋錯。 */
export async function sessionEventsOf(root: string, id: string): Promise<SessionEvent[]> {
  return (await sessionEvents(await sessionOf(root, id))).events;
}

/** `root` 底下 id 是 `id` 那一份的 header 與磁碟上的版號。找不到就拋錯。 */
export async function sessionHeaderOf(
  root: string,
  id: string,
): Promise<Pick<SessionOnDisk, 'header' | 'storedFormatVersion'>> {
  const { header, storedFormatVersion } = await sessionOf(root, id);
  return { header, storedFormatVersion };
}

/**
 * 改一份會話的 header：`edit` 拿到磁碟上的**原始 JSON**（不經接縫轉譯），回改好的物件，或回一段字串原樣寫入。
 *
 * - **不准改 `version`**：改版號的測試量的是磁碟上那個數字，留在 `sessionPathsIn(...).header` 直接寫，佈局換掉時
 *   tsc 會逐處點名（#1868 裁決 Q1）。回的字串解得開 JSON 也照樣比。
 * - 回的字串解不開 JSON 就是要寫一份壞的 header，原樣寫入。
 *
 * 找檔只看檔在不在、不經接縫，所以 header 已經壞了也找得到。
 *
 * @returns 把原文寫回去的函式：寫壞之後接縫讀不懂它，還原要靠這個。
 * @throws 找不到那一份；原文不是 JSON 卻要回物件；`version` 被改了。
 */
export async function rewriteSessionHeader(
  root: string,
  id: string,
  edit: (header: Record<string, unknown>) => Record<string, unknown> | string,
): Promise<() => Promise<void>> {
  const directory = onlyOne(root, id, directoriesHolding(root, id));
  if (directory === undefined) throw new Error(`${root} 底下找不到會話 ${id}`);
  const path = sessionPathsIn(directory, id).header;
  const original = await readFile(path, 'utf8');
  const before = JSON.parse(original) as Record<string, unknown>;
  const edited = edit(structuredClone(before));
  let after: unknown;
  if (typeof edited === 'string') {
    try {
      after = JSON.parse(edited);
    } catch {
      after = undefined;
    }
  } else {
    after = edited;
  }
  if (after !== undefined && (after as Record<string, unknown>)['version'] !== before['version']) {
    throw new Error(
      `rewriteSessionHeader 不改版號（${JSON.stringify(before['version'])} → ` +
        `${JSON.stringify((after as Record<string, unknown>)['version'])}）：改版號的測試直接寫 sessionPathsIn(...).header`,
    );
  }
  await writeFile(path, typeof edited === 'string' ? edited : JSON.stringify(edited));
  return () => writeFile(path, original);
}

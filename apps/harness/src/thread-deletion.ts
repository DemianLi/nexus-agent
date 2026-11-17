/**
 * 刪除會話：整條軌跡搬到「已刪除存放區」，寬限期內可以復原（[#2957](https://github.com/DemianLi/nexus-agent/issues/2957)）。
 *
 * ## 三個耐久物件
 *
 * - **狀態檔** `<home>/thread-deletions.json`：一份 JSON，裡面有兩格。`intent` 是正在做的那一件（沒有就是 `null`），
 *   `deleted` 是已刪除的索引。**每次變更都是一次 {@link writeAtomic}**，所以「寫索引、清意圖」是同一次寫，中間沒有可以停的狀態。
 * - **刪除記錄** `<home>/thread-deletions.log.jsonl`：每次刪除或復原附加一行（誰、何時、哪條、原標題）。附加之前先掃一遍，
 *   **同一個 `opId` 已經在，就不再附加**——恢復重跑時不會把同一筆寫兩次。
 * - **存放區** `<deletedRoot>/<projectKey>/…`：被搬過去的檔，形狀與原處一樣（同一個相對名字）。
 *
 * ## 索引存什麼
 *
 * 只存「專案格名＋thread id」，不存絕對路徑。路徑每次用當下設定的存放區與會話根解析，改了路徑不會讓索引失效。
 *
 * ## 搬的順序與冪等
 *
 * 搬之前先把要搬的項目名單（{@link planItems}）寫進意圖，之後才動任何檔。每個項目的規則只有一條：
 *
 * - 目的地已經在 → 它是完整的（目的地只會經由最後一步 `rename` 出現），把來源剩下的部分刪掉。
 * - 來源不在 → 沒事做。
 * - 否則同磁碟就 `rename`；遇到 `EXDEV`，複製到 `<dst>.partial`、逐檔 fsync、用大小加 sha256 核對，
 *   `rename` 成 `dst`，fsync 父目錄，最後才刪來源。
 *
 * 恢復只做意圖點名的那一件事：往前做完。任何時刻磁碟上的結果只會是「全在原處、索引沒有」或「全在存放區、索引有」之一。
 *
 * @module
 */

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { isSubagentSessionHeader, sessionDirectoryName } from '@nexus/core';

import { syncDirectory, writeAtomic } from './atomic-file.js';
import {
  legacyTwoFilePathsIn,
  openJsonlSessionStore,
  sessionPathsIn,
} from './jsonl-session-store.js';
import type { WirePrincipal } from './wire-principal.js';

/** 狀態檔在 harness home 底下的名字。 */
export const THREAD_DELETIONS_FILE = 'thread-deletions.json';
/** 刪除記錄（附加式）在 harness home 底下的名字。 */
export const THREAD_DELETIONS_LOG_FILE = 'thread-deletions.log.jsonl';
/** 已刪除存放區在 harness home 底下的預設名字。 */
export const DELETED_STORE_DIR_NAME = 'sessions-deleted';
/** 寬限天數的預設值。 */
export const DEFAULT_GRACE_DAYS = 30;

const DAY_MS = 86_400_000;
const STATE_VERSION = 1;

/** 搬的一個項目：會話目錄或舊兩檔裡的一個檔，名字相對於專案格。 */
export type DeletionItem = string;

export type DeletionStage = 'releasing' | 'moving';

/** 正在做的那一件（狀態檔的 `intent`）。同一時間最多一件。 */
export interface DeletionIntent {
  readonly opId: string;
  readonly kind: 'delete' | 'restore';
  readonly threadId: string;
  readonly projectKey: string;
  readonly actor: WirePrincipal;
  readonly at: number;
  readonly title?: string;
  readonly stage: DeletionStage;
  /** `moving` 之後才有；`releasing` 時還沒列（恢復時照當下的檔重列）。 */
  readonly items?: readonly DeletionItem[];
}

/** 已刪除索引裡的一筆。 */
export interface DeletedThreadRecord {
  readonly threadId: string;
  readonly projectKey: string;
  readonly title?: string;
  readonly deletedAt: number;
  readonly deletedBy: WirePrincipal;
  readonly items: readonly DeletionItem[];
  readonly opId: string;
}

export interface ThreadDeletionState {
  readonly version: typeof STATE_VERSION;
  readonly intent: DeletionIntent | null;
  readonly deleted: readonly DeletedThreadRecord[];
}

/** 刪除記錄的一行。 */
export interface DeletionLogEntry {
  readonly v: 1;
  readonly opId: string;
  readonly kind: 'delete' | 'restore';
  readonly threadId: string;
  readonly projectKey: string;
  readonly at: number;
  readonly actor: WirePrincipal;
  readonly title?: string;
}

export type ThreadDeletionErrorCode =
  | 'busy'
  | 'not_found'
  | 'not_deleted'
  | 'already_deleted'
  | 'expired'
  | 'conflict'
  | 'state_unreadable';

/** 刪除／復原被拒，或狀態檔認不得。`code` 是呼叫端要分支用的。 */
export class ThreadDeletionError extends Error {
  readonly code: ThreadDeletionErrorCode;
  constructor(code: ThreadDeletionErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ThreadDeletionError';
    this.code = code;
  }
}

/**
 * 檔案系統的一處接縫：同磁碟改名。預設是 `fs.rename`；測試換成丟 `EXDEV` 的，逼出複製路徑。
 * 只給測試換，產品路徑不設定它。
 */
export interface DeletionFs {
  readonly moveTree: (from: string, to: string) => Promise<void>;
}

/**
 * 搬移中的一個點：複製完、刪來源之前。只給測試換：子行程在這裡停住，等父行程 SIGKILL。
 */
export interface DeletionHooks {
  readonly afterCopy?: (item: DeletionItem) => Promise<void> | void;
  /** 單一檔複製完、核對之前。只給測試換：用來把副本弄壞，證明核對真的會擋。 */
  readonly afterFileCopy?: (copied: string) => Promise<void> | void;
}

export interface ThreadDeletionOptions {
  /** harness home：狀態檔與刪除記錄放在這裡。 */
  readonly home: string;
  /** 會話根（`harnessSessionsDir`）。 */
  readonly sessionsRoot: string;
  /** 已刪除存放區的根。 */
  readonly deletedRoot: string;
  /** 寬限期（毫秒）。 */
  readonly graceMs: number;
  /** 時鐘，注入。 */
  readonly now: () => number;
  /**
   * 寫入方放手。`delete` 在列檔之前呼叫它：它要等到這條會話的寫租約真的放掉才兌現。
   * 還沒接上 wire 的時候省略即可（見 `docs/operations.md` 的「怎麼刪」）。
   */
  readonly releaseWriter?: (threadId: string) => Promise<void>;
  readonly fs?: DeletionFs;
  readonly hooks?: DeletionHooks;
}

export interface DeletedThreadView {
  readonly threadId: string;
  readonly projectKey: string;
  readonly title?: string;
  readonly deletedAt: number;
  readonly expiresAt: number;
}

// ---------------------------------------------------------------- 狀態檔

function emptyState(): ThreadDeletionState {
  return { version: STATE_VERSION, intent: null, deleted: [] };
}

function unreadable(path: string, why: string): ThreadDeletionError {
  return new ThreadDeletionError(
    'state_unreadable',
    `${path} 認不得（${why}）：不覆寫，請人看過再處理。`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePrincipal(value: unknown): WirePrincipal | undefined {
  if (!isRecord(value)) return undefined;
  if (value['kind'] === 'owner') return { kind: 'owner' };
  if (
    value['kind'] === 'embed' &&
    typeof value['embedder'] === 'string' &&
    typeof value['subject'] === 'string' &&
    typeof value['userId'] === 'string' &&
    typeof value['sessionIdSha256'] === 'string'
  ) {
    return {
      kind: 'embed',
      embedder: value['embedder'],
      subject: value['subject'],
      userId: value['userId'],
      sessionIdSha256: value['sessionIdSha256'],
    };
  }
  return undefined;
}

function strings(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) return undefined;
  return value as readonly string[];
}

function parseIntent(path: string, value: unknown): DeletionIntent {
  if (!isRecord(value)) throw unreadable(path, 'intent 不是物件');
  const actor = parsePrincipal(value['actor']);
  const kind = value['kind'];
  const stage = value['stage'];
  const items = value['items'] === undefined ? undefined : strings(value['items']);
  if (
    typeof value['opId'] !== 'string' ||
    (kind !== 'delete' && kind !== 'restore') ||
    typeof value['threadId'] !== 'string' ||
    typeof value['projectKey'] !== 'string' ||
    typeof value['at'] !== 'number' ||
    actor === undefined ||
    (stage !== 'releasing' && stage !== 'moving') ||
    (value['items'] !== undefined && items === undefined) ||
    (stage === 'moving' && items === undefined) ||
    (value['title'] !== undefined && typeof value['title'] !== 'string')
  ) {
    throw unreadable(path, 'intent 的欄位對不上');
  }
  return {
    opId: value['opId'],
    kind,
    threadId: value['threadId'],
    projectKey: value['projectKey'],
    at: value['at'],
    actor,
    stage,
    ...(typeof value['title'] === 'string' && { title: value['title'] }),
    ...(items !== undefined && { items }),
  };
}

function parseRecord(path: string, value: unknown): DeletedThreadRecord {
  if (!isRecord(value)) throw unreadable(path, 'deleted 的一筆不是物件');
  const actor = parsePrincipal(value['deletedBy']);
  const items = strings(value['items']);
  if (
    typeof value['threadId'] !== 'string' ||
    typeof value['projectKey'] !== 'string' ||
    typeof value['deletedAt'] !== 'number' ||
    typeof value['opId'] !== 'string' ||
    actor === undefined ||
    items === undefined ||
    (value['title'] !== undefined && typeof value['title'] !== 'string')
  ) {
    throw unreadable(path, 'deleted 的欄位對不上');
  }
  return {
    threadId: value['threadId'],
    projectKey: value['projectKey'],
    deletedAt: value['deletedAt'],
    deletedBy: actor,
    items,
    opId: value['opId'],
    ...(typeof value['title'] === 'string' && { title: value['title'] }),
  };
}

/** 讀狀態檔。不存在就是空的；壞掉、版本不對、欄位對不上、有重複，一律拋，不覆寫。 */
export async function readThreadDeletionState(path: string): Promise<ThreadDeletionState> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error: unknown) {
    if (isNotFound(error)) return emptyState();
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error: unknown) {
    throw unreadable(path, `JSON 壞了：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed) || parsed['version'] !== STATE_VERSION) {
    throw unreadable(path, '版本不對');
  }
  const intent = parsed['intent'] === null ? null : parseIntent(path, parsed['intent']);
  if (!Array.isArray(parsed['deleted'])) throw unreadable(path, 'deleted 不是陣列');
  const deleted = parsed['deleted'].map((item) => parseRecord(path, item));
  const keys = new Set(deleted.map((record) => keyOf(record.projectKey, record.threadId)));
  if (keys.size !== deleted.length) throw unreadable(path, 'deleted 有重複的 thread');
  return { version: STATE_VERSION, intent, deleted };
}

async function writeState(path: string, state: ThreadDeletionState): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeAtomic(path, `${JSON.stringify(state, null, 2)}\n`);
}

function keyOf(projectKey: string, threadId: string): string {
  return `${projectKey}\u0000${threadId}`;
}

// ---------------------------------------------------------------- 刪除記錄

/**
 * 附加一行刪除記錄。同一個 `opId` 已經在檔尾就不再附加（恢復重跑時的去重）。
 * 最後一行若沒有換行（上一次附加時斷電），前面補一個換行，那一行留著、解析時略過。
 */
export async function appendDeletionLog(path: string, entry: DeletionLogEntry): Promise<void> {
  let text = '';
  try {
    text = await readFile(path, 'utf8');
  } catch (error: unknown) {
    if (!isNotFound(error)) throw error;
  }
  const lines = text.split('\n');
  const torn = text.length > 0 && !text.endsWith('\n');
  for (const [index, line] of lines.entries()) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error: unknown) {
      // 只有最後一行沒有換行時才是斷電留下的殘骸；中間壞掉就是壞檔，要讓人看。
      if (torn && index === lines.length - 1) continue;
      throw new ThreadDeletionError(
        'state_unreadable',
        `${path} 第 ${String(index + 1)} 行 JSON 壞了`,
        { cause: error },
      );
    }
    if (isRecord(parsed) && parsed['opId'] === entry.opId) return;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, 'a', 0o600);
  try {
    await handle.writeFile(`${torn ? '\n' : ''}${JSON.stringify(entry)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------- 列項目

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error: unknown) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error['code'] === 'ENOENT';
}

/**
 * 列一個會話要搬的項目（相對於專案格）：主會話與它所有子代理（`parentSession` 遞迴）的會話目錄，以及舊兩檔佈局的三個檔。
 * 只列在磁碟上真的有的。呼叫端必須在寫入方放手之後才呼叫，否則列到的會在搬之前又長出來。
 *
 * 子代理用 `store.list()` 的 header 找，不用目錄名前綴：長 id 會被截短，前綴比對會漏。
 */
export async function planItems(projectDir: string, threadId: string): Promise<DeletionItem[]> {
  if (!(await exists(projectDir))) return [];
  const store = openJsonlSessionStore({ directory: projectDir });
  const { sessions } = await store.list();
  const ids = new Set<string>([threadId]);
  for (let grew = true; grew;) {
    grew = false;
    for (const { header } of sessions) {
      // 只收子代理：分叉出去的子會話是獨立的 thread，不跟著搬（它帶 `parentSession` 但不是子代理）。
      const parent = header.parentSession;
      if (
        parent !== undefined &&
        isSubagentSessionHeader(header) &&
        ids.has(parent) &&
        !ids.has(header.id)
      ) {
        ids.add(header.id);
        grew = true;
      }
    }
  }
  const names = new Set<string>();
  for (const id of ids) {
    names.add(sessionDirectoryName(id));
    names.add(basename(sessionPathsIn(projectDir, id).tombstone));
    const legacy = legacyTwoFilePathsIn(projectDir, id);
    names.add(basename(legacy.log));
    names.add(basename(legacy.lock));
  }
  const present: DeletionItem[] = [];
  for (const name of [...names].sort()) {
    if (await exists(join(projectDir, name))) present.push(name);
  }
  return present;
}

/** 底下還有幾個一般檔（空目錄不算：搬完之後留下的空格子不值得警告）。找不到目錄就是 0。 */
async function countFiles(directory: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error: unknown) {
    if (isNotFound(error)) return 0;
    throw error;
  }
  let total = 0;
  for (const entry of entries) {
    const path = join(directory, entry.name);
    total += entry.isDirectory() ? await countFiles(path) : 1;
  }
  return total;
}

// ---------------------------------------------------------------- 搬

async function fingerprint(path: string): Promise<{ size: number; sha256: string }> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    size += (chunk as Buffer).length;
    hash.update(chunk as Buffer);
  }
  return { size, sha256: hash.digest('hex') };
}

/** 複製到一個不存在的 `dst`，逐檔 fsync，每個檔用大小加 sha256 與來源核對。 */
async function copyTreeVerified(src: string, dst: string, hooks: DeletionHooks): Promise<void> {
  const info = await lstat(src);
  if (info.isDirectory()) {
    await mkdir(dst, { mode: 0o700 });
    for (const entry of await readdir(src)) {
      await copyTreeVerified(join(src, entry), join(dst, entry), hooks);
    }
    await syncDirectory(dst);
    return;
  }
  if (!info.isFile()) throw new Error(`不認得的項目（只搬目錄與一般檔）：${src}`);
  await copyFile(src, dst);
  await chmod(dst, 0o600);
  const handle = await open(dst, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await hooks.afterFileCopy?.(dst);
  const [want, got] = await Promise.all([fingerprint(src), fingerprint(dst)]);
  if (want.size !== got.size || want.sha256 !== got.sha256) {
    throw new Error(`複製後核對不符：${src}`);
  }
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error['code'] === 'string' ? error['code'] : undefined;
}

/**
 * 搬一個項目。冪等：任何時候重跑都收斂到同一個結果（見檔頭）。
 */
async function moveItem(
  src: string,
  dst: string,
  item: DeletionItem,
  fs: DeletionFs,
  hooks: DeletionHooks,
): Promise<void> {
  const partial = `${dst}.partial`;
  // 上一次複製到一半留下的，不可能是完整的：先清掉。
  await rm(partial, { recursive: true, force: true });
  if (await exists(dst)) {
    // 目的地只會經由最後一步 rename 出現，所以它在就是完整的；來源若還在，是斷在刪來源之前。
    await rm(src, { recursive: true, force: true });
    return;
  }
  if (!(await exists(src))) return;
  await mkdir(dirname(dst), { recursive: true, mode: 0o700 });
  try {
    await fs.moveTree(src, dst);
  } catch (error: unknown) {
    if (errorCode(error) !== 'EXDEV') throw error;
    await copyTreeVerified(src, partial, hooks);
    await rename(partial, dst);
    await syncDirectory(dirname(dst));
    await hooks.afterCopy?.(item);
    await rm(src, { recursive: true, force: true });
    await syncDirectory(dirname(src));
    return;
  }
  await syncDirectory(dirname(dst));
  await syncDirectory(dirname(src));
}

async function moveItems(
  fromDir: string,
  toDir: string,
  items: readonly DeletionItem[],
  fs: DeletionFs,
  hooks: DeletionHooks,
): Promise<void> {
  for (const item of items) {
    await moveItem(join(fromDir, item), join(toDir, item), item, fs, hooks);
  }
}

const defaultFs: DeletionFs = {
  moveTree: (from, to) => rename(from, to),
};

// ---------------------------------------------------------------- 對外

export interface ThreadDeletionRequest {
  readonly threadId: string;
  readonly projectKey: string;
  readonly actor: WirePrincipal;
  readonly title?: string;
}

/**
 * 刪除與復原的入口。建構時不讀磁碟；狀態在每次操作時重讀，所以兩次操作之間的外部改動會被看見。
 * **同時只能有一件**：意圖一旦寫下，在它被完成或恢復之前，別的刪除／復原都拒絕（`busy`）。
 */
export class ThreadDeletions {
  readonly #options: ThreadDeletionOptions;
  readonly #statePath: string;
  readonly #logPath: string;
  readonly #fs: DeletionFs;
  readonly #hooks: DeletionHooks;

  constructor(options: ThreadDeletionOptions) {
    this.#options = options;
    this.#statePath = join(options.home, THREAD_DELETIONS_FILE);
    this.#logPath = join(options.home, THREAD_DELETIONS_LOG_FILE);
    this.#fs = options.fs ?? defaultFs;
    this.#hooks = options.hooks ?? {};
  }

  /** 已刪除的清單，帶寬限期到期的時間。 */
  async deleted(): Promise<readonly DeletedThreadView[]> {
    const state = await this.#read();
    return state.deleted.map((record) => this.#view(record));
  }

  /**
   * 這條會話在清單上該不該被藏起來：正在刪、或已經刪了，回傳原因；否則 `undefined`。
   * 清單與搜尋共用這一支，判準只有一份。
   */
  async hiddenReason(
    projectKey: string,
    threadId: string,
  ): Promise<'deleting' | 'deleted' | undefined> {
    const state = await this.#read();
    if (state.intent?.projectKey === projectKey && state.intent.threadId === threadId) {
      return 'deleting';
    }
    if (state.deleted.some((r) => r.projectKey === projectKey && r.threadId === threadId)) {
      return 'deleted';
    }
    return undefined;
  }

  /** 刪除一條會話。 */
  async delete(request: ThreadDeletionRequest): Promise<DeletedThreadView> {
    const state = await this.#read();
    if (state.intent !== null) {
      throw new ThreadDeletionError('busy', '已經有一件刪除或復原還沒做完，先等它完成');
    }
    if (
      state.deleted.some(
        (r) => r.projectKey === request.projectKey && r.threadId === request.threadId,
      )
    ) {
      throw new ThreadDeletionError('already_deleted', `thread "${request.threadId}" 已經刪除`);
    }
    const base: DeletionIntent = {
      opId: randomUUID(),
      kind: 'delete',
      threadId: request.threadId,
      projectKey: request.projectKey,
      actor: request.actor,
      at: this.#options.now(),
      stage: 'releasing',
      ...(request.title !== undefined && { title: request.title }),
    };
    await writeState(this.#statePath, { ...state, intent: base });
    try {
      await this.#options.releaseWriter?.(request.threadId);
    } catch (error: unknown) {
      // 寫入方沒放手：什麼都還沒搬，撤掉意圖，原樣拋。
      await writeState(this.#statePath, { ...state, intent: null });
      throw error;
    }
    const projectDir = join(this.#options.sessionsRoot, request.projectKey);
    const items = await planItems(projectDir, request.threadId);
    if (items.length === 0) {
      await writeState(this.#statePath, { ...state, intent: null });
      throw new ThreadDeletionError('not_found', `thread "${request.threadId}" 在磁碟上找不到`);
    }
    const moving: DeletionIntent = { ...base, stage: 'moving', items };
    await writeState(this.#statePath, { ...state, intent: moving });
    return this.#runAndFinish(moving);
  }

  /**
   * 復原一條已刪除的會話。寬限期過了、原處已有同名的項目、或沒有這一筆，都拒絕，檔案留著。
   */
  async restore(request: {
    threadId: string;
    projectKey: string;
    actor: WirePrincipal;
  }): Promise<void> {
    const state = await this.#read();
    if (state.intent !== null) {
      throw new ThreadDeletionError('busy', '已經有一件刪除或復原還沒做完，先等它完成');
    }
    const record = state.deleted.find(
      (r) => r.projectKey === request.projectKey && r.threadId === request.threadId,
    );
    if (record === undefined) {
      throw new ThreadDeletionError('not_deleted', `thread "${request.threadId}" 不在已刪除存放區`);
    }
    if (this.#options.now() >= record.deletedAt + this.#options.graceMs) {
      throw new ThreadDeletionError(
        'expired',
        `thread "${request.threadId}" 已過寬限期，不能復原（檔案留著）`,
      );
    }
    const projectDir = join(this.#options.sessionsRoot, request.projectKey);
    for (const item of record.items) {
      if (await exists(join(projectDir, item))) {
        throw new ThreadDeletionError('conflict', `原處已有 "${item}"，不覆寫`);
      }
    }
    const intent: DeletionIntent = {
      opId: randomUUID(),
      kind: 'restore',
      threadId: request.threadId,
      projectKey: request.projectKey,
      actor: request.actor,
      at: this.#options.now(),
      stage: 'moving',
      items: record.items,
    };
    await writeState(this.#statePath, { ...state, intent });
    await this.#runAndFinish(intent);
  }

  /**
   * 啟動時恢復：只完成意圖點名的那一件。沒有意圖就什麼都不做。
   * @returns 做了哪一件（`undefined` 是沒有意圖）。
   */
  async recover(): Promise<DeletionIntent | undefined> {
    const state = await this.#read();
    const intent = state.intent;
    if (intent === null) return undefined;
    if (intent.kind === 'delete' && intent.stage === 'releasing') {
      const items = await planItems(
        join(this.#options.sessionsRoot, intent.projectKey),
        intent.threadId,
      );
      if (items.length === 0) {
        await writeState(this.#statePath, { ...state, intent: null });
        return intent;
      }
      const moving: DeletionIntent = { ...intent, stage: 'moving', items };
      await writeState(this.#statePath, { ...state, intent: moving });
      await this.#runAndFinish(moving);
      return moving;
    }
    await this.#runAndFinish(intent);
    return intent;
  }

  /**
   * 存放區路徑不是預設、而預設路徑底下還有檔時回一行警告（附搬移指令）；否則 `undefined`。
   *
   * 不記上一次的路徑：只比「這次設定的」與「預設的」。代價是兩個非預設路徑之間換來換去時不會警告，
   * 那個情形要人自己搬（見 `docs/operations.md`）。設定改了不自動搬。
   *
   * @param defaultRoot - 出廠預設的存放區（`<home>/sessions-deleted`）。
   */
  async checkStoreMoved(defaultRoot: string): Promise<string | undefined> {
    const current = resolve(this.#options.deletedRoot);
    const fallback = resolve(defaultRoot);
    if (current === fallback) return undefined;
    const files = await countFiles(fallback);
    if (files === 0) return undefined;
    return (
      `[已刪除存放區] 存放區路徑設成 ${current}，預設路徑 ${fallback} 底下還有 ${String(files)} 個檔，` +
      `寬限期內的會話在新路徑找不到。要搬過去請執行：mv "${fallback}"/* "${current}"/`
    );
  }

  async #read(): Promise<ThreadDeletionState> {
    return readThreadDeletionState(this.#statePath);
  }

  #view(record: DeletedThreadRecord): DeletedThreadView {
    return {
      threadId: record.threadId,
      projectKey: record.projectKey,
      ...(record.title !== undefined && { title: record.title }),
      deletedAt: record.deletedAt,
      expiresAt: record.deletedAt + this.#options.graceMs,
    };
  }

  /** 搬（方向由意圖決定），然後收尾：附加記錄、寫索引、清意圖。 */
  async #runAndFinish(intent: DeletionIntent): Promise<DeletedThreadView> {
    const items = intent.items ?? [];
    const projectDir = join(this.#options.sessionsRoot, intent.projectKey);
    const deletedDir = join(this.#options.deletedRoot, intent.projectKey);
    if (intent.kind === 'delete') {
      await moveItems(projectDir, deletedDir, items, this.#fs, this.#hooks);
    } else {
      await moveItems(deletedDir, projectDir, items, this.#fs, this.#hooks);
    }
    await appendDeletionLog(this.#logPath, {
      v: 1,
      opId: intent.opId,
      kind: intent.kind,
      threadId: intent.threadId,
      projectKey: intent.projectKey,
      at: intent.at,
      actor: intent.actor,
      ...(intent.title !== undefined && { title: intent.title }),
    });
    const state = await this.#read();
    const others = state.deleted.filter(
      (r) => !(r.projectKey === intent.projectKey && r.threadId === intent.threadId),
    );
    const record: DeletedThreadRecord = {
      threadId: intent.threadId,
      projectKey: intent.projectKey,
      ...(intent.title !== undefined && { title: intent.title }),
      deletedAt: intent.at,
      deletedBy: intent.actor,
      items,
      opId: intent.opId,
    };
    const deleted = intent.kind === 'delete' ? [...others, record] : others;
    await writeState(this.#statePath, {
      ...state,
      intent: null,
      deleted,
    });
    return this.#view(record);
  }
}

/**
 * 啟動時的刪除層：先恢復（意圖點名的那一件），再看存放區路徑有沒有被改過。回傳要印的警告（沒有就 `undefined`）。
 * `serve-run.ts` 在組裝期呼叫它；拆成函式是為了讓啟動層能不靠整台 serve 就測。
 */
export async function runDeletionStartup(
  deletions: ThreadDeletions,
  defaultRoot: string,
): Promise<{
  readonly recovered: DeletionIntent | undefined;
  readonly warning: string | undefined;
}> {
  const recovered = await deletions.recover();
  const warning = await deletions.checkStoreMoved(defaultRoot);
  return { recovered, warning };
}

/** 寬限期的毫秒數：天數不是正數就拒絕（不靜默降級）。 */
export function graceMsOfDays(days: number): number {
  if (!Number.isFinite(days) || days <= 0) {
    throw new TypeError(`寬限天數要是正數，拿到 ${String(days)}`);
  }
  return days * DAY_MS;
}

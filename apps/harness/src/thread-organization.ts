/**
 * 側欄的釘選與封存：存在 harness home 底下的一個專用檔
 * （[#633](https://github.com/DemianLi/nexus-agent/issues/633)，第一張：釘選＋封存）。
 *
 * 照 dsh 的 `WorkspaceRegistry`（`packages/workspace/workspace/src/index.ts` 的 `archiveSession`／`unarchiveSession`／`pinSession`／
 * `unpinSession`，`5badb15009a`）：**兩個全域集合，不是會話身上的旗標**；每次變更回完整的集合；釘選**最近釘的在前**、封存**依封存順序**；
 * 每一步都在序列佇列裡跑，所以「先檢查、再寫」不會被別的變更插進中間；取消是冪等的、不檢查會話存不存在。
 *
 * ## 規則（逐條對過 dsh 原始碼）
 *
 * - **釘選**：已經釘了 → 什麼都不做（不重排、不寫）；否則已封存 → {@link ThreadArchivedPinError}；否則會話不存在 →
 *   {@link ThreadUnknownError}；通過才寫，插在最前面。**這個先後是 dsh 的**：已釘的即使會話已不存在也回成功。
 * - **封存**：已經封存 → 什麼都不做（不問、不停）；否則會話不存在 → {@link ThreadUnknownError}；沒帶 `stopActivity` 時，
 *   問 `activity`，有任何一項就 {@link ThreadActiveError}、**一個位元組都不寫**；通過才寫——**同一次寫入把它的釘選一併拿掉**
 *   （釘選與封存互斥）。帶了 `stopActivity`：先寫、**再**請 `stop` 去停，不等停穩；`stop` 拋了只講一聲、不撤銷封存。
 * - **取消釘選／取消封存**：不在集合裡就什麼都不做；**不檢查會話存不存在**（拿掉一個 id 不會引進不認得的 id）。
 *
 * ## 載體：home 底下一個檔，規矩同 `browser-session-secret.ts`
 *
 * PM 在卡上拍板（2026-10-08）：放在 `NEXUS_AGENT_HOME` 底下一個檔、按 home 分，目錄 `0700`、檔案 `0600`。dsh 把這兩個集合放在
 * workspace registry 的耐久狀態裡；我們沒有 workspace registry（卡上「動工前要查的」），退的是載體，規矩照抄：
 *
 * - 記錄帶版本（`{ version: 1, pinnedThreadIds, archivedThreadIds }`）；**認不得的記錄明確失敗、不覆寫**（版本不對、JSON 壞、
 *   欄位型別不對、兩個集合有重複或互相重疊）——交給人決定，跟瀏覽器密鑰那一把、受管憑證檔同一個處置。
 * - 讀之前先確認只有擁有者讀得到（`owner-only.ts`）。
 * - 寫是**先寫暫存檔、再 `rename` 蓋過去**：讀的一方永遠讀不到寫一半的檔，行程死在中間也只會留一個暫存檔。
 * - **開檔在啟動時**（`serve.ts`），壞檔就讓 serve 起不來，而不是第一個釘選請求才失敗——跟瀏覽器密鑰那一把一樣。
 *
 * ## 單一寫入者
 *
 * 記憶體裡的集合是真相，檔案是它的耐久副本：兩個 serve 行程共用同一個 home 時，後寫的會蓋掉先寫的（各自的記憶體互不知道）。
 * dsh 的 registry 同樣是單一寫入者的 domain（`DomainGlobal.set` 之後才換 `this.state`，全部經 `enqueueOperation`）。這裡不另做跨行程的鎖，
 * 登記在這裡：多人共用主機時各人用各自的 home（`harness-home.ts`），集合本來就按 home 分。
 *
 * @module
 */

import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ThreadActivityKind } from '@nexus/wire';

import { assertOwnerOnlyMode, PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from './owner-only.js';

/** 檔案在 harness home 底下的名字。 */
export const THREAD_ORGANIZATION_FILE = 'thread-organization.json';

const RECORD_VERSION = 1;

/** 釘選／封存的會話不存在（dsh `WorkspaceUnknownSessionError`）。 */
export class ThreadUnknownError extends Error {
  override readonly name = 'ThreadUnknownError';

  constructor(
    readonly threadId: string,
    readonly operation: 'pin' | 'archive',
  ) {
    super(`沒有這條會話可以${operation === 'pin' ? '釘選' : '封存'}：${threadId}`);
  }
}

/** 釘選一條已封存的會話（dsh `WorkspaceArchivedSessionPinError`）：釘選與封存互斥。 */
export class ThreadArchivedPinError extends Error {
  override readonly name = 'ThreadArchivedPinError';

  constructor(readonly threadId: string) {
    super(`會話 ${threadId} 已封存，不能釘選；先取消封存`);
  }
}

/** 封存一條還有工作在跑、又沒帶 `stopActivity` 的會話（dsh `WorkspaceActiveSessionError`）。 */
export class ThreadActiveError extends Error {
  override readonly name = 'ThreadActiveError';

  constructor(
    readonly threadId: string,
    readonly activity: readonly ThreadActivityKind[],
  ) {
    super(
      `會話 ${threadId} 還有工作在跑（${activity.join('、')}）；帶 stopActivity 先停掉它再封存`,
    );
  }
}

/** {@link ThreadOrganization.archive} 要的外部事實，由呼叫端（`wire-handler.ts`）按它手上的 thread 回答。 */
export interface ArchiveDeps {
  /** 先停掉它的工作再封存，而不是以 {@link ThreadActiveError} 拒絕。 */
  readonly stopActivity?: boolean;
  /** 會話存不存在（活著的，或落盤的）。**儲存體讀不動要拋，不要回 `false`**：壞掉的磁碟不是「沒有這條」。 */
  readonly known: () => Promise<boolean>;
  /** 這條會話還有什麼在跑；空陣列＝閒著。沒帶 `stopActivity` 才問。 */
  readonly activity: () => readonly ThreadActivityKind[];
  /** 帶 `stopActivity` 時，封存寫下去**之後**請它去停。發出去就算，不等停穩；拋了由 {@link ArchiveDeps.warn} 講一聲。 */
  readonly stop: () => Promise<void> | void;
  /** 停失敗時講一聲（不撤銷封存）。 */
  readonly warn?: (message: string) => void;
}

interface OrganizationState {
  readonly pinnedThreadIds: readonly string[];
  readonly archivedThreadIds: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/** 一串 id：全是非空字串、沒有重複。不是就回 `undefined`。 */
function idList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string' || entry === '' || seen.has(entry)) return undefined;
    seen.add(entry);
  }
  return value as readonly string[];
}

/** 解一份檔案內容；認不得就回 `undefined`（由呼叫端拋）。 */
function parseRecord(text: string): OrganizationState | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed['version'] !== RECORD_VERSION) return undefined;
  const pinned = idList(parsed['pinnedThreadIds']);
  const archived = idList(parsed['archivedThreadIds']);
  if (pinned === undefined || archived === undefined) return undefined;
  // 釘選與封存互斥：同一個 id 兩邊都在，是別的東西寫的，不是我們寫的。
  const archivedSet = new Set(archived);
  if (pinned.some((id) => archivedSet.has(id))) return undefined;
  return { pinnedThreadIds: pinned, archivedThreadIds: archived };
}

/**
 * 釘選與封存兩個集合，與它們住的那個檔。建構用 {@link ThreadOrganization.open}。
 */
export class ThreadOrganization {
  readonly #file: string;
  readonly #home: string;
  #state: OrganizationState;
  /** 序列佇列的尾巴：每一個變更排在前一個之後，前一個失敗不拖累後面的。 */
  #tail: Promise<unknown> = Promise.resolve();

  private constructor(home: string, state: OrganizationState) {
    this.#home = home;
    this.#file = join(home, THREAD_ORGANIZATION_FILE);
    this.#state = state;
  }

  /**
   * 讀 home 底下的檔；沒有就是兩個空集合（**不在這裡建檔**，第一次變更才寫）。
   *
   * @param home - harness home（`harness-home.ts` 解析出來的絕對路徑）。
   * @throws 權限過寬，或內容認不得（版本、JSON、欄位型別、重複、互斥）——都不覆寫，由人決定。
   */
  static async open(home: string): Promise<ThreadOrganization> {
    const file = join(home, THREAD_ORGANIZATION_FILE);
    let mode: number;
    try {
      mode = (await stat(file)).mode;
    } catch (error) {
      if (isMissing(error)) return new ThreadOrganization(home, emptyState());
      throw error;
    }
    assertOwnerOnlyMode('會話整理檔（釘選與封存）', file, mode);
    const state = parseRecord(await readFile(file, 'utf8'));
    if (state === undefined) {
      throw new Error(
        `會話整理檔 ${file} 的格式認不得（要 { "version": 1, "pinnedThreadIds": […], "archivedThreadIds": […] }，` +
          `兩個集合各自不重複、彼此不重疊）；確認它不是別的東西寫的。要重設就刪掉它再重啟 serve——釘選與封存會全部清空。`,
      );
    }
    return new ThreadOrganization(home, state);
  }

  /** 釘選的會話，**最近釘的在前**。 */
  get pinnedThreadIds(): readonly string[] {
    return this.#state.pinnedThreadIds;
  }

  /** 封存的會話，依封存順序。 */
  get archivedThreadIds(): readonly string[] {
    return this.#state.archivedThreadIds;
  }

  /** 這條會話封存了沒有。同步讀記憶體，給閘門每一輪問。 */
  isArchived(threadId: string): boolean {
    return this.#state.archivedThreadIds.includes(threadId);
  }

  /**
   * 釘選一條會話。已釘的什麼都不做；封存的拋 {@link ThreadArchivedPinError}；不存在的拋 {@link ThreadUnknownError}。
   *
   * @param known - 會話存不存在，見 {@link ArchiveDeps.known}。
   */
  pin(threadId: string, known: () => Promise<boolean>): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#state.pinnedThreadIds.includes(threadId)) return;
      if (this.#state.archivedThreadIds.includes(threadId)) {
        throw new ThreadArchivedPinError(threadId);
      }
      if (!(await known())) throw new ThreadUnknownError(threadId, 'pin');
      await this.#commit({
        ...this.#state,
        pinnedThreadIds: [threadId, ...this.#state.pinnedThreadIds],
      });
    });
  }

  /** 取消釘選。不在集合裡什麼都不做，不檢查會話存不存在。 */
  unpin(threadId: string): Promise<void> {
    return this.#enqueue(async () => {
      if (!this.#state.pinnedThreadIds.includes(threadId)) return;
      await this.#commit({
        ...this.#state,
        pinnedThreadIds: this.#state.pinnedThreadIds.filter((id) => id !== threadId),
      });
    });
  }

  /**
   * 封存一條會話，規矩見檔頭。
   *
   * @throws {@link ThreadUnknownError} 會話不存在。
   * @throws {@link ThreadActiveError} 還有工作在跑，又沒帶 `stopActivity`——一個位元組都沒寫。
   */
  archive(threadId: string, deps: ArchiveDeps): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#state.archivedThreadIds.includes(threadId)) return;
      if (!(await deps.known())) throw new ThreadUnknownError(threadId, 'archive');
      if (deps.stopActivity !== true) {
        const activity = deps.activity();
        if (activity.length > 0) throw new ThreadActiveError(threadId, activity);
      }
      await this.#commit({
        pinnedThreadIds: this.#state.pinnedThreadIds.filter((id) => id !== threadId),
        archivedThreadIds: [...this.#state.archivedThreadIds, threadId],
      });
      if (deps.stopActivity === true) {
        // 寫已經落定了：閘門（`isArchived`）讀的就是這份，停的過程中任何被喚醒的一輪都已經被擋。
        try {
          await deps.stop();
        } catch (error) {
          deps.warn?.(
            `[封存] 停掉會話 ${threadId} 的工作時出事，封存照舊：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    });
  }

  /** 取消封存。不在集合裡什麼都不做，不檢查會話存不存在。 */
  unarchive(threadId: string): Promise<void> {
    return this.#enqueue(async () => {
      if (!this.#state.archivedThreadIds.includes(threadId)) return;
      await this.#commit({
        ...this.#state,
        archivedThreadIds: this.#state.archivedThreadIds.filter((id) => id !== threadId),
      });
    });
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * 先寫檔、成功了才換記憶體裡的：寫不進去時記憶體不動，閘門與下一個請求看到的仍是檔案上的那一份。
   * 暫存檔 `wx`（不蓋別人的）、`0600`、寫完 `sync` 再 `rename` 蓋過去。
   */
  async #commit(next: OrganizationState): Promise<void> {
    await mkdir(this.#home, { recursive: true, mode: PRIVATE_DIR_MODE });
    const staging = join(
      this.#home,
      `.${THREAD_ORGANIZATION_FILE}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
    );
    const text = `${JSON.stringify({ version: RECORD_VERSION, ...next })}\n`;
    try {
      const handle = await open(staging, 'wx', PRIVATE_FILE_MODE);
      try {
        await handle.writeFile(text, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(staging, this.#file);
    } catch (error) {
      await rm(staging, { force: true });
      throw error;
    }
    this.#state = next;
  }
}

function emptyState(): OrganizationState {
  return { pinnedThreadIds: [], archivedThreadIds: [] };
}

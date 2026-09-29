/**
 * `@` 引用別的會話時的候選清單（[#713](https://github.com/DemianLi/nexus-agent/issues/713)）。
 *
 * 照 dsh 的 `SessionReferenceResolver.listCandidates`（`packages/context/session-reference/src/index.ts`，`477b4f4`）：
 * **列全部會話**（含別的專案與子代理），排除自己，同工作區的排前面、沒記目錄的次之、其餘最後，最多 50 筆，
 * 對 id／目錄／標題做不分大小寫的子字串比對，**不搜內文**。
 *
 * ## 讀法：經過 `SessionStore`，冷讀
 *
 * 列走 `list`、標題走 `open(id, 'read')`（[#665](https://github.com/DemianLi/nexus-agent/issues/665)），**不為它建起任何 thread**，
 * 不拿寫租約。跨專案的部分列的是會話根底下每一格專案目錄（{@link listSessionStoreDirectories}），每一格各開一個唯讀把手。
 *
 * ## 偏離 dsh（登記）
 *
 * 1. **標題的來源**：dsh 的候選只讀投影快取，「不讀日誌」，沒有快取的會話就用 id 當標題（`projectedLabels` 的註解）。我們沒有那一層
 *    （[#725](https://github.com/DemianLi/nexus-agent/issues/725)），標題得從日誌本文折出來，而這條路在每打一個字的下面。退到最接近的實作：
 *    **行程內的快取，以 `revision` 為鍵**——`revision` 沒變就不重讀，正是 #665 加它的用途。第一次冷讀整個會話根，之後只有變動過的
 *    （多半是正在跑的那幾條）重讀。dsh 的做法「表達不出來」是因為我們今天沒有投影快取這一層。
 * 2. **排序**：dsh 同一等級內照 `list` 的順序，那個順序沒有約定。我們同一等級內照 `updatedAt` 由新到舊、再照 id，讓同一份資料每次排得一樣。
 * 3. **CLI 的 run 目錄不列**：CLI 的 root id 一律叫 `cli`，引用只編 id，指不到唯一的一份（見 `session-references.ts` 的偏離第 5 條）。
 *
 * @module
 */

import { basename } from 'node:path';

import {
  SessionCorruptionError,
  SessionFormatUnsupportedError,
  SessionNotFoundError,
} from '@nexus/core';
import type { SessionEvent, SessionStore, StoredSessionSnapshot } from '@nexus/core';
import {
  DEFAULT_SESSION_REFERENCE_CANDIDATE_LIMIT,
  formatSessionReferenceMention,
} from '@nexus/wire';
import type { SessionReferenceCandidate } from '@nexus/wire';

import {
  listSessionStoreDirectories,
  openJsonlSessionStore,
  projectKey,
} from './jsonl-session-store.js';
import { scanPrompts } from './session-list.js';
import type { PromptScan } from './session-list.js';
import { assertThreadTitleLimits } from './session-title.js';
import type { ThreadTitleLimits } from './session-title.js';

/** 同時讀幾份日誌的標題。 */
const SCAN_CONCURRENCY = 8;

export interface SessionReferenceCandidatesOptions {
  /** 會話根：底下每個專案一格（`serve` 的 `resolveSessionLogDir`）。 */
  readonly rootDir: string;
  /** 這台 server 的工作目錄：同工作區排前面、專案自己的那一格優先。 */
  readonly cwd: string;
  /** 標題的兩個上限，同列表。 */
  readonly title: ThreadTitleLimits;
  /** 開一格專案目錄的唯讀把手。省略就是 JSONL 後端；測試換成替身。 */
  readonly openStore?: (directory: string) => SessionStore;
  /** 別格目錄讀不了、日誌本文讀不了時講一聲（不擋整份清單）。 */
  readonly warn?: (message: string) => void;
  /** 最多回幾筆。省略是 {@link DEFAULT_SESSION_REFERENCE_CANDIDATE_LIMIT}。 */
  readonly limit?: number;
}

interface Row {
  readonly snapshot: StoredSessionSnapshot;
  readonly scan: PromptScan;
  readonly label: string;
  readonly updatedAt: number;
}

interface CachedScan {
  readonly revision: string;
  readonly scan: PromptScan;
}

/** 由小到大的字串比較：`localeCompare` 依語系，同一份資料在兩台機器上排出不同順序。 */
function byCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export class SessionReferenceCandidates {
  readonly #options: SessionReferenceCandidatesOptions;
  readonly #stores = new Map<string, SessionStore>();
  /** `<目錄>\0<id>` → 讀過的標題與當時的 `revision`。每次列完只留這一次還在的。 */
  #scans = new Map<string, CachedScan>();

  constructor(options: SessionReferenceCandidatesOptions) {
    assertThreadTitleLimits(options.title);
    this.#options = options;
  }

  #storeOf(directory: string): SessionStore {
    let store = this.#stores.get(directory);
    if (store === undefined) {
      store = (this.#options.openStore ?? ((dir) => openJsonlSessionStore({ directory: dir })))(
        directory,
      );
      this.#stores.set(directory, store);
    }
    return store;
  }

  /**
   * 列候選。
   *
   * @param selfId - 提問的那條 thread：它自己不列。
   * @param query - `@` 後面那一段；不分大小寫比對 id、目錄、標題。
   * @param signal - 中止這一次（每打一個字就取消上一次）。中止時拋它的 `reason`。
   * @returns 排好序、切到上限的候選，每筆帶編好的引用文字。
   */
  async list(
    selfId: string,
    query: string,
    signal?: AbortSignal,
  ): Promise<SessionReferenceCandidate[]> {
    const rows = await this.#rows(signal);
    const labelOf = new Map(rows.map(({ snapshot, label }) => [snapshot.header.id, label]));
    const needle = query.toLocaleLowerCase();
    const { cwd, limit = DEFAULT_SESSION_REFERENCE_CANDIDATE_LIMIT } = this.#options;
    const rank = (rowCwd: string | undefined): number =>
      rowCwd === cwd ? 0 : rowCwd === undefined ? 1 : 2;
    return rows
      .filter(({ snapshot, label }) => {
        const { id, cwd: rowCwd } = snapshot.header;
        if (id === selfId) return false;
        return (
          needle === '' ||
          id.toLocaleLowerCase().includes(needle) ||
          (rowCwd?.toLocaleLowerCase().includes(needle) ?? false) ||
          label.toLocaleLowerCase().includes(needle)
        );
      })
      .sort(
        (left, right) =>
          rank(left.snapshot.header.cwd) - rank(right.snapshot.header.cwd) ||
          right.updatedAt - left.updatedAt ||
          byCodeUnit(left.snapshot.header.id, right.snapshot.header.id),
      )
      .slice(0, limit)
      .map(({ snapshot, label, updatedAt }): SessionReferenceCandidate => {
        const { header } = snapshot;
        return {
          sessionId: header.id,
          label,
          ...(header.cwd !== undefined && { cwd: header.cwd }),
          sameWorkspace: header.cwd !== undefined && header.cwd === cwd,
          createdAt: header.createdAt,
          updatedAt,
          ...(header.parentSession !== undefined && {
            parentSessionId: header.parentSession,
            parentLabel: labelOf.get(header.parentSession) ?? header.parentSession,
          }),
          mention: formatSessionReferenceMention({ sessionId: header.id, label }),
        };
      });
  }

  /** 每一格專案目錄裡讀得出來的會話，各帶標題。同一個 id 出現在兩格時，專案自己的那一格優先。 */
  async #rows(signal: AbortSignal | undefined): Promise<Row[]> {
    signal?.throwIfAborted();
    const own = projectKey(this.#options.cwd);
    const directories = (await listSessionStoreDirectories(this.#options.rootDir))
      .filter(({ kind }) => kind === 'project')
      .sort(
        (left, right) =>
          Number(basename(right.directory) === own) - Number(basename(left.directory) === own) ||
          byCodeUnit(left.directory, right.directory),
      );
    const listed: { directory: string; snapshot: StoredSessionSnapshot }[] = [];
    const seen = new Set<string>();
    for (const { directory } of directories) {
      let sessions: readonly StoredSessionSnapshot[];
      try {
        sessions = (await this.#storeOf(directory).list(signal === undefined ? {} : { signal }))
          .sessions;
      } catch (error: unknown) {
        signal?.throwIfAborted();
        this.#options.warn?.(`[會話引用] 列不出 ${directory}：${String(error)}`);
        continue;
      }
      for (const snapshot of sessions) {
        if (seen.has(snapshot.header.id)) continue;
        seen.add(snapshot.header.id);
        listed.push({ directory, snapshot });
      }
    }
    const nextScans = new Map<string, CachedScan>();
    const rows: (Row | undefined)[] = new Array<Row | undefined>(listed.length);
    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        signal?.throwIfAborted();
        const index = cursor++;
        const item = listed[index];
        if (item === undefined) return;
        const { directory, snapshot } = item;
        const key = `${directory}\0${snapshot.header.id}`;
        const cached = this.#scans.get(key);
        let scan: PromptScan | undefined;
        if (cached?.revision === snapshot.revision) {
          scan = cached.scan;
        } else {
          scan = await this.#scan(directory, snapshot);
        }
        if (scan === undefined) continue;
        nextScans.set(key, { revision: snapshot.revision, scan });
        rows[index] = {
          snapshot,
          scan,
          label: scan.title ?? snapshot.header.id,
          updatedAt: Math.max(snapshot.header.createdAt, scan.lastPromptAt ?? 0),
        };
      }
    };
    await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, worker));
    signal?.throwIfAborted();
    this.#scans = nextScans;
    return rows.filter((row): row is Row => row !== undefined);
  }

  /** 讀一份日誌折出標題；列與讀之間被刪掉、或壞得讀不了的回 `undefined`（不列）。 */
  async #scan(directory: string, snapshot: StoredSessionSnapshot): Promise<PromptScan | undefined> {
    let events: readonly SessionEvent[];
    try {
      const reader = await this.#storeOf(directory).open(snapshot.header.id, 'read');
      events = await reader.read({ salvage: true });
    } catch (error: unknown) {
      if (
        error instanceof SessionNotFoundError ||
        error instanceof SessionCorruptionError ||
        error instanceof SessionFormatUnsupportedError
      ) {
        return undefined;
      }
      throw error;
    }
    return scanPrompts(events, this.#options.title);
  }
}

/**
 * 看 serve 寫資料的地方滿了沒（[#2195](https://github.com/DemianLi/nexus-agent/issues/2195)）：給 `/readyz` 與指標用。
 *
 * `fs.statfs` 走 libuv 的執行緒池，逾時取消不了底層呼叫。卡住的網路磁碟若每次探針都疊一顆，會吃滿
 * 執行緒池、拖垮全部檔案 I/O，所以**舊的一輪還沒回來就不發新的**，探針多快 I/O 都不會跟著變多。
 * 等不到結果或查失敗都沿用上一次已知的狀態；從沒查到過就算沒滿。
 *
 * 判的是**區塊或 inode 任一項回報了總數、可用數為零**：btrfs、部分 NFS 的 `files` 回 0，不能當滿。
 * 配額（`EDQUOT`）`statfs` 看不到，這裡抓不到。
 *
 * @module
 */

import { statfs as nodeStatfs } from 'node:fs/promises';
import { dirname } from 'node:path';

/** 指標的 `area` 標籤值：只有區名，不帶路徑。 */
export const STORAGE_AREAS = ['home', 'thread-roots'] as const;

/** {@link STORAGE_AREAS} 的一員。 */
export type StorageArea = (typeof STORAGE_AREAS)[number];

/** `statfs` 結果裡這裡讀的四格。 */
export interface StatfsResult {
  readonly blocks: number;
  /** 非特權行程可用的區塊，不是 `bfree`：保留給 root 的那一段 serve 寫不進去。 */
  readonly bavail: number;
  readonly files: number;
  readonly ffree: number;
}

/** 兩次 `statfs` 之間至少隔這麼久。 */
const CHECK_INTERVAL_MS = 5_000;
/** 探針最多等這麼久，等不到就用上一次的狀態。 */
const CHECK_TIMEOUT_MS = 1_000;

/**
 * 這個檔案系統滿了沒。
 *
 * @param stat - `statfs` 的結果。
 * @returns 區塊或 inode 回報了總數而且用完。
 */
export function isStorageFull({ blocks, bavail, files, ffree }: StatfsResult): boolean {
  return (blocks > 0 && bavail === 0) || (files > 0 && ffree === 0);
}

/** {@link StorageProbe} 的選項。 */
export interface StorageProbeOptions {
  /** 每一區實際寫入的目錄。 */
  readonly areas: Readonly<Record<StorageArea, readonly string[]>>;
  readonly warn: (message: string) => void;
  /** 測試用；省略即 `node:fs/promises` 的 `statfs`。 */
  readonly statfs?: (path: string) => Promise<StatfsResult>;
  readonly now?: () => number;
  readonly intervalMs?: number;
  readonly timeoutMs?: number;
}

/** 目錄還不存在時往上找到存在的那一層：那一層的檔案系統就是它會寫到的地方。 */
async function statExisting(
  statfs: NonNullable<StorageProbeOptions['statfs']>,
  path: string,
): Promise<StatfsResult> {
  for (let at = path; ; at = dirname(at)) {
    try {
      return await statfs(at);
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
      if (!missing || dirname(at) === at) throw error;
    }
  }
}

/** 見檔頭。 */
export class StorageProbe {
  readonly #options: StorageProbeOptions;
  readonly #statfs: NonNullable<StorageProbeOptions['statfs']>;
  readonly #now: () => number;
  readonly #intervalMs: number;
  readonly #timeoutMs: number;
  readonly #full = new Set<StorageArea>();
  #checkedAt = Number.NEGATIVE_INFINITY;
  #running: Promise<void> | undefined;
  /** 同一段狀況只講一次：查得順了才重新講。 */
  #warned = false;

  constructor(options: StorageProbeOptions) {
    this.#options = options;
    this.#statfs = options.statfs ?? nodeStatfs;
    this.#now = options.now ?? Date.now;
    this.#intervalMs = options.intervalMs ?? CHECK_INTERVAL_MS;
    this.#timeoutMs = options.timeoutMs ?? CHECK_TIMEOUT_MS;
  }

  /** 目前已知滿了的區。 */
  get full(): readonly StorageArea[] {
    return STORAGE_AREAS.filter((area) => this.#full.has(area));
  }

  /** 需要的話查一次。不拋；上一輪還沒回來、或時間窗還沒過就直接回。 */
  async refresh(): Promise<void> {
    if (this.#running !== undefined) return;
    if (this.#now() - this.#checkedAt < this.#intervalMs) return;
    const running = this.#check().finally(() => {
      this.#running = undefined;
    });
    this.#running = running;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => resolve('late'), this.#timeoutMs);
      timer.unref();
    });
    const outcome = await Promise.race([running, late]);
    clearTimeout(timer);
    if (outcome === 'late') this.#warnOnce(`查不到磁碟空間：statfs ${this.#timeoutMs} 毫秒沒回來`);
  }

  async #check(): Promise<void> {
    let clean = true;
    for (const area of STORAGE_AREAS) {
      let full = false;
      try {
        for (const path of this.#options.areas[area]) {
          if (isStorageFull(await statExisting(this.#statfs, path))) full = true;
        }
      } catch (error) {
        clean = false;
        this.#warnOnce(`查不到 ${area} 的磁碟空間：${(error as Error).message}`);
        continue;
      }
      if (full && !this.#full.has(area)) this.#options.warn(`[儲存] ${area} 滿了`);
      if (!full && this.#full.has(area)) this.#options.warn(`[儲存] ${area} 有空間了`);
      if (full) this.#full.add(area);
      else this.#full.delete(area);
    }
    this.#checkedAt = this.#now();
    if (clean) this.#warned = false;
  }

  #warnOnce(message: string): void {
    if (this.#warned) return;
    this.#warned = true;
    this.#options.warn(`[儲存] ${message}`);
  }
}

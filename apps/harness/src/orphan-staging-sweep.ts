/**
 * 清掉崩潰留在私有根的原子寫入暫存（[#2198](https://github.com/DemianLi/nexus-agent/issues/2198)）。
 *
 * `writeFileAtomic` 的暫存目錄建在目標旁邊，正常路徑都會收掉，只有 `kill -9` 這類崩潰會留下
 * `.<basename>.<pid>.<uuid>.tmpdir`。模型列得到它，它也佔著空間。這裡在一條 thread 續接時，背景掃一次它自己的私有根。
 *
 * **根是模型可寫的**，所以這支行程的每一步都要假設目錄項隨時會被換掉：
 *
 * - 判斷孤兒看四件事，全部成立才動：名字形狀、`lstat` 是真目錄、擁有者是這個行程、內容是空的或只有那個 `<basename>.tmp`；
 * - 寫入中的不靠 pid 分辨（容器裡的 pid 常常固定）：mtime 早於這台 serve 起動的才算，孤兒只會來自上一個行程；
 * - **不用路徑刪根裡的東西**：`lstat` 之後目錄可能被換成連結，`unlink <dir>/x.tmp` 會穿過連結刪到根外。
 *   所以先 `rename` 整個目錄項到模型碰不到的暫放區（`rename` 不跟最後一段的連結），搬完再 `lstat` 一次才刪；搬不動（含 `EXDEV`）就留著。
 *   上層路徑的連結 `rename` 照樣會跟：`rename` 之前比對一次上層的實際位置，這只縮小窗口，沒有關掉。Node 沒有 `renameat`。
 *   `rename` 之後只看型別，擁有者、mtime、內容都不再驗；窗口裡的限制是（推論）：`rename` 的最後一段是候選的完整名字，
 *   根外要有名字逐字相同的目錄項才搬得動。出廠權限組下模型寫不到根外，也讀不到別條 thread 的根；讀得到的是 `/shared`，
 *   所以舊 thread 留在 `--workspace` 的暫存名字可能被用上（同一個檔案系統時）。`danger-full-access` 不在這個限制內。
 *
 * 暫放區在基底底下（{@link STAGING_QUARANTINE_DIR_NAME}）：跟私有根同一個檔案系統，名字不是 `thread-<雜湊>` 的形狀，
 * 不會被當成一條 thread 的根。崩潰留在裡面的，下次起動整個刪掉；一個 home 只有一台 serve（`serve.lock`），這時沒有別人在用它。
 *
 * 掃描排成一列、歸 Cordis 根的 effect 所有：卸載時停掉還沒做的，並等手上那一個收斂，同 `tool-result-stash-sweep.ts`。
 *
 * @module
 */

import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  opendir,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
} from 'node:fs/promises';
import { join } from 'node:path';

import type { Context } from '@nexus/cordis';

/** 暫放區在私有根基底底下的名字。 */
export const STAGING_QUARANTINE_DIR_NAME = '.staging-quarantine';

/** 一次掃描最多看幾個目錄項。 */
const MAX_ENTRIES_PER_SWEEP = 200_000;

/** `writeFileAtomic` 預設的暫存目錄名；第一格是目標的 basename。 */
const STAGING_DIR_RE =
  /^\.(.+)\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmpdir$/u;

/** 測試接縫。 */
export interface OrphanStagingInternals {
  /** 目錄項數上限；省略即 {@link MAX_ENTRIES_PER_SWEEP}。 */
  readonly maxEntries?: number;
  /** 判斷完、最後一次比對位置之前。測試用它在這個空檔換掉目錄項或上一層。 */
  readonly beforeMove?: (path: string) => void | Promise<void>;
}

/** {@link launchOrphanStagingSweeper} 的參數。 */
export interface OrphanStagingSweeperOptions {
  /** 私有根基底（`thread-roots.ts` 的 `resolveThreadRootsBase`）。 */
  readonly base: string;
  /** 這台 serve 的起動時間；mtime 不早於它的一律不算孤兒。 */
  readonly startedAtMs: number;
  readonly warn: (message: string) => void;
  readonly internals?: OrphanStagingInternals;
}

/** 一台 serve 一份。 */
export interface OrphanStagingSweeper {
  /** 排一次掃描，不等它。同一個根在一個行程裡只掃一次（分叉的 thread 共用來源的根）。 */
  sweep(root: string, threadId: string): void;
  /** 排進去的掃描都收斂時完成。 */
  settled(): Promise<void>;
}

interface SweepRun {
  readonly quarantine: string;
  readonly startedAtMs: number;
  readonly internals: OrphanStagingInternals;
  readonly stopped: () => boolean;
}

/** 內容是不是只有 `writeFileAtomic` 會留下的東西：空的，或恰好一個 `<basename>.tmp` 一般檔。 */
async function holdsOnlyStagingFile(path: string, targetName: string): Promise<boolean> {
  const names = await readdir(path);
  if (names.length === 0) return true;
  if (names.length !== 1 || names[0] !== `${targetName}.tmp`) return false;
  return (await lstat(join(path, names[0]))).isFile();
}

/**
 * 符合孤兒的條件就搬進暫放區再刪。`parent` 是根底下這一層，`canonicalParent` 是這一層該有的實際位置，對不上就不動。
 * 搬完模型碰不到它；目錄項可能已被換成連結，所以刪之前再看一次型別。
 */
async function reapIfOrphan(
  parent: string,
  canonicalParent: string,
  name: string,
  targetName: string,
  run: SweepRun,
): Promise<void> {
  const path = join(parent, name);
  const stats = await lstat(path);
  if (!stats.isDirectory()) return;
  if (stats.uid !== process.geteuid?.()) return;
  if (stats.mtimeMs >= run.startedAtMs) return;
  if (!(await holdsOnlyStagingFile(path, targetName))) return;
  await run.internals.beforeMove?.(path);
  await mkdir(run.quarantine, { recursive: true, mode: 0o700 });
  await chmod(run.quarantine, 0o700);
  if ((await realpath(parent)) !== canonicalParent) return;
  const moved = join(run.quarantine, randomUUID());
  await rename(path, moved);
  if ((await lstat(moved)).isDirectory()) await rm(moved, { recursive: true, force: true });
  else await unlink(moved);
}

/**
 * 走過一個根，最多看 {@link MAX_ENTRIES_PER_SWEEP} 個目錄項。目錄項是連結就不往下走；走到一半被換成連結時可能讀到根外，
 * {@link reapIfOrphan} 的位置比對只縮小這個窗口。讀不了的目錄跳過，清不掉的留著。
 *
 * @returns 有沒有撞到上限，以及第一個清不掉的錯誤碼。
 */
async function sweepRoot(
  root: string,
  run: SweepRun,
): Promise<{ readonly truncated: boolean; readonly failure: string | undefined }> {
  const maxEntries = run.internals.maxEntries ?? MAX_ENTRIES_PER_SWEEP;
  const canonicalRoot = await realpath(root);
  const pending = [''];
  let seen = 0;
  let failure: string | undefined;
  while (pending.length > 0 && !run.stopped()) {
    const relative = pending.pop() as string;
    const directory = join(root, relative);
    const entries = await opendir(directory).catch(() => undefined);
    if (entries === undefined) continue;
    try {
      for await (const entry of entries) {
        seen += 1;
        if (seen > maxEntries) return { truncated: true, failure };
        if (!entry.isDirectory()) continue;
        const staging = STAGING_DIR_RE.exec(entry.name);
        if (staging === null) {
          pending.push(join(relative, entry.name));
          continue;
        }
        const targetName = staging[1] as string;
        await reapIfOrphan(
          directory,
          join(canonicalRoot, relative),
          entry.name,
          targetName,
          run,
        ).catch((error: unknown) => {
          const code = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN';
          // 目錄項剛好消失就沒有東西要清。
          if (code !== 'ENOENT') failure ??= code;
        });
      }
    } catch {
      // 讀到一半失敗（例如目錄被刪掉）：這一層到此為止，其他層照走。
    }
  }
  return { truncated: false, failure };
}

/**
 * 在 `ctx` 上放出暫放區的起動清理，回傳續接時用的掃描器。
 *
 * @param ctx - 擁有這些掃描的 context（serve 的 Cordis 根）。
 * @param options - 見 {@link OrphanStagingSweeperOptions}。
 */
export function launchOrphanStagingSweeper(
  ctx: Context,
  options: OrphanStagingSweeperOptions,
): OrphanStagingSweeper {
  const quarantine = join(options.base, STAGING_QUARANTINE_DIR_NAME);
  const swept = new Set<string>();
  let stopped = false;
  let queue: Promise<void> = rm(quarantine, { recursive: true, force: true }).catch(
    (error: unknown) => {
      options.warn(`[私有根] 清暫放區失敗：${(error as NodeJS.ErrnoException).code ?? 'UNKNOWN'}`);
    },
  );
  ctx.effect(function* () {
    yield async () => {
      stopped = true;
      await queue;
    };
  }, 'orphan staging sweep');

  const sweepOne = async (root: string, threadId: string): Promise<void> => {
    try {
      const { truncated, failure } = await sweepRoot(root, {
        quarantine,
        startedAtMs: options.startedAtMs,
        internals: options.internals ?? {},
        stopped: () => stopped,
      });
      if (truncated) options.warn(`[私有根] thread ${threadId} 的暫存清掃撞到目錄項上限，沒掃完`);
      if (failure !== undefined)
        options.warn(`[私有根] thread ${threadId} 有崩潰留下的暫存清不掉：${failure}`);
    } catch (error) {
      options.warn(
        `[私有根] thread ${threadId} 的暫存清掃失敗：${(error as NodeJS.ErrnoException).code ?? 'UNKNOWN'}`,
      );
    }
  };

  return {
    sweep(root, threadId) {
      if (stopped || swept.has(root)) return;
      swept.add(root);
      queue = queue.then(() => sweepOne(root, threadId));
    },
    settled: () => queue,
  };
}

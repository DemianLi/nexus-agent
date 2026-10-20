/**
 * 模型讀附件的路由：**只露出這條 thread 的日誌引用過的檔案**（[#1773](https://github.com/DemianLi/nexus-agent/issues/1773)，#1675 Q3 (a)）。
 *
 * ## 為什麼要這一層
 *
 * 附件儲存是整台 serve 一份、內容定址（照 dsh，`attachment-store.ts` 檔頭）。以前模型讀附件的路由根是整個 `files` 目錄，
 * thread B 的 `ls /attachments` 列得出 thread A 上傳的檔，照路徑 `read_file` 也讀得到。一台主機多人共用、所有 web 使用者在
 * 同一個 OS 帳號底下，`0700` 分不開人（`.docs/seven-layer-inventory-2026-10-18.md:64`）。wire 這一層早就按 thread 分開了
 * （收據只在收下它的 thread 有效；網頁讀圖的授權是「這條 thread 的日誌引用過它」，`attachment-reference.ts`）；這個檔把模型
 * 那一條路由收到同一個判準。**儲存不動**，收窄的只有這條路由。
 *
 * ## 怎麼判
 *
 * - **呼叫當下才判**（{@link AttachmentScope.events}）：路由在組裝當下建好，比會話日誌接上還早，所以建路由時算不出引用集；
 *   每次 `read`／`ls`／`grep`／`glob`／`downloadFiles` 才讀這條 thread 的 root 日誌現在的樣子。第二輪才附上的檔，第二輪裡就讀得到。
 * - **判準是 {@link referencedFilePaths}**：日誌引用過的每一份檔案參照，換成它在路由底下的相對路徑
 *   （`/<前兩碼>/<hex>/<檔名>`）。`attachmentId` 與檔名都要對上，不是只看雜湊。
 * - **日誌還沒接上、或被解綁了：什麼都不露出**（fail closed）。
 * - **子代理用的是 root 的這一份 backend**（`sandbox-mode.ts` 的前景子代理，背景子代理同一個組裝），所以讀 root 日誌：
 *   子代理讀得到 root 引用過的附件，讀不到別條 thread 的。
 *
 * ## 沒引用過的路徑，回覆跟「不存在」一模一樣
 *
 * 不另外區分「存在但你不能看」與「不存在」（照讀圖 `attachment_not_found` 不細分的做法）：`read`、`readRaw`、`downloadFiles`
 * 的錯誤字句與不存在的檔逐字相同（測試把檔刪掉前後各讀一次對照），`ls`、`grep`、`glob` 的結果裡只剩引用過的條目。
 *
 * **不算外漏的情形**：B 自己上傳了位元組完全相同的檔，B 讀得到——內容定址的結果。檔名別名各自一條，B 引用的是 B 的那一條。
 *
 * ## 偏離（理由 2，登記在 `attachment-store.ts` 檔頭偏離 3）
 *
 * dsh 是單人桌面，模型讀的是主機路徑，沒有路由；nexus 一台主機多人共用，0700 分不開人，所以路由多一道「日誌引用過」的判準，
 * 跟網頁讀圖同一條（照 dsh `session.attachment`）。
 *
 * @module
 */

import { relative, sep } from 'node:path';

import { applyGrepMaxCount } from 'deepagents';
import type {
  FileInfo,
  GlobResult,
  GrepResult,
  LsResult,
  ReadRawResult,
  ReadResult,
} from 'deepagents';

import type { SessionEvent } from '@nexus/core';

import { referencedFilePaths } from './attachment-reference.js';
import { ContainedFilesystemBackend } from './contained-backend.js';

/** 路由問「這條 thread 的 root 日誌現在長什麼樣」的口。 */
export interface AttachmentScope {
  /** root 日誌現在的事件；還沒接上或已解綁是 `undefined`（路由什麼都不露出）。**每次呼叫都重讀，不要快取。** */
  events(): readonly SessionEvent[] | undefined;
}

/** 組裝時先建好、接上日誌時才綁的 {@link AttachmentScope}。 */
export interface BindableAttachmentScope extends AttachmentScope {
  /**
   * 綁上 root 日誌。後綁的取代先綁的；回傳的解綁函式只在它還是現在這一個時才清（舊的晚解綁不會清掉新的）。
   *
   * @param source - 有 `events` 的東西（`SessionRegistry.root`）；每次問才讀 `events`。
   */
  bind(source: { readonly events: readonly SessionEvent[] }): () => void;
}

/** 建一個還沒綁日誌的 scope：綁之前路由什麼都不露出。 */
export function createAttachmentScope(): BindableAttachmentScope {
  let current: { readonly events: readonly SessionEvent[] } | undefined;
  return {
    events: () => current?.events,
    bind(source) {
      current = source;
      return () => {
        if (current === source) current = undefined;
      };
    },
  };
}

/** 固定一串事件的 scope（測試與只有一份靜態日誌的呼叫端用）。 */
export function scopeOfEvents(events: readonly SessionEvent[]): AttachmentScope {
  return { events: () => events };
}

/** 路由根底下的虛擬路徑去掉結尾斜線（`ls` 的目錄條目是 `/ab/`）。 */
function trimmed(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

/** 目前可見的集合：檔案路徑，與它們的每一層祖先目錄（含根 `/`）。 */
interface Visible {
  readonly files: ReadonlySet<string>;
  readonly dirs: ReadonlySet<string>;
}

function visibleOf(events: readonly SessionEvent[] | undefined): Visible {
  const files = events === undefined ? new Set<string>() : referencedFilePaths(events);
  const dirs = new Set<string>(['/']);
  for (const file of files) {
    const [, first, second] = file.split('/');
    dirs.add(`/${first}`);
    dirs.add(`/${first}/${second}`);
  }
  return { files, dirs };
}

/**
 * 唯讀、按 thread 收窄的附件路由。根是附件儲存的 `files` 目錄；能看到的只有 {@link AttachmentScope} 說這條 thread 引用過的檔案。
 */
export class ThreadScopedAttachmentBackend extends ContainedFilesystemBackend {
  readonly #scope: AttachmentScope;

  constructor(options: { readonly rootDir: string; readonly scope: AttachmentScope }) {
    super({ rootDir: options.rootDir, mode: 'read-only' });
    this.#scope = options.scope;
  }

  /** 這一刻能看到什麼：**每次呼叫重算一次**，一次呼叫裡前後一致。 */
  #visible(): Visible {
    return visibleOf(this.#scope.events());
  }

  /**
   * 虛擬路徑換成路由根底下的正規形（`/aa/hex/name`，根是 `/`）。路徑跑出根、含 `..`／`~` 時回 `undefined`，
   * 呼叫端交給基座處理（它不碰檔案系統就回自己的錯）。
   */
  #normalize(virtualPath: string): string | undefined {
    try {
      const rel = relative(this.cwd, this.resolveVirtual(virtualPath || '.'));
      return rel === '' ? '/' : `/${rel.split(sep).join('/')}`;
    } catch {
      return undefined;
    }
  }

  /** 這個路徑是不是一份看得到的檔案。 */
  #isVisibleFile(visible: Visible, virtualPath: string): boolean {
    const normal = this.#normalize(virtualPath);
    return normal !== undefined && visible.files.has(normal);
  }

  /** 基座對「不存在的檔」讀檔時的錯誤（`stat` 的 ENOENT 原句），沒引用過的檔回這一句。 */
  #notFoundMessage(virtualPath: string): string {
    return `ENOENT: no such file or directory, stat '${this.resolveVirtual(virtualPath)}'`;
  }

  override async read(filePath: string, offset?: number, limit?: number): Promise<ReadResult> {
    const visible = this.#visible();
    const normal = this.#normalize(filePath);
    // 跑出根的路徑交給基座（它不碰檔案系統就拒絕，回的是路徑錯誤，不洩漏任何東西）；看得到的檔與看得到的目錄（基座回「不是檔案」）也交給基座。
    if (normal === undefined || visible.files.has(normal) || visible.dirs.has(normal)) {
      return super.read(filePath, offset, limit);
    }
    return { error: `Error reading file '${filePath}': ${this.#notFoundMessage(filePath)}` };
  }

  override async readRaw(filePath: string): Promise<ReadRawResult> {
    const visible = this.#visible();
    const normal = this.#normalize(filePath);
    if (normal === undefined || visible.files.has(normal) || visible.dirs.has(normal)) {
      return super.readRaw(filePath);
    }
    // 基座的 `readRaw` 對不存在的檔是拋 `stat` 的 ENOENT，不是回錯誤結果。
    throw Object.assign(new Error(this.#notFoundMessage(filePath)), { code: 'ENOENT' });
  }

  override async downloadFiles(paths: string[]) {
    const visible = this.#visible();
    const allowed = paths.filter((path) => this.#isVisibleFile(visible, path));
    const downloaded = allowed.length === 0 ? [] : await super.downloadFiles(allowed);
    const byPath = new Map(downloaded.map((entry) => [entry.path, entry]));
    return paths.map(
      (path) =>
        byPath.get(path) ?? {
          path,
          content: null,
          error: 'file_not_found' as const,
        },
    );
  }

  override async ls(path: string): Promise<LsResult> {
    const visible = this.#visible();
    const listed = await super.ls(path);
    if (listed.files === undefined) return listed;
    return { ...listed, files: listed.files.filter((entry) => this.#listable(visible, entry)) };
  }

  override async glob(pattern: string, path?: string): Promise<GlobResult> {
    const visible = this.#visible();
    const found = await super.glob(pattern, path);
    if (found.files === undefined) return found;
    return { ...found, files: found.files.filter((entry) => this.#listable(visible, entry)) };
  }

  /** `ls`／`glob` 的條目看不看得到：檔案要在引用集裡，目錄要是引用集裡某個檔的祖先。 */
  #listable(visible: Visible, entry: FileInfo): boolean {
    const normal = this.#normalize(trimmed(entry.path));
    if (normal === undefined) return false;
    return entry.is_dir === true ? visible.dirs.has(normal) : visible.files.has(normal);
  }

  /**
   * 只在引用過的檔所在的目錄（`/<前兩碼>/<hex>`，同樣的位元組不同檔名各有一條別名，所以目錄裡可能多出沒被引用的別名）裡搜，
   * 結果再濾到引用過的檔。**不整個 `files` 目錄搜再濾**：別條 thread 的附件可能很大很多，輸出上限（`ripgrep-runner.ts`）會被
   * 它們吃掉，這條 thread 自己的檔反而搜不到。`--glob` 的錨點是 `cwd`（工作區根），不是搜尋起點，所以改搜子目錄不改 glob 的語意。
   */
  override async grep(
    pattern: string,
    dirPath?: string,
    glob?: string | null,
    maxCount?: number | null,
  ): Promise<GrepResult> {
    const visible = this.#visible();
    const base = this.#normalize(dirPath || '.');
    if (base === undefined) return super.grep(pattern, dirPath, glob, maxCount);
    // 搜尋起點本身是一個看得到的檔案：直接搜它。
    const targets = visible.files.has(base)
      ? [base]
      : [...visible.dirs].filter(
          (dir) =>
            dir.split('/').length === 3 &&
            (base === '/' || dir === base || dir.startsWith(`${base}/`)),
        );
    const matches: NonNullable<GrepResult['matches']> = [];
    for (const target of targets) {
      const part = await super.grep(pattern, target, glob, null);
      if (part.error !== undefined) return part;
      for (const match of part.matches ?? []) {
        if (visible.files.has(match.path)) matches.push(match);
      }
    }
    return applyGrepMaxCount({ result: { matches }, maxCount: maxCount ?? null });
  }
}

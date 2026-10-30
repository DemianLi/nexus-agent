/**
 * 過大的工具結果暫存到主機上的私有目錄（[#734](https://github.com/DemianLi/nexus-agent/issues/734)）。
 *
 * 基座在一則工具結果超過 80,000 字元時，把全文寫到 `/large_tool_results/<工具呼叫編號>.txt`，換成頭尾預覽加一句
 * 「用 `read_file` 自己去讀」（`agent-factory.ts` 的 {@link TOOL_RESULT_STASH_PREFIX}）。那個路徑今天由組裝點路由到
 * 這裡（{@link createToolResultStash}）：**主機上按會話分的私有目錄**，所以 CLI `--resume` 或 serve 重開之後，預覽指著的
 * 路徑還讀得到同一個檔。以前它在 graph state 的記憶體裡，重開就沒了。
 *
 * ## 照 dsh 的部分（`packages/spill/spill-local`，`477b4f4`）
 *
 * - 外溢全文存在宿主上，按會話分目錄 `session-<雜湊>`（`store.ts:78-81`）；目錄 0700、檔案 0600（`store.ts:110-115`）。
 * - 保留期預設 30 天、`0` 表示不清，**啟動時清一次**（`index.ts:66-69`）；刻意保留，讓續接或 fork 的會話還讀得到舊定位
 *   （`index.ts:38-48`），**以單一檔為準**：一個檔寫入滿保留期就過期，同一個會話還在寫新檔也一樣（`index.ts:40-42`）。
 *   別人改得動的根不清，判準沿用 `plugin-config.ts` 已照 dsh 抄的 `assertPrivateFile`（dsh `cleanup.ts:86` 的
 *   `hasProtectedAncestors`）；別人改得動的會話目錄也不進去（`cleanup.ts:322-326`）。
 * - 存不下時保留原結果，不把成功變成錯誤（`spill-policy/src/index.ts:127-129`）：寫不進主機目錄就退回記憶體
 *   （{@link StashRoute}），不讓 #170 的「存不下就連原文一起丟」復發。
 *
 * ## 偏離（依 AGENTS.md 登記：哪一條、為什麼、退到什麼）
 *
 * 1. **根目錄固定，不是「每個行程一個私有暫存目錄」。** dsh 沒設根目錄時用每行程一個的暫存目錄。基座的路徑是虛擬的
 *    （`/large_tool_results/…`），續接時推回的預覽照同一個虛擬路徑指過來，帶不出行程各自的絕對路徑；所以根要跨行程重開
 *    保持固定。預設放在 harness home 底下（`<home>/tool-results`），不放系統暫存區——那裡會被定期清掉，「續接讀得回」
 *    就保證不了多久。基礎建設表達不出來的是**路徑的形狀**：虛擬路徑不含行程資訊，所以退到「固定根＋按會話分目錄」。
 * 2. **檔名不隨機，由工具呼叫編號推出。** 基座把路徑寫死，續接時 `conversation-restore.ts` 也照同一條規則重算路徑，
 *    檔名換不掉。dsh 用 `open(path, 'wx', 0o600)` 開隨機檔名，重複會寫不進；這裡同一個編號會**覆寫**（基座的行為），
 *    因為編號重複代表同一則結果被重送。檔案權限仍是 0600。
 * 3. **會話目錄的鑰匙由呼叫端給**（CLI 是會話日誌的 run 目錄、serve 是專案目錄加 thread id）：兩者都是「續接時會回到
 *    同一個會話」的既有身分，這裡只取雜湊。沒給鑰匙的組裝（eval、spike、沒有會話日誌）維持今天的記憶體暫存。
 *    所以外溢存檔的請求**不帶 dsh `SaveTextSpill.owner`**（`spill/src/types.ts:61-72`）：分區在建實例時就由這把鑰匙定了，
 *    一個實例只服務一個會話，基座的 backend 路由又是組裝時固定的一條前綴，請求帶 owner 也沒有第二個去處（理由 1）。
 *
 * ## 分叉的子 thread
 *
 * 子 thread 的前綴裡的預覽指著來源會話目錄裡的檔（[#1580](https://github.com/DemianLi/nexus-agent/issues/1580)）。
 * 呼叫端給了 {@link ToolResultStashOptions.inherited} 時，名單內的名字讀取（含搜單一個檔）沿祖先的目錄找；寫入仍只進自己的目錄，
 * 上面「一個實例只服務一個會話」對寫入照舊成立。名單、祖先鏈與偏離見 `fork-stash.ts`。
 *
 * ## 模型也寫得進這個前綴
 *
 * 路由在圍欄外面，所以模型用 `write_file` 寫到 `/large_tool_results/…` 會落到這個會話的目錄。**不擋**：它只寫得進自己
 * 會話那個目錄（backend 的根就是它，圍堵仍在），寫的還是文字；擋它要另加一層判斷，而 dsh 的 spill 目錄同樣不擋模型
 * 讀取。二進位內容照 #642 拒讀（{@link HostStashBackend.read}）。
 *
 * @module
 */

import { createHash, randomBytes } from 'node:crypto';
import type { Stats } from 'node:fs';
import { chmod, lstat, mkdir, readdir, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  BackendProtocolV2,
  EditResult,
  FileDownloadResponse,
  FileUploadResponse,
  GlobResult,
  GrepResult,
  LsResult,
  ReadRawResult,
  ReadResult,
  WriteResult,
} from 'deepagents';
import { SPILL_RETRIEVAL_HINT } from '@nexus/core';
import type { SpillRef, SpillSaveRequest, SpillStore } from '@nexus/core';
import { TextOnlyStateBackend } from './binary-read.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import type { SandboxModeSource } from './contained-backend.js';
import { assertPrivateFile } from './plugin-config.js';
import type { PrivateFileRole } from './plugin-config.js';

/** 目錄權限：只有目前使用者進得去。 */
const DIR_MODE = 0o700;
/** 檔案權限：只有目前使用者讀寫得了。 */
const FILE_MODE = 0o600;

const STASH_ROOT_ROLE: PrivateFileRole = {
  subject: '工具結果暫存目錄',
  why: '別人換得掉這個目錄底下的檔，模型就會讀到被換過的內容。',
};

/**
 * 會話目錄的名字：`session-` 加鑰匙雜湊的前十六個十六進位字。照 dsh 的 `session-<雜湊>`（`store.ts:78-81`）；
 * 鑰匙本身（路徑、thread id）不進檔名，所以檔名不洩漏別的會話的資訊，也不會有奇怪字元。
 *
 * **偏離（理由 2）：取十六位，dsh 取十二位。** 既有部署的會話目錄已經是十六位；改成十二位的話，舊目錄續接時找不到、
 * 清掃時也認不出來（{@link STASH_SESSION_DIR_RE}）。所以維持十六位，清掃的比對式跟著用十六位。
 *
 * @param key - 呼叫端給的會話鑰匙。
 * @returns 目錄名。
 */
export function stashSessionDirName(key: string): string {
  return `session-${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
}

/**
 * {@link stashSessionDirName} 產生的名字，**整個名字精確比對**。照 dsh `cleanup.ts:17-23` 的 `SESSION_DIR_RE`：
 * 共用的根底下有一個無關的 `session-backup`、`session-notes`，清掃也不碰。位數照上面那條偏離用十六位。
 */
const STASH_SESSION_DIR_RE = /^session-[0-9a-f]{16}$/;

/** 這一次組裝的暫存去向。 */
export interface ToolResultStashOptions {
  /** 根目錄，絕對路徑。 */
  readonly rootDir: string;
  /** 會話鑰匙，見 {@link stashSessionDirName}。 */
  readonly session: string;
  /** 退回記憶體時講一聲；每個 backend 最多講一次。缺席就不講。 */
  readonly warn?: (message: string) => void;
  /** 起 `rg` 用哪個模式，見 `ContainedFilesystemBackendOptions.toolMode`。 */
  readonly toolMode?: SandboxModeSource;
  /**
   * 分叉的子 thread 從祖先繼承來的暫存檔（[#1580](https://github.com/DemianLi/nexus-agent/issues/1580)，`fork-stash.ts`）：
   * `names` 裡的檔名讀取時沿 `sessions`（祖先的會話鑰匙，近的在前）逐代找，取第一個有的。缺席就是不是分叉來的。
   */
  readonly inherited?: {
    readonly names: ReadonlySet<string>;
    readonly sessions: readonly string[];
  };
}

/**
 * 主機上這個會話的私有目錄。
 *
 * 繼承 {@link ContainedFilesystemBackend} 是為了直接拿它的圍堵與「拒讀二進位」（#642）：根就是會話目錄，模型沿著
 * 這個前綴走不出去。`mode` 固定 `workspace-write`——它跟使用者的工作區政策無關（`read-only` 也要能暫存，#170）。
 *
 * **只多做兩件事**：第一次寫入時把根與會話目錄建成 0700（並確認根的祖先沒有別人改得動的），寫完把檔案改成 0600。
 * 檔案先以行程的 umask 建出來，再收緊——但它住在 0700 的目錄裡，別人進不去，沒有窗口。
 */
export class HostStashBackend extends ContainedFilesystemBackend {
  readonly #rootDir: string;
  readonly #sessionDir: string;
  #prepared: Promise<void> | undefined;

  constructor(options: ToolResultStashOptions) {
    const sessionDir = join(options.rootDir, stashSessionDirName(options.session));
    super({
      rootDir: sessionDir,
      mode: 'workspace-write',
      ...(options.toolMode !== undefined && { toolMode: options.toolMode }),
    });
    this.#rootDir = options.rootDir;
    this.#sessionDir = sessionDir;
  }

  /** 會話目錄的絕對路徑（測試與說明用）。 */
  get sessionDir(): string {
    return this.#sessionDir;
  }

  /** 建目錄並確認權限；失敗會拋，而且**不快取失敗**（下一次寫入重試）。 */
  async #prepare(): Promise<void> {
    this.#prepared ??= (async () => {
      // **只收緊自己建的那一層。** 設定的根可能是一個早就存在、別的用途也在用的目錄（例如 `/var/tmp`），
      // 把它改成 0700 是替別人做決定；已存在的目錄只驗，不改（`assertPrivateFile`：群組或其他人可寫就拒）。
      // mkdir 的 mode 受 umask 影響，所以建出來的明著再收緊一次。
      const createdRoot = await mkdir(this.#rootDir, { recursive: true, mode: DIR_MODE });
      if (createdRoot !== undefined) await chmod(this.#rootDir, DIR_MODE);
      const createdSession = await mkdir(this.#sessionDir, { recursive: true, mode: DIR_MODE });
      if (createdSession !== undefined) await chmod(this.#sessionDir, DIR_MODE);
      assertPrivateFile(this.#sessionDir, STASH_ROOT_ROLE);
    })().catch((error: unknown) => {
      this.#prepared = undefined;
      throw error;
    });
    return this.#prepared;
  }

  /** 會話目錄是不是已經不在了（被清掃 `rmdir` 掉）。其餘的錯（權限之類）不算，交給原本的錯誤結果。 */
  async #sessionDirGone(): Promise<boolean> {
    try {
      await lstat(this.#sessionDir);
      return false;
    } catch (error: unknown) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT';
    }
  }

  /**
   * 寫進會話目錄。**目錄在寫入途中被清掃 `rmdir` 掉就重建再寫**，照 dsh `store.ts:112-124`（ENOENT 就再 `mkdir` 一次，
   * 直到寫進去或撞上別的錯）：清掃會把掃空的會話目錄刪掉，而它跟續接中的寫入可能同時發生。目錄消失時 `super.write`
   * 回的是錯誤結果不是 errno（可寫根不存在，或建暫存檔時 ENOENT），所以判準是「寫失敗之後目錄不在了」。
   */
  override async write(filePath: string, content: string): Promise<WriteResult> {
    let result: WriteResult;
    for (;;) {
      try {
        await this.#prepare();
      } catch (error: unknown) {
        return { error: `工具結果暫存目錄不可用：${(error as Error).message}` };
      }
      result = await super.write(filePath, content);
      if (result.error === undefined || !(await this.#sessionDirGone())) break;
      this.#prepared = undefined;
    }
    if (result.error !== undefined) return result;
    try {
      await chmod(join(this.#sessionDir, filePath.replace(/^\/+/u, '')), FILE_MODE);
    } catch (error: unknown) {
      return { error: `工具結果暫存檔權限設不了：${(error as Error).message}` };
    }
    return result;
  }
}

function failed(result: { readonly error?: string | undefined }): boolean {
  return result.error !== undefined;
}

/** 這個目錄底下有沒有這個一般檔；不在、看不了、不是一般檔（連結、目錄）都算沒有。 */
async function isFileIn(dir: string, name: string): Promise<boolean> {
  try {
    return (await lstat(join(dir, name))).isFile();
  } catch {
    return false;
  }
}

/**
 * 暫存那一格的路由目標：主機上的私有目錄，**寫不進去就退回記憶體**。
 *
 * 退回記憶體是 #170 的教訓：基座那次 `write()` 失敗時不保留原文，模型剛要到手的東西整個沒了。所以主機寫不進去
 * （磁碟滿、目錄不可寫、根的祖先別人改得動）時，這則結果改存在 graph state 的記憶體，預覽指的路徑照樣讀得回——
 * 只是續接之後就沒了，跟這個功能出現之前一樣。
 *
 * **讀取只在「這個路徑真的退回過記憶體」時才去記憶體找**，否則一律問主機：主機回的錯（例如二進位拒讀）不能被記憶體
 * 那邊的「找不到」蓋掉。退回過的路徑記在這個實例上，所以 {@link StashRoute} 一個會話一個。
 */
export class StashRoute implements BackendProtocolV2 {
  readonly #host: HostStashBackend;
  readonly #memory = new TextOnlyStateBackend();
  readonly #inMemory = new Set<string>();
  readonly #warn: ((message: string) => void) | undefined;
  #warned = false;
  readonly #inheritedNames: ReadonlySet<string>;
  /** 祖先的會話目錄，只讀：不呼叫 `write`，所以不會替祖先建目錄（{@link HostStashBackend} 只在寫入時建）。 */
  readonly #ancestors: readonly HostStashBackend[];

  constructor(options: ToolResultStashOptions) {
    this.#host = new HostStashBackend(options);
    this.#warn = options.warn;
    this.#inheritedNames = options.inherited?.names ?? new Set();
    this.#ancestors = (options.inherited?.sessions ?? []).map(
      (session) => new HostStashBackend({ rootDir: options.rootDir, session }),
    );
  }

  /** 主機上的會話目錄（測試用）。 */
  get sessionDir(): string {
    return this.#host.sessionDir;
  }

  /**
   * 外溢層（[#719](https://github.com/DemianLi/nexus-agent/issues/719)）的存檔服務：**只寫主機，不退回記憶體**。
   *
   * 跟 {@link write} 相反，這裡寫不進去要拋：外溢層把拋錯當成「保留原結果」（dsh `spill-policy` 的 `keeping the inline
   * content`），8 萬字元以下的結果於是原樣交給模型。退回記憶體的話這裡會回報成功，模型拿到的是預覽加一個只在這個行程
   * 讀得回的路徑，而原文本來完全放得下。
   *
   * 檔名是隨機的（`<十二個十六進位字>-<建議檔名>`，照 dsh `store.ts:110`；工具結果是 `<工具名>.txt`、跨會話引用是
   * `session-reference-<N>.txt`），不會跟基座按工具呼叫編號取的名字撞在一起；定位是虛擬前綴下的路徑，
   * 讀取走路由，圍欄看不到的主機絕對路徑不會出現在模型面前。
   *
   * @param prefix - 這條路由在組裝點掛的前綴（不含結尾斜線）。
   * @returns 存檔服務。
   */
  spillStore(prefix: string): SpillStore {
    return {
      saveText: async (request: SpillSaveRequest): Promise<SpillRef> => {
        const name = `${randomBytes(6).toString('hex')}-${request.suggestedName.replace(/[^A-Za-z0-9._-]/gu, '_')}`;
        const result = await this.#host.write(`/${name}`, request.content);
        if (failed(result)) throw new Error(result.error);
        // 位元組數照 dsh `store.ts:130`：寫進去的內容的 UTF-8 長度。
        return {
          locator: `${prefix}/${name}`,
          bytes: Buffer.byteLength(request.content, 'utf8'),
          retrievalHint: SPILL_RETRIEVAL_HINT,
        };
      },
    };
  }

  #backendFor(filePath: string): BackendProtocolV2 {
    return this.#inMemory.has(filePath) ? this.#memory : this.#host;
  }

  /**
   * 讀取走哪一邊：自己退回過記憶體的先認；再來是自己的目錄裡有這個檔就讀自己的——子 thread 自己寫過的同名檔（基座按呼叫編號
   * 取名，跟來源撞名不是不可能；模型也寫得進這個前綴）不能被祖先那份蓋掉。自己沒有、名字又在繼承名單裡，才沿祖先逐代找
   * 第一個有這個檔的；都沒有就回自己的目錄（讀到原本的「找不到」）。只有讀走這一支，寫與改留在自己（`fork-stash.ts` 的偏離）。
   */
  async #readerFor(filePath: string): Promise<BackendProtocolV2> {
    if (this.#inMemory.has(filePath)) return this.#memory;
    const name = filePath.replace(/^\/+/u, '');
    if (!this.#inheritedNames.has(name) || (await isFileIn(this.sessionDir, name))) {
      return this.#host;
    }
    for (const ancestor of this.#ancestors) {
      if (await isFileIn(ancestor.sessionDir, name)) return ancestor;
    }
    return this.#host;
  }

  async write(filePath: string, content: string): Promise<WriteResult> {
    const result = await this.#host.write(filePath, content);
    if (!failed(result)) return result;
    if (!this.#warned) {
      this.#warned = true;
      this.#warn?.(
        `[暫存] 工具結果寫不進 ${this.sessionDir}，退回記憶體（續接之後讀不回）：${result.error}`,
      );
    }
    const fallback = await this.#memory.write(filePath, content);
    if (!failed(fallback)) this.#inMemory.add(filePath);
    return fallback;
  }

  async read(filePath: string, offset?: number, limit?: number): Promise<ReadResult> {
    return (await this.#readerFor(filePath)).read(filePath, offset, limit);
  }

  async readRaw(filePath: string): Promise<ReadRawResult> {
    return (await this.#readerFor(filePath)).readRaw(filePath);
  }

  edit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll?: boolean,
  ): Promise<EditResult> | EditResult {
    return this.#backendFor(filePath).edit(filePath, oldString, newString, replaceAll);
  }

  ls(path: string): Promise<LsResult> | LsResult {
    return this.#host.ls(path);
  }

  /**
   * 搜尋走自己的目錄；**只有搜一個繼承名單裡的檔**時，跟讀同一套先後（{@link #readerFor}）：取回提示叫模型「grep 這個路徑」
   * （`SPILL_RETRIEVAL_HINT`），子 thread 照著搜繼承來的定位，不能回一個空的「沒有命中」。
   */
  async grep(
    pattern: string,
    path?: string | null,
    glob?: string | null,
    maxCount?: number | null,
  ): Promise<GrepResult> {
    const backend =
      path != null && this.#inheritedNames.has(path.replace(/^\/+/u, ''))
        ? await this.#readerFor(path)
        : this.#host;
    return backend.grep(pattern, path ?? undefined, glob, maxCount);
  }

  glob(pattern: string, path?: string): Promise<GlobResult> | GlobResult {
    return this.#host.glob(pattern, path);
  }

  uploadFiles(files: Array<[string, Uint8Array]>): Promise<FileUploadResponse[]> {
    return this.#host.uploadFiles(files);
  }

  downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    return this.#host.downloadFiles(paths);
  }
}

/**
 * 組裝點用的暫存路由目標；同一個實例也給外溢層當存檔服務（{@link StashRoute.spillStore}）。
 *
 * @param options - 根目錄與會話鑰匙。
 * @returns 一個會話一個的路由目標。
 */
export function createToolResultStash(options: ToolResultStashOptions): StashRoute {
  return new StashRoute(options);
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

/** 講一聲，但收警告的那一方拋了也不讓清掃失敗（dsh `cleanup.ts:36-44` 的 `warnSafely`）。 */
function warnSafely(warn: ((message: string) => void) | undefined, message: string): void {
  try {
    warn?.(message);
  } catch {
    // 警告只是旁觀的回呼；清掃本身照樣盡力做完。
  }
}

/**
 * 別的本機使用者換不掉這個目錄底下的東西：是真的目錄、屬於目前使用者、群組與其他人不可寫。照 dsh `cleanup.ts:47-55` 的
 * `isTrustedDirectory`，判準同 {@link assertPrivateFile} 的前兩條；用剛 `lstat` 到的那一份判，不再走一次路徑。
 */
function isTrustedDirectory(stats: Stats): boolean {
  if (!stats.isDirectory()) return false;
  /* v8 ignore next -- Windows 沒有 geteuid，POSIX 的測試走下面那條。 */
  if (process.geteuid === undefined) return true;
  return stats.uid === process.geteuid() && (stats.mode & 0o022) === 0;
}

/**
 * 掃一個會話目錄：刪掉過期的一般檔，其餘不動，照 dsh `cleanup.ts:225-261` 的 `sweepSessionDir`。裡面的符號連結、子目錄、
 * 特殊檔都不刪也不跟（`lstat` 不跟連結，所以連結改不了年齡判斷，也刪不到別處）。每一項的失敗各自收住，不擋同目錄其餘的檔。
 *
 * @returns 刪掉的檔數，與掃完之後目錄是不是空的（空的才交給呼叫端 `rmdir`）。
 */
async function sweepSessionDir(
  dir: string,
  cutoff: number,
  warn: ((message: string) => void) | undefined,
): Promise<{ readonly removed: number; readonly empty: boolean }> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error: unknown) {
    /* v8 ignore next 3 -- 呼叫端剛 lstat 確認是目錄；讀不了只剩競爭或權限，造不穩。 */
    warnSafely(warn, `[暫存] 讀不了 ${dir}：${(error as Error).message}`);
    return { removed: 0, empty: false };
  }
  let remaining = names.length;
  let removed = 0;
  for (const name of names) {
    const path = join(dir, name);
    let info: Stats;
    try {
      info = await lstat(path);
    } catch (error: unknown) {
      /* v8 ignore start -- readdir 剛列出的項目 lstat 不到，只有競爭或權限，造不穩。 */
      if (isErrno(error, 'ENOENT')) remaining -= 1;
      else warnSafely(warn, `[暫存] 看不了 ${path}：${(error as Error).message}`);
      continue;
      /* v8 ignore stop */
    }
    // 只有一般檔會過期；連結與其他特殊項目略過（不跟），清掃就不會被導到別處，也不會刪掉一個連結。
    if (!info.isFile() || info.mtimeMs >= cutoff) continue;
    try {
      await unlink(path);
      removed += 1;
      remaining -= 1;
    } catch (error: unknown) {
      // 同時有別的清掃先刪了：目的已經達成，不算失敗（dsh `cleanup.ts:196-208`）。
      if (isErrno(error, 'ENOENT')) remaining -= 1;
      else warnSafely(warn, `[暫存] 刪不掉 ${path}：${(error as Error).message}`);
    }
  }
  return { removed, empty: remaining === 0 };
}

/**
 * 清掉超過保留期的暫存檔，照 dsh `spill-local` 的 `cleanup.ts`（`sweepSpillRoots`）。兩個入口啟動時在背景叫它一次、
 * 卸載根時等它收斂（`tool-result-stash-sweep.ts`，#1553 N0952）：
 *
 * - `cleanupPeriodDays` 為 `0` 表示不清。
 * - **別人改得動的根不清**（dsh `index.ts:43-44`）：根或它的祖先群組／其他人可寫，就一個檔都不碰——那個目錄裡的東西
 *   可能是別人放的，刪它等於替別人選了要刪什麼。
 * - 只碰名字是 `session-<十六位雜湊>` 的直接子目錄（{@link STASH_SESSION_DIR_RE}）；其他名字（使用者放的東西，
 *   包括 `session-notes` 這種剛好以 `session-` 開頭的）不動。
 * - 那一項先 `lstat`，必須是真的目錄、屬於目前使用者、群組與其他人不可寫，否則講一聲跳過（dsh `cleanup.ts:309-326`）：
 *   名字對的**符號連結**不跟，否則會刪到連結指向的別處；別人改得動的會話目錄裡的檔可能是別人放的。
 * - **以單一檔為準**：會話目錄裡只刪修改時間早於保留期的一般檔，不往子目錄走；一個會話還在寫新檔，它的舊檔照樣過期
 *   （dsh `index.ts:40-42`）。掃完目錄是空的就 `rmdir`；同時有寫入（`ENOTEMPTY`）或已經不在（`ENOENT`）都不算錯，
 *   寫入那一側會重建目錄（{@link HostStashBackend.write}）。
 * - 每一項獨立：一個刪不掉（權限、競爭）只記一筆，不擋其餘。根不存在就是沒東西可清。
 *
 * @param rootDir - 根目錄。
 * @param cleanupPeriodDays - 保留天數。
 * @param options - `now` 給測試控制時間；`warn` 收無法清掉的訊息。
 * @returns 刪掉的檔數。
 */
export async function cleanupToolResultStash(
  rootDir: string,
  cleanupPeriodDays: number,
  options: { readonly now?: number; readonly warn?: (message: string) => void } = {},
): Promise<number> {
  if (cleanupPeriodDays === 0) return 0;
  const { warn } = options;
  let names: string[];
  try {
    names = await readdir(rootDir);
  } catch (error: unknown) {
    if (isErrno(error, 'ENOENT')) return 0;
    warnSafely(warn, `[暫存] 讀不了 ${rootDir}，這次不清：${(error as Error).message}`);
    return 0;
  }
  try {
    assertPrivateFile(rootDir, STASH_ROOT_ROLE);
  } catch (error: unknown) {
    warnSafely(warn, `[暫存] ${(error as Error).message}這次不清。`);
    return 0;
  }
  const cutoff = (options.now ?? Date.now()) - cleanupPeriodDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const name of names) {
    if (!STASH_SESSION_DIR_RE.test(name)) continue;
    const dir = join(rootDir, name);
    let info: Stats;
    try {
      // lstat，不是 stat：名字對的符號連結在這裡就被擋下，不跟到它指向的目錄。
      info = await lstat(dir);
    } catch (error: unknown) {
      /* v8 ignore next -- readdir 剛列出的項目 lstat 不到，只有競爭或權限，造不穩。 */
      if (!isErrno(error, 'ENOENT'))
        warnSafely(warn, `[暫存] 看不了 ${dir}：${(error as Error).message}`);
      continue;
    }
    if (!isTrustedDirectory(info)) {
      warnSafely(
        warn,
        `[暫存] 略過 ${dir}：要是目前使用者擁有、群組與其他人不可寫的目錄（符號連結不跟）。`,
      );
      continue;
    }
    const swept = await sweepSessionDir(dir, cutoff, warn);
    removed += swept.removed;
    if (!swept.empty) continue;
    try {
      await rmdir(dir);
    } catch (error: unknown) {
      /* v8 ignore next 3 -- 只對剛掃空的目錄 rmdir；失敗只剩同時有寫入（ENOTEMPTY）或競爭，造不穩。 */
      if (!isErrno(error, 'ENOENT') && !isErrno(error, 'ENOTEMPTY')) {
        warnSafely(warn, `[暫存] 收不掉空的 ${dir}：${(error as Error).message}`);
      }
    }
  }
  return removed;
}

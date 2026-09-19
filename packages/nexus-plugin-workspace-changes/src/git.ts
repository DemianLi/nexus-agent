/**
 * git 工作樹快照、樹與樹的比較、忽略判斷。照 dsh `workspace-changes/src/git.ts`（`ddefc45`）逐條移植。
 *
 * ## 與 dsh 的偏離：git 用 `node:child_process` 跑
 *
 * dsh 經由 `subprocess` 能力（`@deepseek-ai/dsh-subprocess`）跑 git；我們沒有這個服務，這是 repo 裡第一個
 * 自己 spawn 的地方，所以直接用 `node:child_process` 的 `spawn`（參數陣列，不經 shell）。**退掉的是載體，
 * 隨載體來的規則明著抄過來**：
 *
 * - **環境**：dsh 的 `scrubbedParentEnv()`（`packages/subprocess/subprocess/src/index.ts:47-78`）拿掉名字像
 *   憑證的變數（`/KEY|PASSWORD|SECRET|TOKEN/i`）與自己的 `DSH_*`；我們拿掉同一批與自己的 `NEXUS_*`，見
 *   {@link scrubbedParentEnv}。dsh 另外把 proxy 變數還原成使用者設的樣子，給子行程裡的 Node 用；git 快照不碰
 *   網路，那一段不抄。
 * - **逾時與輸出上限**：能力層提供的 `AbortSignal`、`graceMs`、stdout 位元組上限（保留尾端），在
 *   {@link GitRunner.run} 裡自己做。
 * - **找執行檔**：能力層的 `resolveExecutable` 在淨化過的 `PATH` 裡找，見 {@link resolveGitExecutable}。
 *
 * @module
 */

import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, copyFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, relative, resolve } from 'node:path';

import { parseNumstat } from './numstat.js';
import type { NumstatEntry } from './numstat.js';
import { canonicalPath, isInside, toPosix } from './paths.js';

/** 開始收掉之後，git 子行程還有幾毫秒可以自己結束；固定的生命週期常數，同 dsh。 */
const TERMINATE_GRACE_MS = 2_000;
/** 留下來診斷用的 stderr 尾端。 */
const STDERR_TAIL_BYTES = 16 * 1024;

/**
 * 名字像憑證的環境變數不交給子行程，照抄 dsh 的 `SENSITIVE_ENV_PATTERN`。git 自己的
 * `GIT_CONFIG_KEY_<n>` 也中這一條，所以 {@link GitRunner} 另外設 `GIT_CONFIG_COUNT=0`，同 dsh。
 */
export const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i;
/** harness 自己的變數前綴；dsh 拿掉的是 `DSH_*`。 */
const HARNESS_ENV_PREFIX = 'NEXUS_';

/**
 * 父行程的環境，拿掉名字像憑證的與 harness 自己的變數，照 dsh 的 `scrubbedParentEnv()`。兩條都不分大小寫。
 * `PATH`、`HOME`、語系照留，git 才跑得起來。
 * @param source - 父行程的環境，省略是 `process.env`。
 * @returns 一份新的環境物件。
 */
export function scrubbedParentEnv(
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || SENSITIVE_ENV_PATTERN.test(key)) continue;
    if (key.toUpperCase().startsWith(HARNESS_ENV_PREFIX)) continue;
    env[key] = value;
  }
  return env;
}

/** 一次 git 指令落定的結果；非零的結束碼是結果，不是例外。 */
export interface GitRunResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** stdout 超過上限、丟掉了開頭。 */
  readonly truncated: boolean;
}

/** 一次指令的參數。 */
export interface GitRunOptions {
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: string;
  /** 這一次的 stdout 上限，蓋掉 runner 的 `outputMaxBytes`。 */
  readonly maxBytes?: number;
  readonly signal: AbortSignal;
}

/** 每一次 git 指令的界限。 */
export interface GitLimits {
  /** 幾毫秒之後收掉。 */
  readonly timeoutMs: number;
  /** stdout 留在記憶體裡的位元組上限。 */
  readonly outputMaxBytes: number;
}

/** 只留最後 `max` 個位元組的收集器，同 dsh 能力層的「超過上限就丟開頭」。 */
class TailBuffer {
  #chunks: Buffer[] = [];
  #bytes = 0;
  truncated = false;

  constructor(private readonly max: number) {}

  push(chunk: Buffer): void {
    this.#chunks.push(chunk);
    this.#bytes += chunk.length;
    while (this.#bytes > this.max) {
      const head = this.#chunks[0]!;
      const excess = this.#bytes - this.max;
      this.truncated = true;
      if (head.length <= excess) {
        this.#chunks.shift();
        this.#bytes -= head.length;
      } else {
        this.#chunks[0] = head.subarray(excess);
        this.#bytes -= excess;
      }
    }
  }

  text(): string {
    return Buffer.concat(this.#chunks).toString('utf8');
  }
}

/** 用淨化過的環境、逾時與有上限的輸出跑一個解析好的 git 執行檔。 */
export class GitRunner {
  constructor(
    private readonly executable: string,
    private readonly limits: GitLimits,
  ) {}

  /**
   * 跑 `git <args>` 到結束。
   * @param args - git 參數，不經 shell。
   * @param options - 工作目錄、額外環境、stdin 與取消。
   * @returns 結束碼與收到的輸出。
   * @throws 逾時、被中止，或 spawn 不起來。
   */
  async run(args: readonly string[], options: GitRunOptions): Promise<GitRunResult> {
    const timeout = AbortSignal.timeout(this.limits.timeoutMs);
    const signal = AbortSignal.any([options.signal, timeout]);
    const failure = (): Error =>
      new Error(
        `git ${args.join(' ')} ${timeout.aborted ? `timed out after ${this.limits.timeoutMs}ms` : 'was aborted'}`,
      );
    if (signal.aborted) throw failure();
    const stdout = new TailBuffer(options.maxBytes ?? this.limits.outputMaxBytes);
    const stderr = new TailBuffer(STDERR_TAIL_BYTES);
    const exitCode = await new Promise<number | null>((resolveExit, reject) => {
      const child = spawn(this.executable, args, {
        cwd: options.cwd,
        env: {
          ...scrubbedParentEnv(),
          // 淨化會拿掉 `GIT_CONFIG_KEY_<n>`，所以明著把環境裡的索引設定關掉，同 dsh。
          GIT_CONFIG_COUNT: '0',
          GIT_TERMINAL_PROMPT: '0',
          GIT_OPTIONAL_LOCKS: '0',
          LC_ALL: 'C',
          ...options.env,
        },
        stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let grace: NodeJS.Timeout | undefined;
      const terminate = (): void => {
        child.kill('SIGTERM');
        grace = setTimeout(() => child.kill('SIGKILL'), TERMINATE_GRACE_MS);
        grace.unref();
      };
      signal.addEventListener('abort', terminate, { once: true });
      child.stdout!.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr!.on('data', (chunk: Buffer) => stderr.push(chunk));
      if (options.stdin !== undefined) {
        // git 不讀完 stdin 就結束時寫入會 EPIPE；結果由結束碼決定。
        child.stdin!.on('error', () => undefined);
        child.stdin!.end(options.stdin);
      }
      child.once('error', (error) => {
        signal.removeEventListener('abort', terminate);
        clearTimeout(grace);
        reject(error);
      });
      child.once('close', (code) => {
        signal.removeEventListener('abort', terminate);
        clearTimeout(grace);
        resolveExit(code);
      });
    });
    if (signal.aborted) throw failure();
    return { exitCode, stdout: stdout.text(), stderr: stderr.text(), truncated: stdout.truncated };
  }
}

/**
 * 找 git 執行檔，一個 plugin 實例找一次。在淨化過的 `PATH` 裡找，同 dsh 能力層的 `resolveExecutable`。
 * **macOS 上的 `/usr/bin/git` 是開發者工具的樁程序**，沒裝工具時會跳安裝視窗而不是跑，所以 `xcode-select -p`
 * 不成功就當成沒有 git，同 dsh 的 `resolveGit`。
 * @param options - 測試用：`PATH`、平台、樁程序的探測。
 * @returns 執行檔路徑；沒有 git 時是 `null`。
 */
export async function resolveGitExecutable(
  options: {
    readonly path?: string | undefined;
    readonly platform?: NodeJS.Platform;
    readonly developerToolsSelected?: () => Promise<boolean>;
  } = {},
): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  const names = platform === 'win32' ? ['git.exe', 'git'] : ['git'];
  const directories = (options.path ?? scrubbedParentEnv()['PATH'] ?? '')
    .split(delimiter)
    .filter((directory) => directory !== '' && isAbsolute(directory));
  let executable: string | undefined;
  search: for (const directory of directories) {
    for (const name of names) {
      const candidate = join(directory, name);
      try {
        if (!(await stat(candidate)).isFile()) continue;
        await access(candidate, constants.X_OK);
        executable = candidate;
        break search;
      } catch {
        // 不在、或不能執行：換下一個。
      }
    }
  }
  if (executable === undefined) return null;
  if (platform !== 'darwin' || executable !== '/usr/bin/git') return executable;
  const selected = await (options.developerToolsSelected ?? developerToolsSelected)();
  return selected ? executable : null;
}

/** `xcode-select -p` 成功：開發者工具選好了，`/usr/bin/git` 不是樁。 */
function developerToolsSelected(): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const probe = spawn('/usr/bin/xcode-select', ['-p'], {
      cwd: homedir(),
      env: scrubbedParentEnv(),
      stdio: 'ignore',
      timeout: 10_000,
    });
    probe.once('error', () => resolveProbe(false));
    probe.once('close', (code) => resolveProbe(code === 0));
  });
}

/**
 * 失敗的指令帶著 stderr 拋出來。
 * @param result - 落定的結果。
 * @param what - 錯誤訊息裡的指令描述。
 * @returns 結束碼是零時原樣回傳。
 */
function ok(result: GitRunResult, what: string): GitRunResult {
  if (result.exitCode !== 0) throw new Error(`${what} failed: ${result.stderr.trim()}`);
  return result;
}

/** 包住工作區的那個 repo，與快照寫進去的私有目錄。 */
export interface GitWorkspace {
  /** repo 的頂層目錄，每一條 diff 路徑都相對它。 */
  readonly root: string;
  /** 放 repo 的 index 的 git 目錄（絕對路徑）。 */
  readonly gitDir: string;
  /** 私有目錄：快照的物件庫與每次快照的暫用 index。 */
  readonly scratch: string;
  /** 把物件寫到私有庫、經由 repo 的庫讀物件的環境。 */
  readonly env: Readonly<Record<string, string>>;
  /** 快照要跳過的工作樹路徑：暫存根落在工作樹裡時的那個私有目錄。 */
  readonly excludes: readonly string[];
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
  );
}

/**
 * 找包住工作區的 repo，準備快照要寫的私有目錄。repo 自己的物件庫以唯讀 alternate 掛上，所以快照從那裡讀
 * 已提交的內容、一個物件都不寫進去。私有目錄落在工作樹裡時（暫存根在工作區底下），每次快照都排除它。
 * 不在任何 repo 裡回 `null`；其他 git 失敗照拋。
 * @param git - runner。
 * @param cwd - 標準化的工作區根。
 * @param scratch - 給私有目錄；只有找到 repo 時才叫。
 * @param signal - 取消。
 * @returns repo；不在任何 repo 裡時是 `null`。
 */
export async function locateGitWorkspace(
  git: GitRunner,
  cwd: string,
  scratch: () => Promise<string>,
  signal: AbortSignal,
): Promise<GitWorkspace | null> {
  const found = await git.run(
    ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-path', 'objects'],
    { cwd, signal },
  );
  if (found.exitCode === 128 && /not a git repository/i.test(found.stderr)) return null;
  const [root, gitDir, repositoryObjects] = ok(found, 'git rev-parse')
    .stdout.split('\n')
    .map((line) => resolve(cwd, line)) as [string, string, string];
  // git 報的是標準化的根；私有目錄用同一種寫法比。
  const directory = await canonicalPath(await scratch());
  const objects = join(directory, 'objects');
  await mkdir(objects, { recursive: true });
  const excludes = isInside(root, directory) ? [toPosix(relative(root, directory))] : [];
  const env = {
    GIT_OBJECT_DIRECTORY: objects,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: repositoryObjects,
  };
  return { root, gitDir, scratch: directory, env, excludes };
}

/**
 * 把整個工作樹（含未追蹤與改過的檔，不含被忽略的）寫成一棵樹，經由一份以 repo 的 index 為種子的私有 index。
 * 新的 blob 與樹落在私有物件庫；repo 的 index、物件庫、工作樹、ref 都不動，合併到一半的衝突項目也照留。
 * @param git - runner。
 * @param workspace - repo。
 * @param signal - 取消。
 * @returns 樹的物件 id。
 */
export async function snapshotTree(
  git: GitRunner,
  workspace: GitWorkspace,
  signal: AbortSignal,
): Promise<string> {
  const scratch = await mkdtemp(join(workspace.scratch, 'index-'));
  try {
    const index = join(scratch, 'index');
    // 還沒有 index 的 repo（剛 `git init`）從空的開始。
    await copyFile(join(workspace.gitDir, 'index'), index).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
    });
    const env = { ...workspace.env, GIT_INDEX_FILE: index };
    // `--ignore-errors` 跳過讀不到的檔，以結束碼 1 回報；index 照樣是完整的。
    const pathspec =
      workspace.excludes.length === 0
        ? []
        : ['--', '.', ...workspace.excludes.map((path) => `:(exclude)${path}`)];
    const added = await git.run(['add', '--all', '--ignore-errors', ...pathspec], {
      cwd: workspace.root,
      env,
      signal,
    });
    if (added.exitCode !== 1) ok(added, `git add in ${workspace.root}`);
    const tree = await git.run(['write-tree'], { cwd: workspace.root, env, signal });
    return ok(tree, 'git write-tree').stdout.trim();
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** 一棵快照樹在某個路徑上的 blob。 */
export interface TreeBlob {
  readonly oid: string;
  /** 物件大小（位元組）。 */
  readonly size: number;
}

/**
 * 一棵快照樹在某個路徑上的 blob。
 * @param git - runner。
 * @param workspace - repo。
 * @param tree - 快照樹 id。
 * @param path - 相對 repo 根、斜線分隔的路徑。
 * @param signal - 取消。
 * @returns blob；那個路徑上沒有東西、或是 gitlink、樹時是 `null`。
 */
export async function treeBlob(
  git: GitRunner,
  workspace: GitWorkspace,
  tree: string,
  path: string,
  signal: AbortSignal,
): Promise<TreeBlob | null> {
  // 路徑是 pathspec；照字面比，檔名裡的 `*`、`?`、`[` 才不會選到別的項目。
  const result = ok(
    await git.run(['ls-tree', '-z', '-l', tree, '--', path], {
      cwd: workspace.root,
      env: { ...workspace.env, GIT_LITERAL_PATHSPECS: '1' },
      signal,
    }),
    'git ls-tree',
  );
  const entry = result.stdout.split('\0')[0]!;
  const match = /^\d+ (\S+) ([0-9a-f]+) +(\d+)\t/.exec(entry);
  if (match?.[1] !== 'blob') return null;
  return { oid: match[2]!, size: Number(match[3]) };
}

/**
 * 一個 {@link treeBlob} 量過大小、在上限內的 blob 的文字。
 * @param git - runner。
 * @param workspace - repo。
 * @param oid - blob id。
 * @param maxBytes - 呼叫端量大小時用的上限（含）。
 * @param signal - 取消。
 * @returns 以 UTF-8 解出的 blob。
 */
export async function blobText(
  git: GitRunner,
  workspace: GitWorkspace,
  oid: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const result = ok(
    await git.run(['cat-file', 'blob', oid], {
      cwd: workspace.root,
      env: workspace.env,
      maxBytes,
      signal,
    }),
    'git cat-file',
  );
  // 呼叫端先用 treeBlob 量過；blob 不會變，所以這裡超不過。
  if (result.truncated) throw new Error(`blob ${oid} exceeds ${maxBytes} bytes`);
  return result.stdout;
}

/**
 * 兩棵快照樹之間逐檔的行數，偵測改名。
 * @param git - runner。
 * @param workspace - repo。
 * @param before - 輪開始的樹。
 * @param after - 輪結束的樹。
 * @param signal - 取消。
 * @returns 改過的檔，路徑相對 repo 根。
 * @throws git 失敗、或輸出超過上限。
 */
export async function diffTrees(
  git: GitRunner,
  workspace: GitWorkspace,
  before: string,
  after: string,
  signal: AbortSignal,
): Promise<NumstatEntry[]> {
  if (before === after) return [];
  const result = ok(
    await git.run(['diff-tree', '-r', '-M', '-z', '--numstat', before, after], {
      cwd: workspace.root,
      env: workspace.env,
      signal,
    }),
    'git diff-tree',
  );
  if (result.truncated) throw new Error('git diff-tree output exceeded the configured cap');
  return parseNumstat(result.stdout);
}

/**
 * index 記成 gitlink 的工作樹目錄：巢狀 repo 與 submodule。快照不會往裡走，`check-ignore` 也不肯判。
 * @param git - runner。
 * @param workspace - repo。
 * @param signal - 取消。
 * @returns 相對 repo 根、斜線分隔的 gitlink 路徑。
 */
export async function gitlinkPaths(
  git: GitRunner,
  workspace: GitWorkspace,
  signal: AbortSignal,
): Promise<Set<string>> {
  const result = ok(
    await git.run(['ls-files', '-z', '--stage'], {
      cwd: workspace.root,
      env: workspace.env,
      signal,
    }),
    'git ls-files',
  );
  const links = new Set<string>();
  for (const entry of result.stdout.split('\0')) {
    if (entry.startsWith('160000 ')) links.add(entry.slice(entry.indexOf('\t') + 1));
  }
  return links;
}

/**
 * 工作樹路徑裡被 repo 忽略的那些。已追蹤的檔永遠不會回報，所以一個符合忽略規則、但已追蹤的檔仍算快照蓋得到。
 * @param git - runner。
 * @param workspace - repo。
 * @param paths - 相對 repo 根、斜線分隔的路徑。
 * @param signal - 取消。
 * @returns `paths` 裡被忽略的那些。
 */
export async function ignoredPaths(
  git: GitRunner,
  workspace: GitWorkspace,
  paths: readonly string[],
  signal: AbortSignal,
): Promise<Set<string>> {
  if (paths.length === 0) return new Set();
  const result = await git.run(['check-ignore', '-z', '--stdin'], {
    cwd: workspace.root,
    env: workspace.env,
    stdin: `${paths.join('\0')}\0`,
    signal,
  });
  if (result.exitCode === 1) return new Set();
  return new Set(
    ok(result, 'git check-ignore')
      .stdout.split('\0')
      .filter((path) => path !== ''),
  );
}

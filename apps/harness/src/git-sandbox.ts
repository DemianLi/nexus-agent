/**
 * workspace-changes 的 git 怎麼起（[#1946](https://github.com/DemianLi/nexus-agent/issues/1946)）：插件定 {@link GitStarter}，這裡把它接到
 * 工具接縫。會話是 `danger-full-access` 時用全權（不上 Landlock，網路照擋），每次都讀當下的模式；其餘一律 `workspace-write`，寫根只有
 * 私有目錄。git 不是模型呼叫的工具，`read-only` 的會話也要拍快照。
 *
 * 讀根清單不列 serve 的 home，也不列包住 `$HOME` 的目錄，repo 落在 `$HOME` 底下時給的是 repo：
 *
 * - 系統執行期的目錄與檔（{@link GIT_SYSTEM_READABLE}）與 git 本身；
 * - 工作目錄、最近的 repo、它的 git 目錄、common 目錄與物件庫的 alternates。工作目錄包住 `$HOME` 時不給那一層，repo 根包住 `$HOME` 時整個不拍快照。這些路徑的內容在工作區裡時只開得了工作區內的讀權，見 {@link gitDirectories}；
 * - global 與 system 的設定檔、它們 include 的檔（含空的）、`core.excludesFile`、`core.attributesFile`。
 *
 * include 的檔讀不到時 git 整個結束（`fatal: unable to access`），不存在才跳過，所以 include 要照列；而 `core.excludesFile` 漏了不會報錯，
 * 被全域忽略的檔會悄悄進快照。這份清單在沙箱外問不到，也不能在這份清單的沙箱裡問，所以用全權模式跑固定的 argv，只問路徑類的鍵，值不進 log。
 * **只問 global 與 system**：repo 的 `.git/config` 是工作區內容，聽它的就等於讓 repo 自己開讀權。`includeIf "gitdir:"` 看工作目錄，
 * 所以答案按 HOME 加 repo 記，同一組只問一次，改了全域設定要重起。
 *
 * @module
 */

import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import type { SandboxMode } from '@nexus/core';
import type { GitOutcome, GitStartFailure, GitStarter } from '@nexus/plugin-workspace-changes';

import { reportSandbox, productToolLauncher } from './tool-launcher.js';
import type { ToolLauncher, ToolProcess, ToolResult } from './tool-process.js';

/** 涵蓋常見發行版放執行檔、載入器與函式庫的位置，加上執行期會讀的系統檔。主機上不存在的不給。 */
export const SYSTEM_READABLE = [
  '/usr',
  '/lib',
  '/lib64',
  '/bin',
  '/sbin',
  '/etc/ld.so.cache',
  '/dev/urandom',
  '/etc/passwd',
  '/etc/group',
  '/etc/nsswitch.conf',
] as const;

/** git 的讀根：系統的加上 system 設定檔。 */
const GIT_SYSTEM_READABLE = [...SYSTEM_READABLE, '/etc/gitconfig'] as const;

/** 問設定檔的期限（毫秒）。 */
const PROBE_TIMEOUT_MS = 10_000;

/** 只問路徑類的鍵：值不會是 token。 */
const PATH_KEYS = '^(include|includeif\\..*)\\.path$|^core\\.(excludesfile|attributesfile)$';

const isKind = (path: string, kind: 'isFile' | 'isDirectory'): Promise<boolean> =>
  stat(path).then(
    (found) => found[kind](),
    () => false,
  );

const readText = (path: string): Promise<string | undefined> =>
  readFile(path, 'utf8').catch(() => undefined);

/** 從工作目錄往上，最近的 `.git` 的那一層。 */
async function repoRootOf(cwd: string): Promise<string | undefined> {
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (await stat(join(dir, '.git')).catch(() => undefined)) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

const realOf = (path: string): Promise<string | undefined> => realpath(path).catch(() => undefined);

const within = (root: string, path: string): boolean => {
  const fromRoot = relative(root, path);
  return fromRoot !== '..' && !fromRoot.startsWith('../') && !isAbsolute(fromRoot);
};

/** `gitDir` 是不是這個 `.git` 的 linked worktree：`<common>/worktrees/<名字>/gitdir` 要指回來。工作區外的這個檔，工作區裡的東西改不到。 */
async function pointsBackTo(gitDir: string, dotGit: string): Promise<boolean> {
  if (basename(dirname(gitDir)) !== 'worktrees') return false;
  const back = (await readText(join(gitDir, 'gitdir')))?.trim();
  if (back === undefined || back === '') return false;
  const [pointed, here] = await Promise.all([realOf(resolve(gitDir, back)), realOf(dotGit)]);
  return pointed !== undefined && pointed === here;
}

/**
 * git 目錄、common 目錄與物件庫的 alternates，都是 realpath。
 *
 * `.git`、`gitdir:`、`commondir`、alternates 的內容在工作區裡就是模型寫得到的，所以它們只能開工作區內的讀權。
 * 例外是 {@link pointsBackTo} 驗過的 linked worktree 與它的 common 目錄，以及 repo 根本來就在工作區外的情形。工作區外的 alternates 一律不給。
 */
async function gitDirectories(root: string, workspace: string): Promise<readonly string[]> {
  const dotGit = join(root, '.git');
  const realDot = await realOf(dotGit);
  if (realDot === undefined) return [];
  const realRoot = (await realOf(root)) ?? root;
  const fromWorkspace = within(workspace, realRoot);
  if (fromWorkspace && !within(workspace, realDot)) return [];
  let gitDir = realDot;
  const found: string[] = [];
  if (!(await isKind(realDot, 'isDirectory'))) {
    found.push(dotGit);
    const named = /^gitdir:\s*(.+?)\s*$/mu.exec((await readText(dotGit)) ?? '')?.[1];
    const target = named === undefined ? undefined : await realOf(resolve(root, named));
    if (target === undefined) return found;
    gitDir = target;
    const trusted =
      !fromWorkspace || within(workspace, gitDir) || (await pointsBackTo(gitDir, dotGit));
    if (!trusted) return found;
  }
  found.push(gitDir);
  const commondir = (await readText(join(gitDir, 'commondir')))?.trim();
  const common = commondir === undefined ? gitDir : await realOf(resolve(gitDir, commondir));
  if (common === undefined) return found;
  if (common !== gitDir) {
    const verified = !within(workspace, gitDir) && common === dirname(dirname(gitDir));
    if (!within(workspace, common) && !verified) return found;
    found.push(common);
  }
  const objects = join(common, 'objects');
  for (const line of ((await readText(join(objects, 'info/alternates'))) ?? '').split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const alternate = await realOf(resolve(objects, line));
    if (alternate !== undefined && within(workspace, alternate)) found.push(alternate);
  }
  return found;
}

/** `--show-origin --get-regexp -z` 的輸出：`file:<來源>\0<鍵>\n<值>\0`。`include` 的相對路徑以來源檔為基準；`core.*` 的由 git 以工作目錄解析，落在 repo 裡，不必列。 */
export function parseConfigPaths(output: string): readonly string[] {
  const fields = output.split('\0');
  const paths: string[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [key = '', ...rest] = fields[i + 1]!.split('\n');
    const value = rest.join('\n');
    const origin = fields[i]!.startsWith('file:') ? fields[i]!.slice('file:'.length) : undefined;
    if (value === '') continue;
    if (isAbsolute(value)) paths.push(value);
    else if (origin !== undefined && key.startsWith('include')) {
      paths.push(resolve(dirname(origin), value));
    }
  }
  return paths;
}

function collect(process: ToolProcess): Promise<{ stdout: string; result: ToolResult }> {
  const chunks: Buffer[] = [];
  process.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
  process.stderr.resume();
  const timer = setTimeout(() => process.kill('SIGKILL'), PROBE_TIMEOUT_MS);
  return process.done.then((result) => {
    clearTimeout(timer);
    return { stdout: Buffer.concat(chunks).toString('utf8'), result };
  });
}

/** 一個範圍的路徑類設定。結束碼 1 是沒有符合的鍵；其他非 0 與起不來一樣回失敗原因，答案不完整就不跑。沒有那個範圍的設定檔不算失敗。 */
async function askScope(
  launch: ToolLauncher,
  scope: '--global' | '--system',
  executable: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<readonly string[] | GitStartFailure> {
  const started = await launch({
    executable,
    args: [
      'config',
      scope,
      '--includes',
      '--show-origin',
      '--path',
      '--get-regexp',
      '-z',
      PATH_KEYS,
    ],
    cwd,
    mode: 'danger-full-access',
    readable: [],
    writable: [],
    env,
  });
  if (typeof started === 'string') return started;
  const { stdout, result } = await collect(started);
  if (result.kind === 'failed') return result.reason;
  if (result.code === 0) return parseConfigPaths(stdout);
  return result.code === 1 ? [] : 'launch-failed';
}

const configAnswers = new Map<string, readonly string[]>();

/** 只給測試：清掉記下來的答案。 */
export function forgetGitConfigAnswers(): void {
  configAnswers.clear();
}

/** global 與 system 的設定帶來的讀根，含 `~/.gitconfig` 與 XDG 的 `git/{config,ignore,attributes}`，還沒過濾存不存在。 */
async function configFiles(
  launch: ToolLauncher,
  executable: string,
  cwd: string,
  repo: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<readonly string[] | GitStartFailure> {
  const key = `${env['HOME'] ?? ''}\0${repo ?? cwd}`;
  const known = configAnswers.get(key);
  if (known !== undefined) return known;
  const home = env['HOME'];
  const configHome =
    env['XDG_CONFIG_HOME'] || (home === undefined ? undefined : join(home, '.config'));
  const files = [
    ...(home === undefined ? [] : [join(home, '.gitconfig')]),
    ...(configHome === undefined
      ? []
      : ['config', 'ignore', 'attributes'].map((name) => join(configHome, 'git', name))),
  ];
  // 沒有 HOME 也沒有 XDG 時 `--global` 直接 fatal，那個範圍本來就沒有檔。
  const scopes = files.length === 0 ? (['--system'] as const) : (['--global', '--system'] as const);
  for (const scope of scopes) {
    const answer = await askScope(launch, scope, executable, cwd, env);
    if (typeof answer === 'string') return answer;
    files.push(...answer);
  }
  configAnswers.set(key, files);
  return files;
}

/**
 * 這一次 git 的讀根。
 *
 * @param launch - 問全域設定用的工具接縫。
 * @param executable - git 的路徑。
 * @param cwd - 工作目錄。
 * @param workspace - 工作區根：這底下的檔是模型寫得到的。
 * @param env - 給 git 的環境：它用這份環境找全域設定。
 * @returns 讀根；問不到全域設定、或 repo 根包住 `$HOME` 時回失敗原因。後者給了讀權就是整個 home，不給又讀不到上層的 `.gitignore`，被忽略的檔會進快照。
 */
export async function gitReadRoots(
  launch: ToolLauncher,
  executable: string,
  cwd: string,
  workspace: string,
  env: NodeJS.ProcessEnv,
): Promise<readonly string[] | GitStartFailure> {
  const repo = await repoRootOf(cwd);
  const configs = await configFiles(launch, executable, cwd, repo, env);
  if (typeof configs === 'string') return configs;
  const home = env['HOME'] ?? homedir();
  const realHome = (await realOf(home)) ?? home;
  const realWorkspace = (await realOf(workspace)) ?? workspace;
  const coversHome = async (path: string): Promise<boolean> =>
    within((await realOf(path)) ?? path, realHome);
  if (repo !== undefined && (await coversHome(repo))) return 'repo-covers-home';
  const directories = [
    ...(repo === undefined ? [] : await gitDirectories(repo, realWorkspace)),
    ...(repo === undefined ? [] : [repo]),
    ...((await coversHome(cwd)) ? [] : [cwd]),
  ];
  const candidates = [...GIT_SYSTEM_READABLE, executable, ...directories, ...configs];
  const existing = await Promise.all(
    candidates.map(async (path) =>
      (await stat(path).catch(() => undefined)) === undefined ? undefined : path,
    ),
  );
  return [...new Set(existing.filter((path) => path !== undefined))];
}

const outcome = (result: ToolResult): GitOutcome =>
  result.kind === 'failed' ? result : { kind: 'exited', code: result.code };

/**
 * 組裝點交給 workspace-changes 的那一格。
 *
 * 沙箱不可用時 recorder 不講話（那一輪留 `failed`，下一輪重試），這裡講一次；起成過之後再壞會再講一次。spawner 重起的過程另有監控的 log。
 *
 * @param mode - 會話當下的模式。
 * @param workspace - 工作區根。
 * @param launcher - 工具接縫，省略是產品那一支。
 * @param report - 診斷往哪裡講。
 */
export function createGitStarter(
  mode: () => SandboxMode,
  workspace: string,
  launcher: () => ToolLauncher = productToolLauncher,
  report: (line: string) => void = reportSandbox,
): GitStarter {
  let noted: GitStartFailure | undefined;
  const quiet = (reason: 'sandbox-unavailable' | 'repo-covers-home'): GitStartFailure => {
    if (noted !== reason) {
      report(
        reason === 'repo-covers-home'
          ? 'workspace-changes：repo 根包住 $HOME，不記 git 快照的改動'
          : 'workspace-changes：工具沙箱不可用，這段期間不記 git 快照的改動',
      );
    }
    noted = reason;
    return reason;
  };
  return async (start) => {
    const launch = launcher();
    const fullAccess = mode() === 'danger-full-access';
    const readable = fullAccess
      ? []
      : await gitReadRoots(launch, start.executable, start.cwd, workspace, start.env);
    if (readable === 'sandbox-unavailable' || readable === 'repo-covers-home') {
      return quiet(readable);
    }
    if (typeof readable === 'string') return readable;
    const started = await launch({
      executable: start.executable,
      args: start.args,
      cwd: start.cwd,
      mode: fullAccess ? 'danger-full-access' : 'workspace-write',
      readable,
      writable: fullAccess ? [] : start.writable,
      env: start.env,
      ...(start.stdin === undefined ? {} : { stdin: start.stdin }),
    });
    if (started === 'sandbox-unavailable') return quiet(started);
    if (typeof started === 'string') return started;
    noted = undefined;
    return {
      stdout: started.stdout,
      stderr: started.stderr,
      kill: (signal) => started.kill(signal),
      exited: started.exited.then(outcome),
      done: started.done.then(outcome),
    };
  };
}

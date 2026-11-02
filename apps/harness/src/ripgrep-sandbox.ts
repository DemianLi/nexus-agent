/**
 * rg 在沙箱裡能讀什麼（[#1946](https://github.com/DemianLi/nexus-agent/issues/1946)）：只給工作區、rg 本身，與 rg 會讀的
 * 忽略規則，逐檔列出。清單本身不列 serve 的 home 與整個 `$HOME`；工作區落在裡面時另論。
 *
 * 內附的 rg 是靜態連結，不用系統函式庫的目錄。忽略規則漏了不會報錯：rg 讀不到就當沒有，被忽略的檔悄悄進結果，所以這份清單要對著
 * 輸出比，不是對著結束碼。rg 會讀的（`ignore` crate）：
 *
 * - 工作目錄每一層祖先的 `.gitignore`、`.ignore`、`.rgignore`（工作區裡的本來就讀得到）；
 * - 最近的 repo 的 `info/exclude`。`.git` 是指標檔時（git worktree）要順著 `gitdir:` 與 `commondir` 找；
 * - 全域：`$XDG_CONFIG_HOME/git/config`（沒設是 `~/.config/git/config`）與 `~/.gitconfig` 裡 `core.excludesFile` 指到的檔，
 *   沒有指定就是 `$XDG_CONFIG_HOME/git/ignore`。
 *
 * 給的是路徑時要已經存在：spawner 打不開授權路徑就整筆回 `SandboxUnavailable`。起點不存在時這裡也不列它，讓它照「起點讀不到」失敗。
 *
 * @module
 */

import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/** rg 認的設定檔裡的那一行，同 `ignore` crate 的 `gitconfig_excludes_path`。 */
const EXCLUDES_FILE = /^\s*excludesfile\s*=\s*"?\s*(\S+?)\s*"?\s*$/imu;

const PARENT_IGNORE_FILES = ['.gitignore', '.ignore', '.rgignore'] as const;

async function isFile(path: string): Promise<boolean> {
  return stat(path).then(
    (found) => found.isFile(),
    () => false,
  );
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(
    (found) => found.isDirectory(),
    () => false,
  );
}

const readText = (path: string): Promise<string | undefined> =>
  readFile(path, 'utf8').catch(() => undefined);

/** `.git` 指標檔：回沿路要讀的檔（指標檔、`commondir`、`info/exclude`）；解不出 `gitdir` 時只有指標檔。 */
async function gitDirBehind(pointer: string): Promise<readonly string[]> {
  const gitdir = /^gitdir:\s*(.+?)\s*$/mu.exec((await readText(pointer)) ?? '')?.[1];
  if (gitdir === undefined) return [pointer];
  const worktreeDir = resolve(dirname(pointer), gitdir);
  const commondirFile = join(worktreeDir, 'commondir');
  const commondir = (await readText(commondirFile))?.trim();
  return [
    pointer,
    commondirFile,
    join(commondir === undefined ? worktreeDir : resolve(worktreeDir, commondir), 'info/exclude'),
  ];
}

/** 從工作目錄往上：每層祖先的忽略檔，加上最近的 repo 的 `info/exclude`。 */
async function repoIgnoreFiles(cwd: string): Promise<readonly string[]> {
  const files: string[] = [];
  let repoFound = false;
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (dir !== cwd) files.push(...PARENT_IGNORE_FILES.map((name) => join(dir, name)));
    if (!repoFound) {
      const dotGit = join(dir, '.git');
      if (await isDirectory(dotGit)) {
        repoFound = true;
        files.push(join(dotGit, 'info/exclude'));
      } else if (await isFile(dotGit)) {
        repoFound = true;
        files.push(...(await gitDirBehind(dotGit)));
      }
    }
    if (dirname(dir) === dir) return files;
  }
}

/** 全域的忽略規則：兩份設定檔、它們指到的檔，與 XDG 的 `git/ignore`。相對路徑的 `excludesFile` 不列。 */
async function globalIgnoreFiles(env: NodeJS.ProcessEnv): Promise<readonly string[]> {
  const home = env.HOME;
  const configHome =
    env.XDG_CONFIG_HOME || (home === undefined ? undefined : join(home, '.config'));
  const configs = [
    ...(configHome === undefined ? [] : [join(configHome, 'git/config')]),
    ...(home === undefined ? [] : [join(home, '.gitconfig')]),
  ];
  const files = [...configs];
  if (configHome !== undefined) files.push(join(configHome, 'git/ignore'));
  for (const config of configs) {
    const named = EXCLUDES_FILE.exec((await readText(config)) ?? '')?.[1];
    if (named === undefined) continue;
    if (named.startsWith('~/')) {
      if (home !== undefined) files.push(join(home, named.slice(2)));
    } else if (isAbsolute(named)) {
      files.push(named);
    }
  }
  return files;
}

/**
 * 這一次 rg 的讀根。
 *
 * @param cwd - 工作目錄。
 * @param executable - rg 的路徑。
 * @param env - 給 rg 的環境：rg 用它找全域設定。
 */
export async function ripgrepReadRoots(
  cwd: string,
  executable: string,
  env: NodeJS.ProcessEnv,
): Promise<readonly string[]> {
  const candidates = [...(await repoIgnoreFiles(cwd)), ...(await globalIgnoreFiles(env))];
  const files = await Promise.all(
    candidates.map(async (path) => ((await isFile(path)) ? path : undefined)),
  );
  return [
    ...((await isDirectory(cwd)) ? [cwd] : []),
    ...((await isFile(executable)) ? [executable] : []),
    ...new Set(files.filter((path) => path !== undefined)),
  ];
}

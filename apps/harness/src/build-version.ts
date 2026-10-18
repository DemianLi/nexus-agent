/**
 * 這份程式碼是哪一版：`git rev-parse HEAD` 與工作樹乾不乾淨。
 *
 * eval 結果檔（[#1000](https://github.com/DemianLi/nexus-agent/issues/1000)，`eval/result-file.ts`）先有這一份；會話日誌的
 * header 也要記同一件事（[#1025](https://github.com/DemianLi/nexus-agent/issues/1025)），所以搬到這裡共用，**取法只有一份**。
 *
 * git 是在**這個檔所在的目錄**問的，不是使用者的 cwd：要的是跑著的這份程式碼的版本，不是使用者工作區的。從一棵沒有
 * `.git` 的樹跑（打包、CI 的淺層 checkout 被拿掉 `.git`）就拿不到，記 `null`。
 *
 * ## 子行程的環境與逾時（[#1620](https://github.com/DemianLi/nexus-agent/issues/1620)）
 *
 * - **清洗過的環境**：照 dsh「每個 spawner 都走同一份清洗」（`packages/subprocess/subprocess/src/index.ts:41-47`，`687f282e`），
 *   用 `@nexus/core` 的 `scrubbedParentEnv()`，再疊上跟 git 快照同一組 git 變數（`packages/nexus-plugin-workspace-changes/src/git.ts`
 *   的 `GitRunner.run`）。`launch-env` 從 `.env` 寫進行程環境的 key 不再交給 git；`GIT_OPTIONAL_LOCKS=0` 讓 `git status` 不去刷新
 *   程式碼 checkout 的 index。
 * - **逾時 {@link GIT_PROBE_TIMEOUT_MS}、到時 SIGKILL**：這是同步呼叫，git 卡住時整個 serve 的事件迴圈跟著卡住，所以不能用 git
 *   快照那種 30 秒；同步呼叫也沒有「先 TERM、寬限之後再 KILL」那一步，忽略 SIGTERM 的子行程會讓呼叫等到它自己結束，所以直接
 *   SIGKILL。逾時跟其他失敗一樣記 `null`。**只殺直接子行程**：git 自己留下的孫行程（使用者在程式碼 checkout 設了 `core.fsmonitor`
 *   這類設定時）不會被殺，跟 git 快照登記的是同一格窄。
 * - **這裡管的只是「沒有戳記才問 git」那條退路**：dsh 的 commit 是打包時記下的（`apps/desktop/scripts/desktop-build-commit.mjs:23-29`），
 *   我們打包出來的產物也帶戳記（{@link resolveBuildVersion}，#1502）；原始碼樹沒有戳記，才在執行期問 git。這張不動這個順序。
 *
 * @module
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { scrubbedParentEnv } from '@nexus/core';
import type { StoredSessionBuild } from '@nexus/core';

/** 跑一個 git 指令；失敗（沒有 git、不在 repo 裡）回 `undefined`。 */
export type GitProbe = (args: readonly string[]) => string | undefined;

/** 跑的時候 repo 是什麼狀態。拿不到（不在 git 底下、沒有 git）就是 `null`，不猜。 */
export type BuildVersion = StoredSessionBuild;

/** 預設探針每一次 git 的上限（毫秒）。見檔頭「子行程的環境與逾時」。 */
export const GIT_PROBE_TIMEOUT_MS = 5_000;

function defaultGitProbe(args: readonly string[]): string | undefined {
  try {
    return execFileSync('git', [...args], {
      cwd: fileURLToPath(new URL('.', import.meta.url)),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: {
        ...scrubbedParentEnv(),
        // 淨化會拿掉 `GIT_CONFIG_KEY_<n>`，所以明著把環境裡的索引設定關掉，同 git 快照。
        GIT_CONFIG_COUNT: '0',
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        LC_ALL: 'C',
      },
      timeout: GIT_PROBE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      windowsHide: true,
    });
  } catch {
    return undefined;
  }
}

/**
 * 跑在哪個 commit、工作樹乾不乾淨。
 *
 * `probe` 可注入，測試不打真的 git。**拿不到就記 `null`**，不填 `'unknown'` 字串：
 * 字串會被當成一個 SHA 比對，`null` 不會。
 *
 * @param probe - 跑 git 的那一支，省略即在這個檔的目錄跑真的 git。
 * @returns commit 與 dirty，各自拿不到就是 `null`。
 */
export function readGitProvenance(probe: GitProbe = defaultGitProbe): BuildVersion {
  const head = probe(['rev-parse', 'HEAD'])?.trim();
  const porcelain = probe(['status', '--porcelain']);
  return {
    commit: head === undefined || head === '' ? null : head,
    dirty: porcelain === undefined ? null : porcelain.trim() !== '',
  };
}

/**
 * 打包時寫進產物的建置戳記（#1502 刀 2）：`apps/harness/build-stamp.json`，內容 `{ "commit": "<sha>", "dirty": false }`。
 * 相對這個檔所在的位置找，`src/` 與編出來的 `lib/` 同一深度，兩邊相同。原始碼樹裡沒有這個檔。
 */
const BUILD_STAMP_PATH = fileURLToPath(new URL('../build-stamp.json', import.meta.url));

/**
 * 讀建置戳記。**檔不存在、讀不了、形狀不對一律回 `undefined`**，交給呼叫端退回問 git：戳記是產物帶的附加資訊，
 * 壞了不該讓行程起不來，也不猜一個值。
 *
 * @param path - 戳記檔路徑，省略即產物裡那一份。
 * @returns 戳記記的建置版本；沒有或不合法就是 `undefined`。
 */
export function readBuildStamp(path: string = BUILD_STAMP_PATH): BuildVersion | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const { commit, dirty } = parsed as { commit?: unknown; dirty?: unknown };
  if (typeof commit !== 'string' || commit === '') return undefined;
  return { commit, dirty: typeof dirty === 'boolean' ? dirty : null };
}

/** {@link resolveBuildVersion} 的來源，測試注入。 */
export interface BuildVersionSources {
  readonly stampPath?: string;
  readonly probe?: GitProbe;
}

/**
 * 建置版本：**戳記優先，沒有才問 git，都拿不到才記 `null`。**
 *
 * 戳記只存在於打包出來的產物，所以它在就代表這份程式碼是那次打包來的；順序反過來的話，安裝目錄剛好放在別的 git repo
 * 底下時，會記成那個 repo 的 HEAD，而不是這份程式碼的 commit。原始碼樹沒有戳記，照舊問 git。
 *
 * @param sources - 戳記路徑與 git 探針，省略即真的檔案與真的 git。
 * @returns 同 {@link readGitProvenance}。
 */
export function resolveBuildVersion(sources: BuildVersionSources = {}): BuildVersion {
  return readBuildStamp(sources.stampPath) ?? readGitProvenance(sources.probe);
}

let processBuild: BuildVersion | undefined;

/**
 * 這個行程的建置版本：**第一次問的時候算，之後同一個行程都回那一份**。
 *
 * 跑著的程式碼在行程啟動時就定了，之後工作樹被改不會改變這個行程跑的是什麼；serve 每條 thread 各自組裝，也不該每條
 * 都叫兩次 git。
 *
 * @returns 同 {@link resolveBuildVersion}。
 */
export function processBuildVersion(): BuildVersion {
  processBuild ??= resolveBuildVersion();
  return processBuild;
}

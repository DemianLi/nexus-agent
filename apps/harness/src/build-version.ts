/**
 * 這份程式碼是哪一版：`git rev-parse HEAD` 與工作樹乾不乾淨。
 *
 * eval 結果檔（[#1000](https://github.com/DemianLi/nexus-agent/issues/1000)，`eval/result-file.ts`）先有這一份；會話日誌的
 * header 也要記同一件事（[#1025](https://github.com/DemianLi/nexus-agent/issues/1025)），所以搬到這裡共用，**取法只有一份**。
 *
 * git 是在**這個檔所在的目錄**問的，不是使用者的 cwd：要的是跑著的這份程式碼的版本，不是使用者工作區的。從一棵沒有
 * `.git` 的樹跑（打包、CI 的淺層 checkout 被拿掉 `.git`）就拿不到，記 `null`。
 *
 * @module
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type { StoredSessionBuild } from '@nexus/core';

/** 跑一個 git 指令；失敗（沒有 git、不在 repo 裡）回 `undefined`。 */
export type GitProbe = (args: readonly string[]) => string | undefined;

/** 跑的時候 repo 是什麼狀態。拿不到（不在 git 底下、沒有 git）就是 `null`，不猜。 */
export type BuildVersion = StoredSessionBuild;

function defaultGitProbe(args: readonly string[]): string | undefined {
  try {
    return execFileSync('git', [...args], {
      cwd: fileURLToPath(new URL('.', import.meta.url)),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
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

let processBuild: BuildVersion | undefined;

/**
 * 這個行程的建置版本：**第一次問的時候算，之後同一個行程都回那一份**。
 *
 * 跑著的程式碼在行程啟動時就定了，之後工作樹被改不會改變這個行程跑的是什麼；serve 每條 thread 各自組裝，也不該每條
 * 都叫兩次 git。
 *
 * @returns 同 {@link readGitProvenance}。
 */
export function processBuildVersion(): BuildVersion {
  processBuild ??= readGitProvenance();
  return processBuild;
}

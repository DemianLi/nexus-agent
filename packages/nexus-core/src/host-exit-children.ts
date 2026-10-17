/**
 * 行程結束時要同步強殺的子行程（[#1542](https://github.com/DemianLi/nexus-agent/issues/1542)）：**每個自己起子行程的地方
 * 共用這一份登記表**。照 dsh `subprocess-local` 的 host-exit 終止（`packages/subprocess/subprocess-local/src/index.ts:90-120`，
 * `687f282e`）。
 *
 * serve 被強制結束（第二次訊號、收尾逾時、致命退出）時，三條路最後都叫 `process.exit`。`'exit'` 事件會發，但 Node 不替你收
 * 子行程：還在跑的子行程會留成孤兒，它的逾時是父行程在數，父行程一死就沒人數。所以在 `'exit'` 上逐個送 SIGKILL。`kill` 是
 * 同步送訊號，在 `'exit'` 裡做得到；`'exit'` 裡不能 await，所以不等它們結束。
 *
 * - **一個行程只掛一個 listener**，同 dsh 一個 runtime 一個：第一個子行程登記時 `prependListener`，登記表清空時 `off`。不照每個
 *   呼叫端各掛一個——git 的 runner 每條 thread 組裝時各建一份，十幾條 thread 就會超過 Node 預設的 10 個 listener。
 * - **`prependListener`**，同 dsh：排在其他 `'exit'` listener 前面。
 * - **一個失敗不擋其他的**：每個各自 try/catch，同 dsh。
 *
 * ## 與 dsh 的偏離：只殺直接子行程
 *
 * dsh 殺的是整個受管範圍（Linux scope、Windows job、process group），子行程底下的孫行程也收得到。我們沒有 subprocess 服務
 * （決策 3 延後，`.docs/plugin-architecture-gap-survey.md:39`），`spawn` 不加 `detached` 時沒有範圍可殺；改用 `detached` 會讓子行程
 * 離開 serve 的行程群組，終端機的 Ctrl-C 與對整個群組送的訊號都收不到它。所以退到只殺登記的那一個（理由 1：基座表達不出來）。
 *
 * 只有 `'exit'` 發得出來的結束管得到：SIGKILL、OOM killer、沒有 handler 的訊號都不經過 JS，dsh 一樣管不到。
 *
 * @module
 */

/** 能被強殺的子行程：`ChildProcess` 用到的那一個方法。 */
export interface HostExitChild {
  kill(signal: NodeJS.Signals): boolean;
}

const children = new Set<HostExitChild>();

/** 行程結束那一刻：逐個送 SIGKILL。掛在 `'exit'` 上的就是它；匯出給測試直接呼叫，不必真的結束行程。 */
export function terminateHostExitChildren(): void {
  for (const child of children) {
    try {
      child.kill('SIGKILL');
    } catch {
      // 行程結束時不能等、也不能回報單一目標；其餘照收（同 dsh）。
    }
  }
}

/**
 * 登記一個子行程：行程結束時還在登記表上的，會被同步送 SIGKILL。子行程自己結束（`close`、`error`）時要拿掉。
 *
 * @param child - 剛 spawn 出來的子行程。
 * @returns 拿掉這一筆；冪等。
 */
export function trackHostExitChild(child: HostExitChild): () => void {
  if (children.size === 0) process.prependListener('exit', terminateHostExitChildren);
  children.add(child);
  let tracked = true;
  return () => {
    if (!tracked) return;
    tracked = false;
    children.delete(child);
    if (children.size === 0) process.off('exit', terminateHostExitChildren);
  };
}

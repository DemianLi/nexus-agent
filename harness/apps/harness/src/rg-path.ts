/**
 * 內附 ripgrep 的路徑（[#1502](https://github.com/DemianLi/nexus-agent/issues/1502) 刀 4）。
 *
 * 照 dsh `packages/fs/tool-fs-search/src/search-core.ts:156-184` 的 `resolveRgPath`（`687f282e`）：**延遲解析、記住結果**，
 * 解析在第一次搜尋時才發生，所以內附的 rg 缺了或壞了只讓那一次搜尋以 `SEARCH_FAILED` 失敗，不讓組裝失敗。
 * 路徑來自 `@vscode/ripgrep` 的平台套件（`@vscode/ripgrep-<platform>-<arch>`，pnpm 依目前平台裝一份）；
 * 解析結果**直接交給 `runRipgrep`，不前置進 `PATH`**，也沒有退路：找不到就是產物壞了。
 *
 * ## 與 dsh 的差異
 *
 * - dsh 還認單檔執行檔旁的 `-rg` sidecar（pkg 虛擬檔案系統起不了原生檔）與 Electron 的 `.asar.unpacked`；我們不做單檔執行檔、
 *   不是 Electron（刀 2 的「不做什麼」），這兩支不抄。
 * - dsh 的 rg 不存在時整個 grep 失敗；#1532 的偏離 1（`ENOENT` 時退回基座的 `literalSearch`）在這一張拿掉——
 *   那條退路的前提是「我們和基座 spawn 的是同一支 `PATH` 上的 rg」，把解析出的絕對路徑直接交給 runner 之後，這個前提不成立
 *   （路徑 `ENOENT` 時，`PATH` 上另一支 rg 會被基座以沒有 `--no-config` 的方式起來），所以退路必須同批拿掉。
 *
 * @module
 */

import { accessSync, constants } from 'node:fs';

let resolved: Promise<string> | undefined;

/**
 * 內附 rg 的絕對路徑，每個行程只解析一次（成功與失敗都記住）。
 *
 * @returns 路徑；平台套件解析不到時 reject（訊息來自 `@vscode/ripgrep`）。
 */
export function resolveRgPath(): Promise<string> {
  resolved ??= import('@vscode/ripgrep').then((module) => module.rgPath);
  return resolved;
}

/** 內附 rg 的現況，給啟動那一行與測試用。 */
export type RgStatus =
  | { readonly kind: 'bundled'; readonly path: string }
  | { readonly kind: 'missing'; readonly reason: string };

/**
 * 內附 rg 現在能不能用：解析得到、檔案在、有執行權限。**不丟例外**——缺了壞了只是回 `missing`，由呼叫端決定印什麼。
 *
 * @param resolve - 測試接縫：換掉解析函式。
 */
export async function ripgrepStatus(
  resolve: () => Promise<string> = resolveRgPath,
): Promise<RgStatus> {
  let path: string;
  try {
    path = await resolve();
  } catch (error: unknown) {
    return { kind: 'missing', reason: error instanceof Error ? error.message : String(error) };
  }
  try {
    accessSync(path, constants.X_OK);
  } catch (error: unknown) {
    return {
      kind: 'missing',
      reason: `${path} 不存在或不能執行（${(error as NodeJS.ErrnoException).code ?? 'unknown'}）`,
    };
  }
  return { kind: 'bundled', path };
}

/**
 * 啟動時印的一行（刀 4）：這次搜尋走哪一支 rg。內附的缺了或壞了照 dsh 不讓組裝失敗，只講出來，
 * 並說清楚後果——每一次 `grep` 都會以 `SEARCH_FAILED` 失敗，**沒有退路**。
 *
 * @param status - {@link ripgrepStatus} 的結果。
 */
export function formatRipgrepDisclosure(status: RgStatus): string {
  return status.kind === 'bundled'
    ? `搜尋（grep）：內附 ripgrep ${status.path}`
    : `搜尋（grep）：內附 ripgrep 不可用（${status.reason}）；每一次 grep 都會以 SEARCH_FAILED 失敗，沒有退路`;
}

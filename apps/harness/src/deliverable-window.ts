/**
 * 讀一個宣告過的交付檔的**位元組窗口**（[#544](https://github.com/DemianLi/nexus-agent/issues/544) 的 B）。
 * 照 dsh `workspace-files` 的 `readBytes`（`packages/api/workspace-files/src/index.ts`，`ddefc45`）。
 *
 * ## 為什麼要有這一條
 *
 * 文字預覽按行切頁，一頁超過 `maxBytes` 是拒絕，不是截斷（dsh 的理由逐字：「a silently cut page
 * reads as the whole page」）。所以一個**單行本身就超過 `maxBytes`** 的檔，按行怎麼切都是 413。
 *
 * #544 的原案是讓文字頁在那時候回切短的一段、標明還有下文。那是偏離 dsh 的拒絕，而拒絕我們表達
 * 得出來，不符合偏離的條件。demian 2026-09-23 拍板走另一條：**照 dsh 開它本來就有的位元組窗口**。
 * 頁的拒絕一個字都不動；讀不動的那種檔，呼叫端改用窗口一段一段讀。**dsh 的 UI 沒有拿窗口當文字
 * 預覽的退路**（它的 `readBytes` 只在 office 預覽裡當一個位元組的授權探針用），所以「拿它來做什麼」
 * 是我們 web 的 UI 決定，不在這條路由的射程裡。
 *
 * ## 跟 dsh 一樣的地方
 *
 * - **不解碼、不擋二進位**：原始位元組，沒有 NUL 檢查，也沒有 UTF-8 檢查。
 * - **窗口的上限是拒絕**：`length` 超過 `maxBytes` 回 `too-large`，不給到上限為止。
 * - `offset` 預設 0、`length` 預設 `maxBytes`，都要是安全整數，`offset + length` 也是。
 * - `eof` 是「這個窗口含最後一個位元組」，拿閘門那一次 `stat` 的大小算。`offset` 在檔尾或之後時
 *   `data` 是空的、`eof` 是真的。
 *
 * **不在這裡的**：錨、座標、閘門，全部沿用 `deliverable-files.ts`——這條路由走的是跟預覽、下載
 * 同一個 `locateRequested`。
 *
 * @module
 */

import { open } from 'node:fs/promises';

import type { DeliverableFileBytes } from '@nexus/wire';

import type { DeliverableResult, LocatedDeliverable } from './deliverable-files.js';
import type { DeliverableFilesConfig } from './settings/deliverable-files.js';

/** 驗過的窗口。 */
export interface DeliverableWindow {
  readonly offset: number;
  readonly length: number;
}

/**
 * 驗窗口參數，**在找檔之前**，照 dsh 的順序（`readBytes` 先 `resolveWindow` 再 `locateFile`）：
 * 一個參數本身就不合格的請求，不該先讓它知道那個座標上有沒有檔。
 *
 * 先驗 `offset + length` 是安全整數（`bad-request`），再驗 `length` 有沒有超過上限（`too-large`），
 * 順序同 dsh。`length` 為 0 也是 `bad-request`（dsh 的 `integerAtLeast(length, 1)`）。
 *
 * @param offset - 窗口從第幾個位元組起，呼叫端已經驗過是非負安全整數。
 * @param length - 窗口最多幾個位元組，同上。
 * @param limits - 這台 server 的三個上限，只用 `maxBytes`。
 * @returns 驗過的窗口，或拒絕。
 */
export function resolveDeliverableWindow(
  offset: number,
  length: number,
  limits: DeliverableFilesConfig,
): DeliverableResult<DeliverableWindow> {
  if (length < 1 || !Number.isSafeInteger(offset + length)) {
    return { kind: 'refused', reason: 'bad-request', message: '交付檔的位元組窗口參數不對。' };
  }
  if (length > limits.maxBytes) {
    return {
      kind: 'refused',
      reason: 'too-large',
      message: `要的 ${length} 位元組超過 ${limits.maxBytes} 的上限。上限是拒絕，不是截斷。`,
    };
  }
  return { kind: 'ok', value: { offset, length } };
}

/**
 * 讀一個位元組窗口。窗口要先過 {@link resolveDeliverableWindow}。
 *
 * **記憶體以 `length` 為界**，而 `length` 過了驗證就不超過 `maxBytes`：緩衝區開的是請求的長度，不是檔案大小。
 * 一次 `read` 可能回得比要的少（規格沒保證一般檔一次讀滿），所以讀到滿或讀到 0 為止。
 *
 * @param located - 已經通過閘門的檔。
 * @param window - 驗過的窗口。
 * @returns 那個窗口，或拒絕。
 */
export async function readDeliverableWindow(
  located: LocatedDeliverable,
  window: DeliverableWindow,
): Promise<DeliverableResult<DeliverableFileBytes>> {
  const { offset, length } = window;
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(located.target, 'r');
  } catch {
    return {
      kind: 'refused',
      reason: 'not-found',
      message: `讀不到：${located.stat.path} 不在了。`,
    };
  }
  try {
    const buffer = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await handle.read(buffer, filled, length - filled, offset + filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return {
      kind: 'ok',
      value: {
        ...located.stat,
        offset,
        data: buffer.subarray(0, filled).toString('base64'),
        eof: offset + filled >= located.stat.bytes,
      },
    };
  } finally {
    await handle.close();
  }
}

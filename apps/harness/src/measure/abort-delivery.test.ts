/**
 * 客戶端斷線之後，handler 手上的 `request.signal` 一定中止——#990 修的缺陷的回歸測試。
 *
 * 修前（`wire-server.ts` 不抓著衍生的 Request）同樣的量法在本機放棄 160 次時兩種形狀各有十幾二十次沒中止
 * （2026-10-04 實測 17 與 22 次，兩輪兩條都紅），所以這一檔在修前會紅；單一請求的測試看不出來。細節與數字見 `abort-delivery.ts`。
 */

import { describe, expect, it } from 'vitest';
import { measureAbortDelivery } from './abort-delivery.js';

describe('放棄請求時 handler 的 signal 都會中止', () => {
  for (const shape of ['list', 'sse'] as const) {
    it(`${shape} 形狀：放棄 160 次，一次都不漏`, async () => {
      const result = await measureAbortDelivery({
        shape,
        total: 160,
        concurrency: 16,
        holdMs: 800,
      });
      expect(result).toEqual({ total: 160, noticed: 160, lost: 0 });
    }, 30_000);
  }
});

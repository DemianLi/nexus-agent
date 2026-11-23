/**
 * 客戶端斷線之後，handler 手上的 `request.signal` 一定中止——#990 修的缺陷的回歸測試。
 *
 * 修前（`wire-server.ts` 不抓著衍生的 Request）同樣的量法在本機放棄 160 次時兩種形狀各有十幾二十次沒中止
 * （2026-10-04 實測 17 與 22 次，兩輪兩條都紅），所以這一檔在修前會紅；單一請求的測試看不出來。量的期間每 25 毫秒強制一次完整的
 * 垃圾回收，缺陷才不必靠運氣發作。細節與數字見 `abort-delivery.ts`。
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
        gcEveryMs: 25,
      });
      // 有一部分請求在伺服器還沒處理之前就被客戶端砍掉了（CI 上較多），那些 handler 根本沒跑，不算漏；要求跑到的有足夠多，
      // 而且沒有一次是「撐到最後都沒中止」。
      expect(result.noticed).toBeGreaterThanOrEqual(20);
      expect(result.lost).toBe(0);
    }, 30_000);
  }
});

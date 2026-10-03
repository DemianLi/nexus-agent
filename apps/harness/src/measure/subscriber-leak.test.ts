/**
 * 客戶端斷線之後，真的下行路由把訂閱收掉——#990 修的缺陷在真路由上的回歸測試（量法見 `subscriber-leak.ts`）。
 *
 * 量的期間每 25 毫秒強制一次完整的垃圾回收，缺陷才不必靠運氣發作。修前（`wire-server.ts` 不抓著衍生的 Request）兩條路由放棄 400 次
 * 幾乎全漏（2026-10-04：`stream` 398 與 396、`feed` 400 與 400），修後 0。不強制回收時修前只在行程跑了一陣子之後才偶爾漏（約 3%），
 * 一個剛起來的行程第一輪甚至一條都不漏——所以這一檔要把回收壓力寫進去。
 */

import { describe, expect, it } from 'vitest';
import { measureSubscriberLeak } from './subscriber-leak.js';

describe('放棄下行請求時訂閱都會收掉', () => {
  for (const route of ['feed', 'stream'] as const) {
    it(`${route}：放棄 400 次，一條都不漏`, async () => {
      const result = await measureSubscriberLeak({
        route,
        total: 400,
        concurrency: 16,
        settleMs: 3000,
      });
      // 先確定每一次都真的訂到了，不然「沒漏」可能只是沒走到。
      expect(result).toEqual({ total: 400, subscribed: 400, leaked: 0 });
    }, 60_000);
  }
});

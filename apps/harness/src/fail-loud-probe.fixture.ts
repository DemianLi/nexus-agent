/**
 * 一顆**能在閒著的 thread 上漏一顆 rejection、並在收尾時留下記號**的 plugin
 * （[#1501](https://github.com/DemianLi/nexus-agent/issues/1501) 驗收 1，接線紅燈）。
 *
 *   pnpm --filter @nexus/harness run serve --patch src/fail-loud-probe.patch.yml
 *
 * 子行程的 serve 讀三個環境變數（沒給就什麼都不做，所以這份 patch 掛上去對別的測試無害）：
 *
 * - `FAIL_LOUD_PROBE_MARKER`：收尾記號檔的路徑。
 * - `FAIL_LOUD_PROBE_ARM`：這個檔**存在**時，收尾才寫記號。要這一道，是因為啟動時試組一次、之後每條 thread 各組一次，
 *   每一次的收尾都會跑到這顆；只有**測試明講「現在」之後**的收尾才算，不然啟動試組的收尾就把記號寫了，拿掉修正也照綠。
 * - `FAIL_LOUD_PROBE_LEAK`：這個檔出現時，漏一顆沒人接的 rejection（模擬 #346 那一類：上游串流或外掛漏出來的孤兒 promise）。
 *   用檔案觸發而不是工具呼叫，是為了讓測試挑**閒著的時候**：一輪中途的排空歸訊號收尾的 5 秒預算管，壓在 2 秒裡 CI 一忙就閃。
 */

import { existsSync, writeFileSync } from 'node:fs';
import type { NexusPlugin } from '@nexus/core';

/** 漏出去的那顆 rejection 的訊息，測試靠它認出診斷。 */
export const FAIL_LOUD_PROBE_MESSAGE = 'fail-loud probe';

const probe: NexusPlugin = {
  name: 'fail-loud-probe',
  apply(registry) {
    const marker = process.env['FAIL_LOUD_PROBE_MARKER'];
    const arm = process.env['FAIL_LOUD_PROBE_ARM'];
    const leak = process.env['FAIL_LOUD_PROBE_LEAK'];
    if (marker === undefined || arm === undefined || leak === undefined) return;
    const timer = setInterval(() => {
      if (!existsSync(leak)) return;
      clearInterval(timer);
      void Promise.reject(new Error(FAIL_LOUD_PROBE_MESSAGE));
    }, 20);
    timer.unref();
    registry.lifecycle.onDispose(() => {
      clearInterval(timer);
      if (existsSync(arm)) writeFileSync(marker, 'disposed');
    });
  },
};

export default probe;

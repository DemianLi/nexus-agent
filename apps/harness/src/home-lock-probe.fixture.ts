/**
 * 一顆**在收尾時回報 home 鎖還握不握著**的 plugin（[#1503](https://github.com/DemianLi/nexus-agent/issues/1503)：
 * 放鎖是 `close()` 的最後一步，排在 thread、插件、根都收完之後）。
 *
 *   runServe({ argv: ['--patch', 'src/home-lock-probe.patch.yml', …] })
 *
 * 讀三個環境變數（沒給就什麼都不做，所以這份 patch 掛上去對別的測試無害）：
 *
 * - `HOME_LOCK_PROBE_MARKER`：回報檔的路徑。
 * - `HOME_LOCK_PROBE_HOME`：被鎖的 home（`runServe` 的 `env` 不是行程環境，插件讀不到，所以明給）。
 * - `HOME_LOCK_PROBE_ARM`：這個檔**存在**時才回報。啟動時試組一次、之後每條 thread 各組一次，每一次的收尾都會跑到這顆；
 *   只有測試明講「現在」之後的收尾才算，不然啟動試組的收尾（鎖當然握著）就把證據寫了，把放鎖挪到最前面也照綠。
 *
 * 每次收尾往回報檔加一行：`held`（對同一個 home 再拿一次鎖，撞上 `HomeInUseError`＝鎖還握著）或 `free`
 * （拿得到＝已經放了；立刻放回去）。同一個行程對同一個鎖檔開兩次，flock 一樣互斥。
 */

import { appendFileSync, existsSync } from 'node:fs';
import type { NexusPlugin } from '@nexus/core';
import { acquireHomeLock, HomeInUseError } from './home-lock.js';

const probe: NexusPlugin = {
  name: 'home-lock-probe',
  apply(registry) {
    const marker = process.env['HOME_LOCK_PROBE_MARKER'];
    const arm = process.env['HOME_LOCK_PROBE_ARM'];
    const home = process.env['HOME_LOCK_PROBE_HOME'];
    if (marker === undefined || arm === undefined || home === undefined) return;
    registry.lifecycle.onDispose(async () => {
      if (!existsSync(arm)) return;
      try {
        const lock = await acquireHomeLock(home);
        if ('release' in lock) await lock.release();
        appendFileSync(marker, 'free\n');
      } catch (error) {
        appendFileSync(
          marker,
          error instanceof HomeInUseError ? 'held\n' : `error:${String(error)}\n`,
        );
      }
    });
  },
};

export default probe;

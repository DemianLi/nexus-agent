import { defineConfig } from 'vitest/config';

import { pathsPlugin, sourceHook } from '../../vitest.shared.ts';
import { DurationSequencer } from './src/test-shard-sequencer.ts';

/**
 * 每個測試檔都先把 `NEXUS_AGENT_HOME` 指到自己的暫存目錄（#424）：`runServe` 會在 harness home
 * 建瀏覽器會話密鑰，**任何測試都不准碰到真的 `~/.nexus-agent`**。見 `src/test-home.setup.ts`。
 *
 * 分片與排序看上一輪的耗時（#2093），見 `src/test-shard-sequencer.ts`。
 */
export default defineConfig({
  plugins: [pathsPlugin()],
  test: {
    execArgv: sourceHook(),
    setupFiles: ['./src/test-home.setup.ts'],
    sequence: { sequencer: DurationSequencer },
  },
});

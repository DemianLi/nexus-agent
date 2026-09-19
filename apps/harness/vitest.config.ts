import { defineConfig } from 'vitest/config';

/**
 * 每個測試檔都先把 `NEXUS_AGENT_HOME` 指到自己的暫存目錄（#424）：`runServe` 會在 harness home
 * 建瀏覽器會話密鑰，**任何測試都不准碰到真的 `~/.nexus-agent`**。見 `src/test-home.setup.ts`。
 */
export default defineConfig({
  test: {
    setupFiles: ['./src/test-home.setup.ts'],
  },
});

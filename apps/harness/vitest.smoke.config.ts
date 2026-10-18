import { defineConfig } from 'vitest/config';

import { pathsPlugin, sourceHook } from '../../vitest.shared.ts';

/**
 * 真模型冒煙回歸（#436）：只收 `src/smoke/**\/*.smoke.ts`，一般的 `vitest.config.ts` 收不到它們。
 *
 * - **模組解析跟 `vitest.config.ts` 一樣走 `src/`**（`pathsPlugin`＋`sourceHook`）：`serve-smoke.smoke.ts` 用值 import `../serve.js`，
 *   裸 workspace 名不接就會經 `exports` 走到 `lib/`（乾淨樹上不存在，建過的樹上可能是過期產物、第二份單例）。
 * - **`setupFiles` 一定要留**：`runServe` 會在 harness home 建瀏覽器會話密鑰，不准碰到真的 `~/.nexus-agent`（#424）。
 * - 單一 worker、不重試：請求數只有一份帳，vitest 自己重試的請求同樣花額度、而且會讓上限的算法失真。
 * - 逾時：一個案例最壞要等首事件 180 秒＋閒置 90 秒（#1251），給 5 分鐘。
 */
export default defineConfig({
  plugins: [pathsPlugin()],
  test: {
    execArgv: sourceHook(),
    include: ['src/smoke/**/*.smoke.ts'],
    setupFiles: ['./src/test-home.setup.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    retry: 0,
    testTimeout: 300_000,
    hookTimeout: 120_000,
  },
});

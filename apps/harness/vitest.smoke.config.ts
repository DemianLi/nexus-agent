import { defineConfig } from 'vitest/config';

/**
 * 真模型冒煙回歸（#436）：只收 `src/smoke/**\/*.smoke.ts`，一般的 `vitest.config.ts` 收不到它們。
 *
 * - **`setupFiles` 一定要留**：`runServe` 會在 harness home 建瀏覽器會話密鑰，不准碰到真的 `~/.nexus-agent`（#424）。
 * - 單一 worker、不重試：請求數只有一份帳，vitest 自己重試的請求同樣花額度、而且會讓上限的算法失真。
 * - 逾時：一個案例最壞要等首事件 180 秒＋閒置 90 秒（#1251），給 5 分鐘。
 */
export default defineConfig({
  test: {
    include: ['src/smoke/**/*.smoke.ts'],
    setupFiles: ['./src/test-home.setup.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    retry: 0,
    testTimeout: 300_000,
    hookTimeout: 120_000,
  },
});

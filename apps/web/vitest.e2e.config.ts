import { defineConfig } from 'vitest/config';

import { vitestExecArgv } from './vitest.shared';

/**
 * 真瀏覽器對話 e2e（`e2e/**\/*.e2e.ts`，#1602）的測試設定。
 * 跟 `vitest.config.ts` 分開：它要先有 build 產物、要起 serve 與 Chrome。跑法見 `package.json` 的 `test:e2e`。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['e2e/**/*.e2e.ts'],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 120_000,
    execArgv: vitestExecArgv,
  },
});

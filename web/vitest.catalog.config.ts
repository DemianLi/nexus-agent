import { defineConfig } from 'vitest/config';

import { vitestExecArgv } from './vitest.shared';

/**
 * 元件目錄（`catalog/catalog.run.ts`）的設定。跟 `vitest.guard.config.ts` 分開：它是產生器不是測試，不該被 `test:guard` 撿到。
 * 跑法見 `package.json` 的 `catalog`。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['catalog/catalog.run.ts'],
    testTimeout: 600_000,
    execArgv: vitestExecArgv,
    hookTimeout: 120_000,
  },
});

import { defineConfig } from 'vitest/config';

import { vitestExecArgv } from './vitest.shared';

/**
 * 瀏覽器護欄（`guard/*.test.ts`，#1512）的測試設定。跟 `vitest.config.ts` 分開：它要先有 build 產物、要開真的 Chrome，
 * 不該混進 `pnpm test` 的 jsdom 全套。跑法見 `package.json` 的 `test:guard`。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['guard/**/*.test.ts'],
    // 檔數與 runner 的 4 核對齊：vitest 預設開核數減一個 worker，第四個檔就要等前面一個檔跑完。
    maxWorkers: 4,
    testTimeout: 60_000,
    execArgv: vitestExecArgv,
    hookTimeout: 120_000,
  },
});

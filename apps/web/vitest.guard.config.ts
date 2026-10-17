import { defineConfig } from 'vitest/config';

/**
 * 瀏覽器護欄（`guard/guard.test.ts`，#1512）的測試設定。跟 `vitest.config.ts` 分開：它要先有 build 產物、要開真的 Chrome，
 * 不該混進 `pnpm test` 的 jsdom 全套。跑法見 `package.json` 的 `test:guard`。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['guard/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});

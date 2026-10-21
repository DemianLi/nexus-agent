import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

import { RESOLVE_ALIAS } from './resolve-alias';
import { vitestExecArgv } from './vitest.shared';

/**
 * 測試設定。**不沿用 `vite.config.ts`**：那一份在 `command === 'serve'` 時拋錯（#426），而 vitest 載入設定時
 * 傳的正是 `serve`。dsh 的測試走 repo 根的 vitest 設定，同樣不載入 web 那份。
 */
export default defineConfig({
  // `@nexus/*` 經根 `tsconfig.base.json` 的 paths 解析到各套件的 `src`，照 dsh `vitest.web.config.ts:20`：套件的 exports
  // 指到 `lib/` 之後，測試照樣跑原始碼（#1633，為 #1502 的建置產物鋪路）。不讀 web 自己的 tsconfig：外掛只對那份
  // `include` 範圍內的檔套 paths，web 引進的 `packages/*/src` 互相 import 時會落回 exports。`@/*` 走 `RESOLVE_ALIAS`。
  plugins: [react(), tsconfigPaths({ projects: ['../../tsconfig.base.json'] })],
  resolve: { alias: RESOLVE_ALIAS },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    execArgv: vitestExecArgv,
  },
});

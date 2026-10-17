import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

import { RESOLVE_ALIAS } from './resolve-alias';

/**
 * 測試設定。**不沿用 `vite.config.ts`**：那一份在 `command === 'serve'` 時拋錯（#426），而 vitest 載入設定時
 * 傳的正是 `serve`。dsh 的測試走 repo 根的 vitest 設定，同樣不載入 web 那份。
 */
export default defineConfig({
  plugins: [react()],
  resolve: { alias: RESOLVE_ALIAS },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});

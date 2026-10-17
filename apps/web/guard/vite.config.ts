import { fileURLToPath, URL } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { RESOLVE_ALIAS } from '../resolve-alias';

/**
 * 瀏覽器護欄測試頁的打包設定（#1512）：只打包 `guard/main.tsx` 的 JS，輸出到 `guard/dist`（不出貨，`.gitignore` 的 `dist/`）。
 *
 * - **不掛 Tailwind**：測試頁量的是出貨 `dist` 那份 CSS，由 `guard/server.ts` 插進頁面。這裡再編一份，量到的就是測試頁版的 CSS。
 * - JS 放 `guard-assets/`，跟出貨的 `assets/`（CSS、字型）分開，伺服器才分得清誰是誰。
 * - **同樣不准開 dev／preview**（#426，理由見 `../vite.config.ts`）：這一份只拿來 build。
 */
export default defineConfig(({ command }) => {
  if (command === 'serve') {
    throw new Error(
      'guard/ 只 build 不開伺服器（#426）：用 `pnpm --filter @nexus/web run test:guard`。',
    );
  }
  return {
    root: fileURLToPath(new URL('.', import.meta.url)),
    plugins: [react()],
    // 同出貨那份（`../resolve-alias.ts`，#1523）：裸的 `cn` 也要解析到 `lib/utils.ts`，測試頁畫出來的 class 才跟出貨的一樣。
    resolve: { alias: RESOLVE_ALIAS },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      assetsDir: 'guard-assets',
    },
  };
});

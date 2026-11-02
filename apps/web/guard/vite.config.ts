import { fileURLToPath, URL } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';

import { RESOLVE_ALIAS } from '../resolve-alias';

const EMPTY_CSS = '\0guard-empty-css';

/**
 * 根目錄的 `tsconfig.base.json`。寫成絕對路徑：外掛的 `projects` 相對於 Vite 的 `root` 解析，這份的 `root` 是 `guard/`，
 * 照抄出貨那份的 `'../../tsconfig.base.json'` 會指到 `apps/` 底下不存在的檔，而外掛只印警告、不擋 build（#1642 實測）。
 */
export const BASE_TSCONFIG = fileURLToPath(new URL('../../../tsconfig.base.json', import.meta.url));

/** 測試頁不帶自己的樣式：所有 `.css` 的 import 解析成一個空的 JS 模組（見檔頭）。 */
const dropCss: Plugin = {
  name: 'guard-drop-css',
  enforce: 'pre',
  resolveId: (source) => (source.endsWith('.css') ? EMPTY_CSS : undefined),
  load: (id) => (id === EMPTY_CSS ? 'export {};' : undefined),
};

/**
 * 瀏覽器護欄測試頁的打包設定（#1512）：只打包 `guard/main.tsx` 的 JS，輸出到 `guard/dist`（不出貨，`.gitignore` 的 `dist/`）。
 *
 * - **不掛 Tailwind**：測試頁量的是出貨 `dist` 那份 CSS，由 `guard/server.ts` 插進頁面。這裡再編一份，量到的就是測試頁版的 CSS。
 * - **元件 import 的 CSS 換成空模組**（#1638）：`markdown-text.tsx` 的 `katex/dist/katex.min.css` 這類已經在出貨那份 CSS 裡
 *   （`main.tsx` 引入的元件樹同一棵），測試頁再打包一份就是自己帶了樣式，`server.ts` 會拒絕起來。
 * - **`@nexus/*` 經根 `tsconfig.base.json` 的 paths 解析到各套件的 `src`**（#1642）：同出貨那份（`../vite.config.ts`）。套件的
 *   exports 指到 `lib/` 之後（#1502），沒接的話乾淨樹（沒建 `lib/`）上 build 失敗，建過的話量到的是 `lib/` 產物、可能是舊的。
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
    plugins: [react(), dropCss, tsconfigPaths({ projects: [BASE_TSCONFIG] })],
    // 同出貨那份（`../resolve-alias.ts`，#1523）：裸的 `cn` 也要解析到 `lib/utils.ts`，測試頁畫出來的 class 才跟出貨的一樣。
    resolve: { alias: RESOLVE_ALIAS },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      assetsDir: 'guard-assets',
    },
  };
});

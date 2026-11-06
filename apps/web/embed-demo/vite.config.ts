import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

import { rejectStandaloneServe } from '../vite.config';

/**
 * 嵌入版 `<nexus-chat>` 的 Vue 測試頁（#2366）：一頁 Vite＋Vue，模擬可視化系統把元件放進自己的畫面。只給 e2e 用
 * （`embed.e2e.ts`、`public-mount.e2e.ts`），不出貨：產物建到 e2e 自己的暫存目錄，不進 `dist`（`package.json` 的 `files` 出貨整個 `dist`）。
 *
 * 資源掛在 `/vue-demo/` 底下，跟 serve 同源：`embed.e2e.ts` 開 serve 的 `/livez` 寫成這一頁，只有 `/vue-demo/assets/**` 用 `page.route` 供應；
 * `public-mount.e2e.ts` 由測試自己的代理供應。`embed.js` 由 serve 供應。`<nexus-chat>` 要告訴 Vue
 * 它是自訂元素，接入說明見 `docs/embed-chat.md`。
 */
export default defineConfig({
  root: import.meta.dirname,
  base: '/vue-demo/',
  plugins: [
    rejectStandaloneServe(),
    vue({ template: { compilerOptions: { isCustomElement: (tag) => tag === 'nexus-chat' } } }),
  ],
  build: { emptyOutDir: true },
});

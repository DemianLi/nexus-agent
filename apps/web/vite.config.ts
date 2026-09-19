import { fileURLToPath, URL } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';

/**
 * **網頁從來不由 Vite 服務**（[#426](https://github.com/DemianLi/nexus-agent/issues/426)，照 dsh
 * `apps/web/vite.config.ts` 的 `rejectStandaloneServe`）：dev 與 preview 一律拒絕啟動，網頁建成 `dist` 由 serve 服務。
 *
 * 部署主機是多人共用的。Vite 的 dev server 會把 workspace 根底下的任何檔案（`/@fs/…`）交給任何連得到那個 port
 * 的人——harness 原始碼、文件、放在 repo 裡的會話日誌都在內，serve 的會話認證（#424）管不到它。preview 雖然只
 * 服務 `dist`，仍是多一個行程、多一層 proxy，而且 index 不必登入就拿得到。dsh 擋的理由是它的 boot 資料只有 host
 * 注入得了，效果一樣：Vite 從來不開 port。
 *
 * Vite 在 preview 時傳給設定的 `command` 也是 `serve`，所以一條判斷擋兩個。vitest 載入設定時同樣是 `serve`，
 * 所以測試設定另放 `vitest.config.ts`，不經過這一份。
 */
const STANDALONE_ERROR =
  'apps/web 不由 Vite 服務（#426）：dev 與 preview 會把檔案交給同機任何人。' +
  '改用 `pnpm dev`（vite build --watch，建成 apps/web/dist），另開 `pnpm --filter @nexus/harness run serve`，' +
  '開它印出的網址；改了網頁等重建完、手動重新整理。';

function rejectStandaloneServe(): Plugin {
  return {
    name: 'nexus-reject-standalone-web-serve',
    config(_config, env) {
      if (env.command === 'serve') throw new Error(STANDALONE_ERROR);
    },
  };
}

export default defineConfig({
  plugins: [rejectStandaloneServe(), react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});

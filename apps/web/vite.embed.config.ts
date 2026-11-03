import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { readFile } from 'node:fs/promises';

import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';

import { embedShadowCss } from './embed-shadow-css';
import { RESOLVE_ALIAS } from './resolve-alias';
import { rejectStandaloneServe } from './vite.config';

/** 給宿主頁的型別照原樣放進產物（見下面的說明）。 */
function elementTypes(): Plugin {
  return {
    name: 'nexus-embed-element-types',
    async generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'nexus-chat.d.ts',
        source: await readFile(new URL('src/embed/nexus-chat.d.ts', import.meta.url), 'utf8'),
      });
    },
  };
}

/**
 * 嵌入版 `<nexus-chat>`（#2366）的建置：一支 `dist/embed.js`，跟網頁同一個 `dist`，由 serve 一起供應。
 *
 * - **不用 library 模式**：library 模式把字型一律內嵌成 base64（Noto Sans TC 的切片加 KaTeX）。一般模式的字型照常
 *   輸出到 `assets/`，內容雜湊跟網頁那一份相同，同一個檔。
 * - `base: './'`：產物裡的資源網址寫成 `new URL('assets/…', import.meta.url)`，從 `embed.js` 自己的位置算，不管宿主頁在哪個路徑。
 * - 不清空 `dist`：網頁那一份先建好，這裡只加 `embed.js`（`package.json` 的 `build` 照這個順序跑）。
 * - 只有一支檔（`inlineDynamicImports`）：宿主頁只放一個 `<script type="module">`。
 * - 樣式全部進 shadow root，改寫見 `embed-shadow-css.ts`。
 * - 給宿主頁的型別 `src/embed/nexus-chat.d.ts` 照原樣放到 `dist/nexus-chat.d.ts`，跟 `embed.js` 一起供應。
 */
export default defineConfig({
  base: './',
  plugins: [
    rejectStandaloneServe(),
    react(),
    tailwindcss(),
    tsconfigPaths({ projects: ['../../tsconfig.base.json'] }),
    ...embedShadowCss(),
    elementTypes(),
  ],
  resolve: { alias: RESOLVE_ALIAS },
  build: {
    emptyOutDir: false,
    assetsInlineLimit: 0,
    rollupOptions: {
      input: 'src/embed/index.ts',
      preserveEntrySignatures: 'strict',
      output: { format: 'es', entryFileNames: 'embed.js', inlineDynamicImports: true },
    },
  },
});

/**
 * `embed.js` 的入口（#2366，`vite.embed.config.ts`）：載入這支就註冊好 `<nexus-chat>`。
 *
 * 樣式在建置時改寫成 shadow root 用的與宿主頁 `<head>` 用的兩份（`embed-shadow-css.ts`）。KaTeX 的樣式在網頁那邊是
 * `markdown-text.tsx` 直接 import，embed 的建置把那一行換成空的，改在這裡收進 shadow root，順序同網頁（KaTeX 在前）。
 */
import katexCss, { documentCss as katexDocumentCss } from 'katex/dist/katex.min.css?inline';

import appCss, { documentCss as appDocumentCss } from '@/index.css?inline';

import { defineNexusChat } from './nexus-chat-element';

defineNexusChat({
  styles: {
    shadow: `${katexCss}\n${appCss}`,
    document: `${katexDocumentCss}\n${appDocumentCss}`,
  },
});

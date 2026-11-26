/**
 * `embed-mock.js` 的入口（#3175，`vite.embed.config.ts --mode mock`）：同 `index.ts` 註冊 `<nexus-chat>`，但接的是瀏覽器內的劇本 client，
 * 不打 serve。只給宿主頁本機開發用，不進 `dist`、serve 不供應。
 */
import katexCss, { documentCss as katexDocumentCss } from 'katex/dist/katex.min.css?inline';

import appCss, { documentCss as appDocumentCss } from '@/index.css?inline';

import { createMockClient } from './mock-client';
import { defineNexusChat } from './nexus-chat-element';

defineNexusChat({
  styles: {
    shadow: `${katexCss}\n${appCss}`,
    document: `${katexDocumentCss}\n${appDocumentCss}`,
  },
  createClient: () => createMockClient(),
  fetch: async () => new Response(null, { status: 501 }),
});

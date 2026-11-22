import { createApp } from 'vue';

import App from './App.vue';

createApp(App).mount('#app');

// 元件在 Vue 掛好之後才載入：`<nexus-chat>` 升級之前 Vue 已經設好的 `context` property 也要收得到。
// `?embed=` 換掉 `embed.js` 的位置，例如掛在子路徑底下的 `/nexus/embed.js`（`e2e/public-mount.e2e.ts`）。
const script = document.createElement('script');
script.type = 'module';
script.src = new URLSearchParams(location.search).get('embed') ?? '/embed.js';
document.head.append(script);

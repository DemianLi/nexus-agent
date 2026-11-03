import { createApp } from 'vue';

import App from './App.vue';

createApp(App).mount('#app');

// 元件在 Vue 掛好之後才載入：`<nexus-chat>` 升級之前 Vue 已經設好的 `context` property 也要收得到。
const script = document.createElement('script');
script.type = 'module';
script.src = '/embed.js';
document.head.append(script);

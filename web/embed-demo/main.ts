import { createApp } from 'vue';

import App from './App.vue';

createApp(App).mount('#app');

// 元件在 Vue 掛好之後才載入：`<nexus-chat>` 升級之前 Vue 已經設好的 `context` property 也要收得到。
// `?embed=` 換掉 `embed.js` 的位置，例如掛在子路徑底下的 `/nexus/embed.js`（`e2e/public-mount.e2e.ts`）。
const script = document.createElement('script');
script.type = 'module';
script.src = new URLSearchParams(location.search).get('embed') ?? '/embed.js';

// 模擬模式（#3175）的劇本範例：句子裡提到的設備編號，第一台轉過去，說到「標」就再高亮最後一台。
if (script.src.endsWith('/embed-mock.js')) {
  (globalThis as { nexusChatMock?: unknown }).nexusChatMock = {
    reply: ({ text }: { readonly text: string }) => {
      const ids = text.match(/[A-C]-\d{2}/gu) ?? [];
      if (ids.length === 0) return [{ say: '（模擬）句子裡帶個設備編號，例如「轉到 B-07」。' }];
      const steps: unknown[] = [
        { say: `轉到 ${ids[0]}。` },
        { tool: 'focus_device', args: { id: ids[0] } },
      ];
      if (text.includes('標')) steps.push({ tool: 'highlight_device', args: { id: ids.at(-1) } });
      return [...steps, { say: '（模擬）做完了。' }];
    },
  };
}
document.head.append(script);

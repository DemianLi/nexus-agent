import { fileURLToPath, URL } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * dev server 把 `/threads` 轉給 harness。
 *
 * **走代理而不是直接指到 `http://localhost:8787`**，是為了不要為了開發方便在 handler
 * 上開 CORS：那條線刻意只收 `application/json`，好逼出一個它從不回答的 preflight
 * （見開發計劃第 7 節決策 6）。同源之後這件事整個不存在。
 * 換 port 就設 `NEXUS_AGENT_URL`。
 */
const agentUrl = process.env.NEXUS_AGENT_URL ?? 'http://localhost:8787';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/threads': { target: agentUrl, changeOrigin: true },
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});

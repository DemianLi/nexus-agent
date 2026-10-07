import { defineConfig } from 'vitest/config';

/**
 * 這個套件的測試差不多都要起一個真的子行程（stdio MCP server，`node --import tsx …`）。
 * 啟動成本不在測試的邏輯裡，而在 `tsx` 的載入：本機約 0.5 秒，CI 的 runner 在其他套件併行時量到
 * 2.5–4.7 秒，貼著 vitest 預設的 5 秒。逾時一到，測試主體還在背景跑，`installProxyFromEnvironment`
 * 的 `dispose` 沒有照時序執行，下一個測試的子行程就繼承到還開著的代理——`http-proxy-egress.test.ts`
 * 的對照組因此從「逾時」連帶變成 `status 200`，看起來像兩個不相干的失敗。
 *
 * 所以整個套件一次放寬，而不是只放寬被撞到的那個測試：被撞到的每次都是不同的那一個。
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
  },
});

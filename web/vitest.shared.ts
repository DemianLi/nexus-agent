/**
 * web 每一份 vitest 設定共用的 `execArgv`（#1602 N1566），照 dsh `vitest.shared.ts:9`。
 *
 * Node 25 起 `localStorage`／`sessionStorage` 是行程全域，會遮住 jsdom 給的那一份（vitest 只覆蓋自己清單裡的全域鍵，
 * 清單裡沒有 `localStorage`）。開發機與 CI 的 Node 不同版，同一支測試就會靜靜用到不同的實作。這裡在支援這個旗標的
 * Node 上一律帶 `--no-webstorage`；22／24 沒有這個旗標，給空的。守衛是 `src/test-env.test.ts`。
 */
export const vitestExecArgv: string[] = process.allowedNodeEnvironmentFlags.has('--webstorage')
  ? ['--no-webstorage']
  : [];

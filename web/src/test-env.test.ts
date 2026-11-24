import { describe, expect, it } from 'vitest';

/**
 * 測試環境本身的守衛（#1602 N1566）：每條測試拿到的 `localStorage` 是 jsdom 的那一份，不是 Node 的行程全域。
 *
 * Node 25 起 `localStorage`／`sessionStorage` 是行程全域。vitest 裝 jsdom 的全域時，已經在 global 上的鍵只覆蓋它自己
 * 清單裡的（有 `Storage`、沒有 `localStorage`），所以 Node 先放了，jsdom 的那份就裝不上去。`vitest.shared.ts` 用
 * `--no-webstorage` 統一關掉 Node 那份，照 dsh `vitest.shared.ts:9`。
 *
 * **這個檔不 stub 任何東西**，比的是 vitest 掛在全域的 JSDOM 實例。不能拿 `window.localStorage` 比：vitest 把 `window`
 * 設成 `globalThis` 本身，那樣比恆真。22／24 沒有這個旗標，有沒有 `execArgv` 都綠；分得出對錯的是 Node 25 以後，
 * 所以這個檔列在 `.github/scripts/node-compat-files.txt`，由 node-compat 的 26 那一格守。
 */
const dom = (globalThis as unknown as { jsdom: { window: Window } }).jsdom;

describe('測試環境', () => {
  it('localStorage 是 jsdom 的那一份', () => {
    expect(localStorage).toBe(dom.window.localStorage);
  });

  it('sessionStorage 是 jsdom 的那一份', () => {
    expect(sessionStorage).toBe(dom.window.sessionStorage);
  });
});

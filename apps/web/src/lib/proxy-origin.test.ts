import { describe, expect, it } from 'vitest';

import { proxiedOrigin } from './proxy-origin.js';

const TARGET = 'http://localhost:8787';

/**
 * proxy 轉給 harness 時的 Origin 改寫（#387）。harness 那側的圍欄驗在 `apps/harness/src/request-trust.test.ts`。
 */
describe('proxiedOrigin', () => {
  it('Origin 等於瀏覽器連進來的那個 Host：換成 target 的來源', () => {
    expect(proxiedOrigin('http://localhost:5173', 'localhost:5173', TARGET)).toBe(TARGET);
    expect(proxiedOrigin('http://127.0.0.1:4173', '127.0.0.1:4173', TARGET)).toBe(TARGET);
  });

  it('比對走 WHATWG 正規化：大小寫與預設 port 不影響', () => {
    expect(proxiedOrigin('http://localhost', 'LocalHost:80', TARGET)).toBe(TARGET);
  });

  it('其他 Origin 原樣轉，讓 harness 照判', () => {
    expect(proxiedOrigin('http://evil.example', 'localhost:5173', TARGET)).toBeUndefined();
    expect(proxiedOrigin('http://localhost:3000', 'localhost:5173', TARGET)).toBeUndefined();
    expect(proxiedOrigin('null', 'localhost:5173', TARGET)).toBeUndefined();
  });

  it('沒有 Origin 或沒有 Host：不動', () => {
    expect(proxiedOrigin(undefined, 'localhost:5173', TARGET)).toBeUndefined();
    expect(proxiedOrigin('http://localhost:5173', undefined, TARGET)).toBeUndefined();
  });
});

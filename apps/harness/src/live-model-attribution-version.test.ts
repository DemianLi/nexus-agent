/**
 * `User-Agent` 的版號跟著 `harness-version.ts` 走（[#1562](https://github.com/DemianLi/nexus-agent/issues/1562)）。
 *
 * 這一條要 `vi.resetModules()` 加 `vi.doMock` 換掉 `harness-version.js`，所以自成一檔：reset 之後動態載入的插件拿到另一份
 * `@nexus/core`，跟靜態 import 的組裝對不上；跟起 serve／CLI 的測試放在同一支檔，那些測試在 native 下會建構失敗。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('./harness-version.js');
});

describe('身分的內容與來源', () => {
  it('版號跟著 harness-version 走：換掉那一份，UA 跟著變（寫死字串就紅）', async () => {
    vi.resetModules();
    vi.doMock('./harness-version.js', () => ({ HARNESS_VERSION: '9.8.7' }));
    const fresh = await import('./attribution.js');
    expect(fresh.userAgent()).toBe('nexus-agent/9.8.7 (+https://github.com/DemianLi/nexus-agent)');
  });
});

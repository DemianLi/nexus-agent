/**
 * 工具路徑對到工作區的那條規則（{@link virtualPathOf}、{@link hostPathOf}）。
 *
 * 這裡只釘字串規則本身。它跟真 backend 對不對得上，由 `apps/harness/src/virtual-path.test.ts`
 * 用真的 `ContainedFilesystemBackend` 寫檔來釘——core 不能相依 harness。
 */

import { describe, expect, it } from 'vitest';

import { hostPathOf, virtualPathOf } from './sandbox.js';

describe('virtualPathOf', () => {
  it('開頭有沒有 `/` 一樣，尾斜線去掉，根本身是 `/`', () => {
    expect(virtualPathOf('a/b.md')).toBe('/a/b.md');
    expect(virtualPathOf('/a/b.md')).toBe('/a/b.md');
    expect(virtualPathOf('/a/')).toBe('/a');
    expect(virtualPathOf('/')).toBe('/');
    expect(virtualPathOf('.')).toBe('/');
  });

  it('`..` 夾回根之內，不拋', () => {
    expect(virtualPathOf('a/../b.md')).toBe('/b.md');
    expect(virtualPathOf('../../etc/passwd')).toBe('/etc/passwd');
  });
});

describe('hostPathOf', () => {
  // 從 `@nexus/plugin-workspace-changes` 的 `capture.test.ts` 搬來（#693），原封不動。
  it('虛擬路徑對到工作區底下：開頭有沒有 `/` 一樣，`..` 夾回根之內', () => {
    expect(hostPathOf('/w', '/a/b.md')).toBe('/w/a/b.md');
    expect(hostPathOf('/w', 'a/b.md')).toBe('/w/a/b.md');
    expect(hostPathOf('/w', '/../../etc/passwd')).toBe('/w/etc/passwd');
  });

  it('根本身對到根；主機絕對路徑不被認出來，是根底下的一條子路徑', () => {
    expect(hostPathOf('/w', '/')).toBe('/w');
    expect(hostPathOf('/w', '/w/a.md')).toBe('/w/w/a.md');
  });
});

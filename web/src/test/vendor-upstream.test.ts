// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { isVendorUpstream, VENDOR_UPSTREAM_FILES } from './vendor-upstream';

const SRC = fileURLToPath(new URL('..', import.meta.url));

describe('護欄對 vendor 的放行（#1523）', () => {
  test('只放行 manifest 登記的上游原樣檔：同目錄我們自己的檔、產品的同名檔都不放行', () => {
    expect(isVendorUpstream(join(SRC, 'vendor/solid-glass/components/ui/button.tsx'))).toBe(true);
    expect(isVendorUpstream(join(SRC, 'vendor/solid-glass/shadcn/tailwind.css'))).toBe(true);
    expect(isVendorUpstream(join(SRC, 'vendor/solid-glass/sync.mjs'))).toBe(false);
    expect(isVendorUpstream(join(SRC, 'vendor/solid-glass/vendor.test.ts'))).toBe(false);
    expect(isVendorUpstream(join(SRC, 'vendor/solid-glass/components/ui/extra.tsx'))).toBe(false);
    expect(isVendorUpstream(join(SRC, 'components/ui/button.tsx'))).toBe(false);
  });

  test('名單不是空的（manifest 讀錯路徑時，放行會靜靜變成什麼都不放）', () => {
    expect([...VENDOR_UPSTREAM_FILES]).toContain('vendor/solid-glass/components/ui/button.tsx');
  });

  /** 放行的掃描都從 `vendor-upstream.ts` 取，不自己寫 vendor 的路徑：哪天搬目錄只改一處。 */
  test.each([
    'lib/utils.test.ts',
    'styles/design-system.test.ts',
    'styles/border-shadow.test.ts',
    'styles/type-hierarchy.test.ts',
  ])('%s 用共用的名單、不自己寫 vendor 的路徑', (file) => {
    const source = readFileSync(join(SRC, file), 'utf8');
    expect(source).toContain("from '@/test/vendor-upstream'");
    expect(source).not.toMatch(/['"`][^'"`\n]*vendor\//);
  });

  test('不放行的 live-region 沒有接上名單', () => {
    expect(readFileSync(join(SRC, 'styles/live-region.test.ts'), 'utf8')).not.toContain(
      'vendor-upstream',
    );
  });

  test('vendor 目錄裡確實有登記的檔（量具自檢）', () => {
    expect(readdirSync(join(SRC, 'vendor/solid-glass/components/ui')).length).toBeGreaterThan(0);
  });
});

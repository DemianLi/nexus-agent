import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * 右側欄是樞紐：`right-sidebar.tsx` 經 `right-sidebar-panels` 載入觀測與成本面板，面板與卡片又要取 `useRightSidebar` 與幾個契約型別。
 * 這兩個檔就是為了讓它們**不必 import 回側欄**而存在（#1127），所以它們自己也不能 import 任何元件，否則環又回來。
 * 這裡守的是這兩個檔的 import 清單，不是整張相依圖。
 */
function importsOf(file: string): readonly { spec: string; typeOnly: boolean }[] {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  return [...source.matchAll(/^import\s+(type\s+)?[^;]*?from\s+'([^']+)';/gm)].map((m) => ({
    spec: m[2]!,
    typeOnly: m[1] !== undefined,
  }));
}

describe('右側欄的 context 與契約型別不 import 回元件', () => {
  it.each(['./right-sidebar-context.ts', '../../lib/right-sidebar-api.ts'])('%s', (file) => {
    const imports = importsOf(file);
    // 量具自檢：讀得到 import（空清單會讓下面的斷言空過）。
    expect(imports.length).toBeGreaterThan(0);
    expect(
      imports.filter((i) => i.spec.startsWith('@/components/') || i.spec.startsWith('.')),
    ).toEqual([]);
  });

  it('契約型別檔只有型別 import，不帶任何執行期內容', () => {
    expect(importsOf('../../lib/right-sidebar-api.ts').filter((i) => !i.typeOnly)).toEqual([]);
  });
});

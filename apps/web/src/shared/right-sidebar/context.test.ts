import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * 分頁的面板與卡片要取 `useRightSidebar` 與幾個契約型別，側欄的殼（`app/right-sidebar/`）又要載入這些面板。
 * `context.ts` 與 `api.ts` 就是為了讓面板**不必 import 回側欄的殼**而存在（#1127）。它們不往上 import 由
 * `src/architecture.test.ts` 守；這裡守的是 `api.ts` 只有型別，載入它不會帶進任何分頁的執行期內容。
 */
function importsOf(file: string): readonly { spec: string; typeOnly: boolean }[] {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  return [...source.matchAll(/^import\s+(type\s+)?[^;]*?from\s+'([^']+)';/gm)].map((m) => ({
    spec: m[2]!,
    typeOnly: m[1] !== undefined,
  }));
}

describe('右側欄的契約型別檔', () => {
  it('只有型別 import，不帶任何執行期內容', () => {
    const imports = importsOf('./api.ts');
    // 量具自檢：讀得到 import（空清單會讓下面的斷言空過）。
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter((i) => !i.typeOnly)).toEqual([]);
  });
});

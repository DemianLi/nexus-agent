// @vitest-environment node
/**
 * 基礎元件與共用元件都有文件與預覽（規格 §13.5）：`COMPONENTS.md`「共用元件一覽」的基礎元件與 `ui/` 的檔一一對應，
 * 共用元件那張表寫的檔存在、匯出那個名字，預覽寫的子頁在 `guard/main.tsx` 裡存在。
 * 只驗子頁存在，不驗那一頁真的畫了這個元件。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';

import { describe, expect, test } from 'vitest';

const here = new URL('.', import.meta.url);
const doc = readFileSync(new URL('../../../COMPONENTS.md', here), 'utf8');
const guard = readFileSync(new URL('../../../guard/main.tsx', here), 'utf8');

const MAIN = '總覽';
const HEADING = '## 共用元件一覽';

const start = doc.indexOf(HEADING);
const section = doc.slice(start, doc.indexOf('\n## ', start + HEADING.length));
const [baseTable = '', sharedTable = ''] = section.split('\n### 共用元件');

const previewsOf = (cell: string) => cell.split('、').map((p) => p.replaceAll('`', '').trim());

const base = [...baseTable.matchAll(/^\| `([\w-]+)` \| (.+) \| (.+) \|$/gm)].map((m) => ({
  name: m[1] ?? '',
  use: m[2] ?? '',
  previews: previewsOf(m[3] ?? ''),
}));
const shared = [...sharedTable.matchAll(/^\| `(\w+)` \| `([\w./-]+)` \| (.+) \| (.+) \|$/gm)].map(
  (m) => ({
    name: m[1] ?? '',
    file: m[2] ?? '',
    use: m[3] ?? '',
    previews: previewsOf(m[4] ?? ''),
  }),
);
const components = readdirSync(here)
  .filter((file) => file.endsWith('.tsx') && !file.endsWith('.test.tsx'))
  .map((file) => file.slice(0, -'.tsx'.length))
  .sort();
const pages = new Set(
  [...guard.slice(guard.indexOf('function OverlayPage')).matchAll(/case '([\w-]+)':/g)].map(
    (m) => m[1] ?? '',
  ),
);

describe('共用元件一覽（COMPONENTS.md）', () => {
  test('量具自檢：讀得到兩張表、元件與子頁', () => {
    expect(start).toBeGreaterThan(-1);
    expect(base.length).toBeGreaterThan(20);
    expect(shared.length).toBeGreaterThan(3);
    expect(components.length).toBeGreaterThan(20);
    expect(pages.size).toBeGreaterThan(20);
  });

  test('`ui/` 的每個檔一列，沒有多的列，也沒有重複', () => {
    expect(base.map((row) => row.name).sort()).toEqual(components);
  });

  test('共用元件那張表寫的檔存在，而且匯出那個名字', () => {
    const wrong = shared.filter((row) => {
      const file = new URL(`../${row.file}`, here);
      return (
        !existsSync(file) ||
        !new RegExp(`export (function|const) ${row.name}\\b`).test(readFileSync(file, 'utf8'))
      );
    });
    expect(wrong.map((row) => `${row.name}（${row.file}）`)).toEqual([]);
  });

  test('每一列都寫了用在哪', () => {
    const rows = [...base, ...shared];
    expect(rows.filter((row) => row.use.trim().length < 4).map((row) => row.name)).toEqual([]);
  });

  test('每一列的預覽都是存在的測試頁', () => {
    const missing = [...base, ...shared].flatMap((row) =>
      row.previews.length === 0 || row.previews.some((p) => p !== MAIN && !pages.has(p))
        ? [`${row.name}：${row.previews.join('、')}`]
        : [],
    );
    expect(missing).toEqual([]);
  });
});

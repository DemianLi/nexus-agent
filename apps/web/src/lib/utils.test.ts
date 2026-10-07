// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import { cn } from '@/lib/utils';

const SRC = fileURLToPath(new URL('..', import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** `index.css` `@theme` 裡自訂的字級名：`--text-body: 14px;`（`--text-body--line-height` 不算）。 */
const TEXT_SIZES = [
  ...readFileSync(join(SRC, 'index.css'), 'utf8').matchAll(/^\s*--text-([a-z]+):\s*\d/gm),
].map((m) => m[1]!);

describe('cn 認得我們的字級名', () => {
  test('量得到 index.css 的四階（量具不是空的）', () => {
    expect(TEXT_SIZES).toEqual(['ui', 'body', 'tip', 'micro']);
  });

  test.each(TEXT_SIZES)('text-%s 是字級，不跟文字顏色互相吃掉（兩個順序都是）', (size) => {
    expect(cn(`text-${size}`, 'text-primary-foreground').split(' ').sort()).toEqual(
      [`text-${size}`, 'text-primary-foreground'].sort(),
    );
    expect(cn('text-muted-foreground', `text-${size}`).split(' ').sort()).toEqual(
      ['text-muted-foreground', `text-${size}`].sort(),
    );
  });

  test('同是字級的才互相取代：後面的贏，預設階與任意值也算', () => {
    expect(cn('text-tip', 'text-body')).toBe('text-body');
    expect(cn('text-sm', 'text-tip')).toBe('text-tip');
    expect(cn('text-body', 'lg:text-tip')).toBe('text-body lg:text-tip');
  });

  test('顏色之間照舊互相取代', () => {
    expect(cn('text-muted-foreground', 'text-foreground')).toBe('text-foreground');
  });
});

describe('cn 只有一個出口', () => {
  test('除了 lib/utils.ts，沒有檔案直接 import `cn` 套件（預設的 cn 不認得字級名）', () => {
    const direct = files(SRC)
      .filter((f) => !f.endsWith(join('lib', 'utils.ts')))
      .filter((f) =>
        /^import\b[^;]*\bfrom\s+['"]cn(?:\/[a-z]+)?['"]/m.test(readFileSync(f, 'utf8')),
      )
      .map((f) => relative(SRC, f));
    expect(direct).toEqual([]);
  });
});

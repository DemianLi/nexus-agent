// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

/**
 * `.docs/web-ui-spec.md` §11 第 1 條：邊緣畫在陰影裡，同一個元素不同時用 `border` 與陰影（§5）。
 *
 * 量的是原始碼裡的每一個字串字面值（className、cva 的各段、`cn(...)` 的參數都是字串）：同一個字串裡
 * 同時有「畫出邊線的 border utility」與「shadow utility」就報錯。只看顏色的 `border-input`、
 * `focus-visible:border-ring` 不算邊線；`border-0`、`shadow-none` 是拿掉，也不算。
 */

const SRC = fileURLToPath(new URL('..', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** 去掉 variant 前綴（`dark:`、`hover:`、`[&_svg]:`…）後的 utility 本體。 */
function utility(token: string): string {
  let depth = 0;
  let last = -1;
  for (let i = 0; i < token.length; i++) {
    if (token[i] === '[') depth++;
    else if (token[i] === ']') depth--;
    else if (token[i] === ':' && depth === 0) last = i;
  }
  return token.slice(last + 1).replace(/^!/, '');
}

const BORDER_LINE = /^border(-[xytrblse])?(-(?!0$)\d+|-\[[^\]]+px\])?$/;
const SHADOW = /^shadow(-.+)?$/;

function borderAndShadow(text: string): string | undefined {
  const utilities = text.split(/\s+/).map(utility);
  const border = utilities.find((u) => BORDER_LINE.test(u));
  const shadow = utilities.find((u) => SHADOW.test(u) && u !== 'shadow-none');
  return border && shadow ? `${border} ＋ ${shadow}` : undefined;
}

function violations(files: string[]): string[] {
  const found: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/(['"`])((?:(?!\1)[^\\\n]|\\.)*)\1/g)) {
      const hit = borderAndShadow(match[2] ?? '');
      if (hit === undefined) continue;
      const line = source.slice(0, match.index).split('\n').length;
      found.push(`${relative(SRC, file)}:${line}：${hit}`);
    }
  }
  return found;
}

describe('邊緣畫在陰影裡', () => {
  test('原始碼裡沒有同一個 className 同時用 border 與陰影', () => {
    expect(violations(sourceFiles(SRC))).toEqual([]);
  });

  test('判準認得邊線與陰影、不把顏色與拿掉算進去', () => {
    expect(borderAndShadow('rounded-lg border p-4 shadow-lg')).toBe('border ＋ shadow-lg');
    expect(borderAndShadow('border-b-2 shadow-material')).toBe('border-b-2 ＋ shadow-material');
    expect(borderAndShadow('dark:border hover:shadow-xs')).toBe('border ＋ shadow-xs');
    expect(
      borderAndShadow('border-input focus-visible:border-ring shadow-material'),
    ).toBeUndefined();
    expect(borderAndShadow('border-0 shadow-material')).toBeUndefined();
    expect(borderAndShadow('border shadow-none')).toBeUndefined();
    expect(borderAndShadow('[&_svg]:border-l bg-card')).toBeUndefined();
  });
});

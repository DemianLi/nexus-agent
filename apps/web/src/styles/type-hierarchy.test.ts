// @vitest-environment node
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import { jsxAttributes, tsxFiles } from '@/test/jsx-scan';

/**
 * 字級的主次（[#1281](https://github.com/DemianLi/nexus-agent/issues/1281)，規則在 `COMPONENTS.md`「字級的主次」）：
 * **可以點的、當標題的用 `text-ui`（13）；小字說明、附註、時間、計數用 `text-tip`（12）；內文 `text-body`（14）不變。**
 *
 * 這裡只守機械判得出來的那一半：**可點的元件不縮成小字**——下面 {@link CONTROLS} 這些 JSX 元素自己的 `className` 裡出現
 * `text-tip`／`text-micro` 就紅。「是不是標題」判不出來，靠 review。registry 元件的預設字級（`xs` 按鈕、側欄、cmdk、附件）
 * 是 registry 原文的改動，守在 `components/ui/registry-edits.test.ts`。
 *
 * 掃 JSX 語法樹（`@/test/jsx-scan`）；先用字串預篩，含 `text-tip` 或 `text-micro` 的檔才 parse。
 */

const SRC = fileURLToPath(new URL('..', import.meta.url));

/** 一按就有事的元件：按鈕、可展開列與其他觸發鈕、選單項。 */
const CONTROLS = new Set([
  'button',
  'Button',
  'RowTrigger',
  'CollapsibleTrigger',
  'PopoverTrigger',
  'DropdownMenuTrigger',
  'DropdownMenuItem',
  'CommandItem',
  'SidebarMenuButton',
  'SidebarMenuSubButton',
]);

const SMALL = /(?:^|:)text-(?:tip|micro)$/;

interface Hit {
  readonly file: string;
  readonly line: number;
  readonly tag: string;
  readonly what: string;
}

function smallControls(file: string, source: string): Hit[] {
  return jsxAttributes(file, source, 'className')
    .filter((attr) => CONTROLS.has(attr.tag))
    .flatMap((attr) =>
      attr.texts
        .flatMap((text) => text.split(/\s+/))
        .filter((token) => SMALL.test(token))
        .map((what) => ({ file: relative(SRC, file), line: attr.line, tag: attr.tag, what })),
    );
}

function scan(files: readonly string[]): Hit[] {
  return files.flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    return /text-(?:tip|micro)/.test(source) ? smallControls(file, source) : [];
  });
}

const files = tsxFiles(SRC);

describe('可點的元件不縮成小字（#1281）', () => {
  test('按鈕、觸發鈕、選單項自己的 className 沒有 text-tip／text-micro', () => {
    expect(scan(files).map((h) => `${h.file}:${h.line} <${h.tag}> ${h.what}`)).toEqual([]);
  });

  test('量具有掃到東西（不是空過）', () => {
    expect(files.length).toBeGreaterThan(80);
    expect(files.some((f) => f.endsWith('components/row-trigger.tsx'))).toBe(true);
  });

  test('判得出跨行的開頭標籤、cn() 的參數、樣板字串與三元；子元素與不可點的元素不算', () => {
    const hits = (source: string) =>
      smallControls('x.tsx', source).map((h) => `${h.tag} ${h.what}`);
    expect(
      hits(`<Button
        type="button"
        className="h-7 gap-1.5 px-2 text-tip has-[>svg]:px-1"
        onClick={() => go()}
      >x</Button>`),
    ).toEqual(['Button text-tip']);
    expect(hits(`<RowTrigger className={cn('gap-2', 'lg:text-tip')} />`)).toEqual([
      'RowTrigger lg:text-tip',
    ]);
    expect(hits('<button className={`px-2 text-micro ${tone}`} />')).toEqual(['button text-micro']);
    expect(hits(`<PopoverTrigger className={on ? 'text-ui' : 'text-tip'} />`)).toEqual([
      'PopoverTrigger text-tip',
    ]);
    expect(
      hits(`<Button className="text-ui"><span className="text-tip">3</span></Button>`),
    ).toEqual([]);
    expect(hits(`<p className="text-tip" />`)).toEqual([]);
    expect(hits(`<Button className="text-tipx" />`)).toEqual([]);
  });
});

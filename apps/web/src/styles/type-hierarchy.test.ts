// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, test } from 'vitest';

/**
 * 字級的主次（[#1281](https://github.com/DemianLi/nexus-agent/issues/1281)，規則在 `COMPONENTS.md`「字級」）：
 * **可以點的、當標題的用 `text-ui`（13）；小字說明、附註、時間、計數用 `text-tip`（12）；內文 `text-body`（14）不變。**
 *
 * 這裡只守機械判得出來的那一半：
 * 1. **可點的元件不縮成小字**：下面 {@link CONTROLS} 這些 JSX 元素自己的 `className` 裡出現 `text-tip`／`text-micro` 就紅。
 *    「是不是標題」判不出來，靠 review。
 * 2. **registry 元件的預設字級**：按鈕與下拉選單沒有小字；`xs` 按鈕、側欄 `sm` 選單鈕與群組標題、cmdk 群組標題是 `text-ui`。
 *
 * 掃的是 JSX 的語法樹，不是 regex：開頭標籤常常跨行，class 字串裡有 `has-[>svg]`，props 裡有 `=>`，掃到 `>` 為止會漏也會誤抓。
 * 先用字串預篩（含 `text-tip` 或 `text-micro` 的檔才 parse），全樹 parse 一次要好幾秒。
 */

const SRC = fileURLToPath(new URL('..', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [path] : [];
  });
}

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

/** `className` 值裡所有字串字面值的文字（含 `cn(...)` 的參數、樣板字串的固定段、三元的兩邊）。 */
function literalText(node: ts.Node): string[] {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isTemplateExpression(node)) {
    return [
      node.head.text,
      ...node.templateSpans.flatMap((span) => [...literalText(span.expression), span.literal.text]),
    ];
  }
  const out: string[] = [];
  node.forEachChild((child) => {
    out.push(...literalText(child));
  });
  return out;
}

interface Hit {
  readonly file: string;
  readonly line: number;
  readonly tag: string;
  readonly what: string;
}

function smallControls(file: string, source: string): Hit[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hits: Hit[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(sf);
      if (CONTROLS.has(tag)) {
        for (const attr of node.attributes.properties) {
          if (!ts.isJsxAttribute(attr) || attr.name.getText(sf) !== 'className') continue;
          if (attr.initializer === undefined) continue;
          for (const text of literalText(attr.initializer)) {
            for (const token of text.split(/\s+/)) {
              if (!SMALL.test(token)) continue;
              const { line } = sf.getLineAndCharacterOfPosition(attr.getStart(sf));
              hits.push({ file: relative(SRC, file), line: line + 1, tag, what: token });
            }
          }
        }
      }
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return hits;
}

function scan(files: readonly string[]): Hit[] {
  return files.flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    return /text-(?:tip|micro)/.test(source) ? smallControls(file, source) : [];
  });
}

/** 拿掉註解：檔頭講到類別名不算。 */
const code = (path: string) =>
  readFileSync(join(SRC, path), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const files = sourceFiles(SRC);

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

describe('registry 元件的預設字級（#1281）', () => {
  test('按鈕與下拉選單沒有小字：xs 按鈕也是 text-ui', () => {
    for (const path of ['components/ui/button.tsx', 'components/ui/dropdown-menu.tsx']) {
      expect(code(path), path).not.toMatch(/text-(?:tip|micro)\b/);
    }
    expect(code('components/ui/button.tsx')).toMatch(/xs: "h-6 [^"]*\btext-ui\b/);
  });

  test('側欄的群組標題與 sm 選單鈕、cmdk 的群組標題是 text-ui', () => {
    const sidebar = code('components/ui/sidebar.tsx');
    expect(sidebar).toMatch(/data-sidebar="group-label"[\s\S]{0,200}\btext-ui\b/);
    expect(sidebar).toContain("sm: 'h-7 text-ui'");
    expect(sidebar).toContain("size === 'sm' && 'text-ui'");
    expect(code('components/ui/command.tsx')).toContain('[&_[cmdk-group-heading]]:text-ui');
  });
});

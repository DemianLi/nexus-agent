// @vitest-environment node
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import { jsxAttributes, tsxFiles } from '@/test/jsx-scan';

/**
 * `role="status"` 只有狀態列能掛（[#1290](https://github.com/DemianLi/nexus-agent/issues/1290)，規格 §8「螢幕閱讀器」）：
 * 代理的現況（待決、串流、失敗）由 `status-line.tsx` 唸，其他地方要開 live region 得列進 {@link ALLOWED} 寫理由，
 * 也寫進規格 §8 的例外清單。
 *
 * 掃 JSX 語法樹（`@/test/jsx-scan`）上每個元素的 `role` 屬性：值裡任何一個字串字面值是 `status` 就算，
 * 所以 `role={busy ? 'status' : undefined}` 也抓得到。連 `ui/` 一起掃：registry 重裝可能帶進新的。
 */

const SRC = fileURLToPath(new URL('..', import.meta.url));

/** 狀態列本身：全站唸代理現況的那一格。 */
const STATUS_LINE = 'components/status-line.tsx';

interface Allowed {
  readonly file: string;
  readonly why: string;
}

/** 狀態列以外准掛的。**只能變少**：列了卻不再命中的會紅。 */
const ALLOWED: readonly Allowed[] = [
  {
    file: 'components/sidebar/thread-list.tsx',
    why: '搜尋結果：人自己打的字、焦點留在搜尋框，結果在別處，「沒有結果」不唸就不知道（WCAG 4.1.3）。搜尋框在它就在、內容之後才填',
  },
  {
    file: 'components/trace/panel.tsx',
    why: '「看這一輪」與定位的結果：人自己按的，找不到或還在拉時焦點沒有地方落。觀測分頁常駐的唯一一格',
  },
];

interface Hit {
  readonly file: string;
  readonly line: number;
  readonly tag: string;
}

function statusRoles(file: string, source: string): Hit[] {
  return jsxAttributes(file, source, 'role')
    .filter((attr) => attr.texts.some((text) => text.trim() === 'status'))
    .map((attr) => ({ file: relative(SRC, file), line: attr.line, tag: attr.tag }));
}

const files = tsxFiles(SRC);
const all = files.flatMap((file) => {
  const source = readFileSync(file, 'utf8');
  return /\bstatus\b/.test(source) ? statusRoles(file, source) : [];
});
const outside = all.filter((hit) => hit.file !== STATUS_LINE);

describe('role="status" 只有狀態列（#1290）', () => {
  test('狀態列以外沒有 role="status"（例外見 ALLOWED）', () => {
    const open = outside.filter((hit) => !ALLOWED.some((a) => a.file === hit.file));
    expect(open.map((hit) => `${hit.file}:${hit.line} <${hit.tag}>`)).toEqual([]);
  });

  test('每個例外檔只有一格，而且都還有命中', () => {
    for (const { file } of ALLOWED) {
      expect(outside.filter((hit) => hit.file === file).length, file).toBe(1);
    }
  });

  test('每條例外都寫了理由', () => {
    expect(ALLOWED.filter((a) => a.why.trim() === '')).toEqual([]);
  });

  test('量具有掃到東西：狀態列本身被抓到，ui/ 也在掃的範圍', () => {
    expect(all.some((hit) => hit.file === STATUS_LINE)).toBe(true);
    expect(files.some((f) => relative(SRC, f).startsWith('components/ui/'))).toBe(true);
  });

  test('判得出字面值、三元與 JSX 表達式；別的 role 與 aria-live 不算', () => {
    const tags = (source: string) => statusRoles('x.tsx', source).map((hit) => hit.tag);
    expect(tags(`<p role="status">x</p>`)).toEqual(['p']);
    expect(tags(`<div\n  className="a"\n  role={busy ? 'status' : undefined}\n/>`)).toEqual([
      'div',
    ]);
    expect(tags(`<span role={'status'} />`)).toEqual(['span']);
    expect(tags(`<p role="alert" />`)).toEqual([]);
    expect(tags(`<p aria-live="polite" />`)).toEqual([]);
    expect(tags(`<p role="statusbar" />`)).toEqual([]);
  });
});

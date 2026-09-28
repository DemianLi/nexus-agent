import type { FileReferenceCandidate } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { applyMentionPick, detectMention, formatMention, mentionRows } from '@/lib/file-mention';
import { detectSlash } from '@/lib/slash-trigger';

/** `@` 引用的觸發與插入（#653），照 dsh `grammar.ts` 的 `activeAtToken`／`formatFileMention`。 */

const file = (path: string): FileReferenceCandidate => ({ path, kind: 'file' });
const dir = (path: string): FileReferenceCandidate => ({ path, kind: 'directory' });
const at = (draft: string) => detectMention(draft, draft.length);

describe('觸發', () => {
  it('行首、空白後、換行後的 @ 會開', () => {
    expect(at('@')).toEqual({ query: '', quoted: false, start: 0, end: 1 });
    expect(at('看 @src/')).toEqual({ query: 'src/', quoted: false, start: 2, end: 7 });
    expect(at('第一行\n@alp')?.query).toBe('alp');
  });

  it.each([['a@b'], ['user@host'], ['(@x'], ['＠src'], ['看 @src 之後']])('%s 不開', (draft) => {
    expect(at(draft)).toBeNull();
  });

  it('@" 開頭的可以跨空白；引號收掉之後就不是這一段了', () => {
    expect(at('@"/a b')).toEqual({ query: '/a b', quoted: true, start: 0, end: 6 });
    expect(at('@"/a b.md" ')).toBeNull();
  });

  it('游標在片段中間時只算游標前那一段', () => {
    expect(detectMention('@src/alpha.ts', 4)?.query).toBe('src');
  });

  it('@/ 是一段路徑：@ 先判，斜線那一支看不到它', () => {
    expect(at('@/')?.query).toBe('/');
    // 斜線自己仍然會認這一段——所以輸入框一定要先問 @（`composer.tsx`）。
    expect(detectSlash('@/', 2)).not.toBeNull();
  });
});

describe('插入的字', () => {
  it('路徑以 / 開頭；資料夾補 /；有空白就用引號', () => {
    expect(formatMention(file('/src/alpha.ts'), false, false)).toBe('@/src/alpha.ts');
    expect(formatMention(dir('/docs'), false, false)).toBe('@/docs/');
    expect(formatMention(file('/a b.md'), false, false)).toBe('@"/a b.md"');
  });

  it('往下鑽時引號形式的資料夾留著開口；選定時收掉', () => {
    expect(formatMention(dir('/a b'), false, true)).toBe('@"/a b/');
    expect(formatMention(dir('/a b'), false, false)).toBe('@"/a b/"');
  });

  it('打了 @" 的就留著引號，沒空白也一樣', () => {
    expect(formatMention(file('/src/a.ts'), true, false)).toBe('@"/src/a.ts"');
  });

  it('路徑有雙引號或控制字元寫不回草稿', () => {
    expect(formatMention(file('/a"b.md'), false, false)).toBeUndefined();
    expect(formatMention(file('/a\u0007.md'), false, false)).toBeUndefined();
    expect(formatMention(file('/a\u0085.md'), false, false)).toBeUndefined();
  });
});

describe('選了之後', () => {
  it('檔案：換成 @/path 加一個空白，後面的字留著', () => {
    const draft = '看 @alp 然後';
    const hit = detectMention(draft, 6)!;
    expect(applyMentionPick(draft, hit, file('/src/alpha.ts'), 'pick')).toEqual({
      draft: '看 @/src/alpha.ts  然後',
      caret: 17,
      drill: false,
    });
  });

  it('資料夾按 Enter 換成 @/docs/ 加空白；按 Tab 換成 @/docs/、不加空白、選單留著', () => {
    const hit = at('@do')!;
    expect(applyMentionPick('@do', hit, dir('/docs'), 'pick')).toEqual({
      draft: '@/docs/ ',
      caret: 8,
      drill: false,
    });
    expect(applyMentionPick('@do', hit, dir('/docs'), 'drill')).toEqual({
      draft: '@/docs/',
      caret: 7,
      drill: true,
    });
  });

  it('檔案按 Tab 就是選定', () => {
    expect(applyMentionPick('@al', at('@al')!, file('/alpha.ts'), 'drill')).toEqual({
      draft: '@/alpha.ts ',
      caret: 11,
      drill: false,
    });
  });

  it('有空白的路徑插入 @"/a b.md"', () => {
    expect(applyMentionPick('@a', at('@a')!, file('/a b.md'), 'pick')?.draft).toBe('@"/a b.md" ');
  });

  it('寫不回草稿的不改', () => {
    expect(applyMentionPick('@a', at('@a')!, file('/a"b'), 'pick')).toBeUndefined();
  });
});

describe('選單上的列', () => {
  it('名字加父目錄；工作區根的沒有父目錄；寫不回草稿的不列', () => {
    expect(
      mentionRows([file('/src/alpha.ts'), dir('/docs'), file('/a"b.md'), dir('/src/lib')], false),
    ).toEqual([
      { candidate: file('/src/alpha.ts'), name: 'alpha.ts', parent: '/src' },
      { candidate: dir('/docs'), name: 'docs/' },
      { candidate: dir('/src/lib'), name: 'lib/', parent: '/src' },
    ]);
  });
});

// @vitest-environment node
import type { SlashDescriptor } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { applySlashPick, detectSlash, rankByName, slashCandidates } from '@/lib/slash-trigger';

/**
 * `/` 選單的純邏輯（#407）。觸發的案例照 dsh `ui-input-trigger/tests/core-detect.client.spec.ts` 的 `/` 那幾條，
 * 排序照 `ui-primitives/tests/rank-by-name.client.spec.ts`（本機 clone `ddefc45`；nexus 的命令沒有 label，
 * label 那條不搬）。
 */

const atEnd = (draft: string) => detectSlash(draft, draft.length);

describe('detectSlash', () => {
  it('字首、空白、換行、標點後面都開', () => {
    expect(atEnd('/go')).toMatchObject({ query: 'go', position: 'leading', start: 0, end: 3 });
    expect(atEnd('say /co')).toMatchObject({ query: 'co', position: 'inline' });
    expect(atEnd('line1\n/go')).toMatchObject({ query: 'go', position: 'inline' });
    expect(atEnd('see (/go')).toMatchObject({ query: 'go' });
  });

  it('接在字後面不開', () => {
    expect(atEnd('a/b')).toBeNull();
    expect(atEnd('路徑/檔名')).toBeNull();
  });

  it('網址裡的斜線不開', () => {
    expect(atEnd('https://example')).toBeNull();
    expect(atEnd('see https://example')).toBeNull();
    expect(atEnd('https://a.b/c/d')).toBeNull();
    expect(atEnd('C:/path')).toBeNull();
  });

  it('冒號不是 scheme 分隔時照開', () => {
    expect(atEnd('note: /go')).toMatchObject({ query: 'go' });
    expect(atEnd(':/go')).toMatchObject({ query: 'go' });
  });

  it('往左掃到空白就停：參數打到一半不算', () => {
    expect(atEnd('/goal x')).toBeNull();
  });

  it('前面只有空白與換行時是 leading', () => {
    expect(atEnd('\n\n/goal')).toMatchObject({ position: 'leading' });
    expect(atEnd('  \n /goal')).toMatchObject({ position: 'leading' });
    expect(atEnd('第一行\n/goal')).toMatchObject({ position: 'inline' });
  });

  it('游標在片段中間時查詢切在游標', () => {
    expect(detectSlash('/goal', 3)).toMatchObject({ query: 'go', start: 0, end: 3 });
    expect(detectSlash('', 0)).toBeNull();
    expect(detectSlash('/goal', 0)).toBeNull();
  });
});

const named = (...names: string[]) => names.map((name) => ({ name }));
const names = (items: readonly { name: string }[]) => items.map((item) => item.name);

describe('rankByName', () => {
  it('空字串原樣回傳', () => {
    const items = named('b', 'a');
    expect(rankByName(items, '')).toBe(items);
  });

  it('不分大小寫的子序列；開頭、邊界、相鄰、跳格、原順序依序排', () => {
    const items = named(
      'q-xylophone',
      'qx-long',
      'fabulous',
      'foo-bar',
      'zuv',
      'zu1v',
      'yu1v',
      'zu12v',
    );
    expect(names(rankByName(items, 'QX'))).toEqual(['qx-long', 'q-xylophone']);
    expect(names(rankByName(items, 'fb'))).toEqual(['foo-bar', 'fabulous']);
    expect(names(rankByName(items, 'uv'))).toEqual(['zuv', 'zu1v', 'yu1v', 'zu12v']);
    expect(names(rankByName(items, 'zzz'))).toEqual([]);
    expect(names(rankByName(items, 'query-longer-than-every-name'))).toEqual([]);
  });

  it('開頭命中勝過分數更高的非開頭', () => {
    expect(names(rankByName(named('z_a_b', 'xabc'), 'ab'))).toEqual(['z_a_b', 'xabc']);
    expect(names(rankByName(named('z_a_b', 'abc'), 'ab'))).toEqual(['abc', 'z_a_b']);
  });

  it('同一個字取相鄰與跳格裡較好的那個', () => {
    expect(names(rankByName(named('aab', 'ab'), 'ab'))).toEqual(['ab', 'aab']);
  });
});

const plan: SlashDescriptor = { name: 'plan', description: '計劃模式', input: { hint: '[off]' } };
const feedback: SlashDescriptor = { name: 'feedback', description: '回饋' };

describe('slashCandidates', () => {
  it('leading 列全部；inline 只列不帶參數的', () => {
    expect(names(slashCandidates([plan, feedback], atEnd('/')!))).toEqual(['plan', 'feedback']);
    expect(names(slashCandidates([plan, feedback], atEnd('嗨 /')!))).toEqual(['feedback']);
  });

  it('有打字時照 rankByName', () => {
    expect(names(slashCandidates([plan, feedback], atEnd('/f')!))).toEqual(['feedback']);
  });
});

describe('applySlashPick', () => {
  it('有裝飾的命令即使帶參數也直接執行（照 dsh：裝飾先判）', () => {
    const decorated = { ...feedback, input: { hint: '<內容>' } };
    expect(applySlashPick('/fe', atEnd('/fe')!, decorated, new Set(['feedback']))).toEqual({
      draft: '',
      caret: 0,
      run: '/feedback',
    });
    expect(applySlashPick('/fe', atEnd('/fe')!, decorated)).toEqual({
      draft: '/feedback ',
      caret: 10,
    });
  });

  it('帶參數：填上 `/名稱 ` 等人打，不執行', () => {
    expect(applySlashPick('/pl', atEnd('/pl')!, plan)).toEqual({ draft: '/plan ', caret: 6 });
  });

  it('不帶參數：從草稿拿掉那一段、執行', () => {
    expect(applySlashPick('/fe', atEnd('/fe')!, feedback)).toEqual({
      draft: '',
      caret: 0,
      run: '/feedback',
    });
    expect(applySlashPick('先記一下 /fe', atEnd('先記一下 /fe')!, feedback)).toEqual({
      draft: '先記一下 ',
      caret: 5,
      run: '/feedback',
    });
  });
});

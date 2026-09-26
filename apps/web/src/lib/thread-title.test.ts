import type { ThreadSummary } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import {
  BLANK_THREAD_LABEL,
  documentTitle,
  headerTitle,
  PRODUCT_TITLE,
  threadLabel,
  UNTITLED_THREAD_LABEL,
  withCurrentTitle,
} from '@/lib/thread-title';

describe('threadLabel', () => {
  it.each<[string | null | undefined, boolean, string]>([
    ['改登入頁', false, '改登入頁'],
    ['改登入頁', true, '改登入頁'],
    [null, true, BLANK_THREAD_LABEL],
    [undefined, true, BLANK_THREAD_LABEL],
    [null, false, UNTITLED_THREAD_LABEL],
    ['', false, UNTITLED_THREAD_LABEL],
  ])('標題 %j、空白 %s → %s', (title, blank, label) => {
    expect(threadLabel(title, blank)).toBe(label);
  });
});

describe('headerTitle', () => {
  it('還沒連上又什麼都沒有：寫產品名，不先閃「新會話」', () => {
    expect(headerTitle(null, true, false)).toBe(PRODUCT_TITLE);
  });

  it('連上之後照列表的規則', () => {
    expect(headerTitle(null, true, true)).toBe(BLANK_THREAD_LABEL);
    expect(headerTitle(null, false, true)).toBe(UNTITLED_THREAD_LABEL);
  });

  it('斷線時手上已經有的照寫', () => {
    expect(headerTitle('改登入頁', false, false)).toBe('改登入頁');
    expect(headerTitle(null, false, false)).toBe(UNTITLED_THREAD_LABEL);
  });
});

it('documentTitle：照 dsh「標題 — 產品名」，沒有標題只寫產品名', () => {
  expect(documentTitle('改登入頁')).toBe(`改登入頁 — ${PRODUCT_TITLE}`);
  expect(documentTitle(null)).toBe(PRODUCT_TITLE);
  expect(documentTitle('')).toBe(PRODUCT_TITLE);
});

describe('withCurrentTitle', () => {
  const items: readonly ThreadSummary[] = [
    { threadId: '目前', updatedAt: 2, running: false, blank: true },
    { threadId: '別條', updatedAt: 1, running: false, blank: false, title: '別條的標題' },
  ];

  it('只蓋目前這一列，並不再算空白；別列照快照', () => {
    const next = withCurrentTitle(items, '目前', '新標題');
    expect(next[0]).toEqual({
      threadId: '目前',
      updatedAt: 2,
      running: false,
      blank: false,
      title: '新標題',
    });
    expect(next[1]).toBe(items[1]);
  });

  it('沒有標題時原樣回傳', () => {
    expect(withCurrentTitle(items, '目前', null)).toBe(items);
    expect(withCurrentTitle(items, '目前', '')).toBe(items);
  });
});

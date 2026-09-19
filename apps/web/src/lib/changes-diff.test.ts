import type { WorkspaceFileDiff } from '@nexus/wire';
import { changesDiffPath } from '@nexus/wire';
import { describe, expect, it, vi } from 'vitest';

import { createChangesDiffStore, isFileDiff } from '@/lib/changes-diff';

/** 比較的讀取（#443 web 第二刀，同 dsh `ChangesDiffStore`）：404 不再讀、其他失敗可以重讀。 */

const DIFF: WorkspaceFileDiff = {
  kind: 'text',
  path: 'a.ts',
  display: 'a.ts',
  before: true,
  after: true,
  hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }],
  coarse: false,
};

function storeWith(...responses: (() => Response | Promise<Response>)[]) {
  const urls: string[] = [];
  const inits: (RequestInit | undefined)[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    urls.push(String(url));
    inits.push(init);
    const respond = responses[Math.min(urls.length, responses.length) - 1]!;
    return respond();
  }) as unknown as typeof globalThis.fetch;
  const store = createChangesDiffStore({ threadId: 't 1', baseUrl: 'http://h/', fetch });
  return { store, urls, inits };
}

/** 讀一次，等它落地。 */
async function settle(load: () => void) {
  load();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const ok = () => new Response(JSON.stringify(DIFF));

describe('比較的讀取', () => {
  it('打 thread 底下的比較路由，帶 seq、index 與 content-type', async () => {
    const { store, urls, inits } = storeWith(ok);
    await settle(() => store.load(7, 2));
    expect(urls).toEqual([`http://h${changesDiffPath('t 1')}?seq=7&index=2`]);
    expect(inits[0]?.method).toBe('GET');
    expect(inits[0]?.headers).toEqual({ 'content-type': 'application/json' });
    expect(store.read(7, 2)).toEqual(DIFF);
  });

  it('讀到了就留著：同一個 (seq, index) 不再讀，別的 index 另外讀', async () => {
    const { store, urls } = storeWith(ok);
    await settle(() => store.load(7, 0));
    await settle(() => store.load(7, 0));
    expect(urls).toHaveLength(1);
    await settle(() => store.load(7, 1));
    expect(urls).toHaveLength(2);
  });

  it('404 是 missing，不再讀', async () => {
    const { store, urls } = storeWith(() => new Response('gone', { status: 404 }));
    await settle(() => store.load(7, 0));
    expect(store.read(7, 0)).toBe('missing');
    await settle(() => store.load(7, 0));
    expect(urls).toHaveLength(1);
  });

  it.each([
    ['500', () => new Response('boom', { status: 500 })],
    ['400', () => new Response('bad', { status: 400 })],
    ['斷線', () => Promise.reject(new TypeError('network'))],
    ['形狀不對', () => new Response(JSON.stringify({ kind: 'text', path: 'a' }))],
  ])('%s 是 error，下一次 load 會重讀', async (_name, fail) => {
    const { store, urls } = storeWith(fail, ok);
    await settle(() => store.load(7, 0));
    expect(store.read(7, 0)).toBe('error');
    await settle(() => store.load(7, 0));
    expect(urls).toHaveLength(2);
    expect(store.read(7, 0)).toEqual(DIFF);
  });

  it('讀的時候是 loading，通知訂閱者', async () => {
    const { store } = storeWith(ok);
    const listener = vi.fn();
    store.subscribe(listener);
    store.load(7, 0);
    expect(store.read(7, 0)).toBe('loading');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('比較的形狀檢查', () => {
  it('認得三種', () => {
    expect(isFileDiff(DIFF)).toBe(true);
    expect(isFileDiff({ kind: 'binary', path: 'a', display: 'a' })).toBe(true);
    expect(isFileDiff({ kind: 'oversized', path: 'a', display: 'a' })).toBe(true);
  });

  it.each([
    ['null', null],
    ['沒有路徑', { ...DIFF, path: '' }],
    ['不認得的 kind', { ...DIFF, kind: 'image' }],
    ['少了 coarse', { ...DIFF, coarse: undefined }],
    ['行沒有前綴', { ...DIFF, hunks: [{ ...DIFF.hunks[0], lines: ['a'] }] }],
    ['行號是負的', { ...DIFF, hunks: [{ ...DIFF.hunks[0], oldStart: -1 }] }],
  ])('%s：不認', (_name, value) => {
    expect(isFileDiff(value)).toBe(false);
  });
});

import type { DeliverableFilePage } from '@nexus/wire';
import { describe, expect, it, vi } from 'vitest';

import { createDeliverableFileStore, isFilePage } from '@/lib/deliverable-file';

/**
 * 交付檔預覽的讀取（#452 web 第二刀）。
 *
 * **每個狀態碼一條**：這一組的價值全在「分得出來」。攤平成「讀不到」的話，四個錯掉的對應關係
 * 底下它照樣綠。
 */

const PAGE: DeliverableFilePage = {
  path: 'out/report.md',
  version: 'v1',
  bytes: 12,
  offset: 0,
  text: '第一段\n',
  lines: 1,
  eof: false,
};

function storeWith(respond: (url: string) => Response) {
  const calls: string[] = [];
  const doFetch = vi.fn(async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return respond(String(input));
  }) as unknown as typeof globalThis.fetch;
  return {
    calls,
    doFetch,
    store: createDeliverableFileStore({ threadId: 't1', baseUrl: '', fetch: doFetch }),
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** 讀一次並等它落地。 */
async function load(store: ReturnType<typeof storeWith>['store'], seq = 1, index = 0, offset = 0) {
  store.load(seq, index, offset);
  await vi.waitFor(() => expect(store.read(seq, index, offset)).not.toBe('loading'));
  return store.read(seq, index, offset);
}

describe('交付檔的讀取', () => {
  it('200 回的是那一頁本身', async () => {
    const { store } = storeWith(() => json(PAGE));
    expect(await load(store)).toEqual(PAGE);
  });

  it.each([
    [400, 'invalid'],
    [404, 'missing'],
    [413, 'too-large'],
    [422, 'binary'],
    [500, 'error'],
  ])('%i 對到 %s', async (status, expected) => {
    const { store } = storeWith(() => new Response('nope', { status }));
    expect(await load(store)).toBe(expected);
  });

  it('斷線與形狀不對都是可重試的 error', async () => {
    const boom = createDeliverableFileStore({
      threadId: 't1',
      baseUrl: '',
      fetch: (() => Promise.reject(new Error('斷了'))) as unknown as typeof globalThis.fetch,
    });
    boom.load(1, 0, 0);
    await vi.waitFor(() => expect(boom.read(1, 0, 0)).toBe('error'));

    const { store } = storeWith(() => json({ path: 'a', version: '' }));
    expect(await load(store)).toBe('error');
  });

  it('只有 error 會再打一次；四種終局不會', async () => {
    const { store, doFetch } = storeWith(() => new Response('', { status: 500 }));
    await load(store);
    expect(doFetch).toHaveBeenCalledTimes(1);
    // 可重試：再叫一次真的會再發。
    await load(store);
    expect(doFetch).toHaveBeenCalledTimes(2);

    for (const status of [400, 404, 413, 422]) {
      const each = storeWith(() => new Response('', { status }));
      await load(each.store);
      each.store.load(1, 0, 0);
      expect(each.doFetch).toHaveBeenCalledTimes(1);
    }
  });

  it('不送 limit —— 每頁幾行由路由決定', async () => {
    const { store, calls } = storeWith(() => json(PAGE));
    await load(store, 7, 2, 30);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('seq=7');
    expect(calls[0]).toContain('index=2');
    expect(calls[0]).toContain('offset=30');
    expect(calls[0]).not.toContain('limit');
  });

  it('頁是快取的單位：同一個檔不同 offset 各讀一次', async () => {
    const { store, doFetch } = storeWith(() => json(PAGE));
    await load(store, 1, 0, 0);
    await load(store, 1, 0, 40);
    expect(doFetch).toHaveBeenCalledTimes(2);
    // 讀過的那一頁不再發。
    store.load(1, 0, 0);
    expect(doFetch).toHaveBeenCalledTimes(2);
  });

  it('version 換了就丟掉同一個檔其他版本的頁（#452）', async () => {
    let version = 'v1';
    const { store } = storeWith((url) =>
      json({ ...PAGE, version, offset: url.includes('offset=40') ? 40 : 0 }),
    );
    await load(store, 1, 0, 0);
    expect(store.read(1, 0, 0)).toMatchObject({ version: 'v1' });

    // 檔在兩次翻頁之間被改掉了：第二頁回的是 v2。
    version = 'v2';
    await load(store, 1, 0, 40);
    // **第一頁必須不見**——留著就會把 v1 的上半段接上 v2 的下半段，拼出一份從來不存在的檔。
    expect(store.read(1, 0, 0)).toBeUndefined();
    expect(store.read(1, 0, 40)).toMatchObject({ version: 'v2' });
  });

  it('version 沒換就不動其他頁', async () => {
    const { store } = storeWith((url) =>
      json({ ...PAGE, offset: url.includes('offset=40') ? 40 : 0 }),
    );
    await load(store, 1, 0, 0);
    await load(store, 1, 0, 40);
    expect(store.read(1, 0, 0)).toMatchObject({ version: 'v1', offset: 0 });
  });

  it('別的檔的頁不受 version 汰換影響', async () => {
    let version = 'v1';
    const { store } = storeWith(() => json({ ...PAGE, version }));
    await load(store, 1, 0, 0);
    version = 'v2';
    await load(store, 2, 0, 0);
    expect(store.read(1, 0, 0)).toMatchObject({ version: 'v1' });
  });
});

describe('形狀檢查', () => {
  it('缺欄位、型別不對、version 是空字串都不算', () => {
    expect(isFilePage(PAGE)).toBe(true);
    expect(isFilePage({ ...PAGE, version: '' })).toBe(false);
    expect(isFilePage({ ...PAGE, lines: -1 })).toBe(false);
    expect(isFilePage({ ...PAGE, eof: 'yes' })).toBe(false);
    expect(isFilePage(null)).toBe(false);
  });

  it('version 的長相不管——契約只有「內容換了就換值」', () => {
    expect(isFilePage({ ...PAGE, version: 'W/"abc-123"' })).toBe(true);
    expect(isFilePage({ ...PAGE, version: '0' })).toBe(true);
  });
});

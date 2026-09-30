import type { DeliverableFilePage } from '@nexus/wire';
import { describe, expect, it, vi } from 'vitest';

import { createDeliverableFileStore, isFilePage } from '@/lib/deliverable-file';
import type { DeliverableCall, Reply } from '@/test/deliverable-commands';
import {
  badRequestReply,
  carrierReply,
  deliverableFetch,
  pageReply,
  refuseReply,
  tooLargeReply,
} from '@/test/deliverable-commands';

/**
 * 交付檔預覽的讀取（#452 web 第二刀；#747 起走命令通道）。
 *
 * **每個理由碼一條**：這一組的價值全在「分得出來」。攤平成「讀不到」的話，幾個錯掉的對應關係
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

function storeWith(respond: (call: DeliverableCall) => Reply) {
  const { fetch: doFetch, calls } = deliverableFetch(respond);
  const spy = vi.fn(doFetch);
  return {
    calls,
    doFetch: spy as unknown as typeof globalThis.fetch,
    store: createDeliverableFileStore({
      threadId: 't1',
      baseUrl: '',
      fetch: spy as unknown as typeof globalThis.fetch,
    }),
  };
}

/** 讀一次並等它落地。 */
async function load(store: ReturnType<typeof storeWith>['store'], seq = 1, index = 0, offset = 0) {
  store.load(seq, index, offset);
  await vi.waitFor(() => expect(store.read(seq, index, offset)).not.toBe('loading'));
  return store.read(seq, index, offset);
}

describe('交付檔的讀取', () => {
  it('成功回的是那一頁本身', async () => {
    const { store } = storeWith(() => pageReply(PAGE));
    expect(await load(store)).toEqual(PAGE);
  });

  it.each([
    ['deliverable/no-anchor', 'missing'],
    ['deliverable/not-found', 'missing'],
    ['deliverable/not-regular-file', 'missing'],
    ['deliverable/not-text', 'not-text'],
  ] as const)('理由碼 %s 對到 %s', async (code, expected) => {
    const { store } = storeWith(() => refuseReply(code));
    expect(await load(store)).toBe(expected);
  });

  it('too-large：頁縮到 limit=1 還是太大，就改走位元組窗口；窗口本身太大才是 too-large', async () => {
    const { store, calls } = storeWith(() => tooLargeReply());
    expect(await load(store)).toBe('too-large');
    expect(calls.at(-1)?.method).toBe('deliverable.readBytes');
  });

  it('參數不合格（協定錯誤）是 invalid，這是 bug 不是使用者狀態', async () => {
    const { store } = storeWith(() => badRequestReply);
    expect(await load(store)).toBe('invalid');
  });

  it('斷線、載體層擋下與形狀不對', async () => {
    const boom = createDeliverableFileStore({
      threadId: 't1',
      baseUrl: '',
      fetch: (() => Promise.reject(new Error('斷了'))) as unknown as typeof globalThis.fetch,
    });
    boom.load(1, 0, 0);
    await vi.waitFor(() => expect(boom.read(1, 0, 0)).toBe('error'));

    const { store } = storeWith(() => pageReply({ ...PAGE, version: '' }));
    expect(await load(store)).toBe('error');
  });

  it('載體層擋下（非 2xx）：暫時當 invalid，wire 補上 code／status 之前分不出成因（#747）', async () => {
    const { store } = storeWith(() => carrierReply(500));
    expect(await load(store)).toBe('invalid');
  });

  it('只有 error 會再打一次；終局不會', async () => {
    const { store, doFetch } = storeWith(() => pageReply({ ...PAGE, version: '' }));
    await load(store);
    expect(doFetch).toHaveBeenCalledTimes(1);
    // 可重試：再叫一次真的會再發。
    await load(store);
    expect(doFetch).toHaveBeenCalledTimes(2);

    // too-large 在 store 裡面先縮 `limit`、再改走位元組窗口（#555），所以第一次讀不只發一次；要釘的是**讀完之後
    // 再叫一次不會再發**。
    const finals: Reply[] = [
      badRequestReply,
      refuseReply('deliverable/not-found'),
      tooLargeReply(),
      refuseReply('deliverable/not-text'),
    ];
    for (const reply of finals) {
      const each = storeWith(() => reply);
      await load(each.store);
      const sent = (each.doFetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
      each.store.load(1, 0, 0);
      expect(each.doFetch).toHaveBeenCalledTimes(sent);
    }
  });

  it('不送 limit —— 每頁幾行由路由決定；座標與 offset 照送', async () => {
    const { store, calls } = storeWith(() => pageReply(PAGE));
    await load(store, 7, 2, 30);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      method: 'deliverable.read',
      params: { seq: 7, index: 2, offset: 30 },
    });
    expect(calls[0]?.params).not.toHaveProperty('limit');
  });

  it('頁是快取的單位：同一個檔不同 offset 各讀一次', async () => {
    const { store, doFetch } = storeWith(() => pageReply(PAGE));
    await load(store, 1, 0, 0);
    await load(store, 1, 0, 40);
    expect(doFetch).toHaveBeenCalledTimes(2);
    // 讀過的那一頁不再發。
    store.load(1, 0, 0);
    expect(doFetch).toHaveBeenCalledTimes(2);
  });

  it('version 換了就丟掉同一個檔其他版本的頁（#452）', async () => {
    let version = 'v1';
    const { store } = storeWith((call) =>
      pageReply({ ...PAGE, version, offset: call.params.offset === 40 ? 40 : 0 }),
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
    const { store } = storeWith((call) =>
      pageReply({ ...PAGE, offset: call.params.offset === 40 ? 40 : 0 }),
    );
    await load(store, 1, 0, 0);
    await load(store, 1, 0, 40);
    expect(store.read(1, 0, 0)).toMatchObject({ version: 'v1', offset: 0 });
  });

  it('revision 每發布一次就加一，讀過的不再發所以不動（#543）', async () => {
    const { store } = storeWith(() => pageReply(PAGE));
    const before = store.revision();
    await load(store);
    // 兩次發布：'loading'，然後那一頁。
    expect(store.revision()).toBe(before + 2);
    store.load(1, 0, 0);
    expect(store.revision()).toBe(before + 2);
  });

  it('別的檔的頁不受 version 汰換影響', async () => {
    let version = 'v1';
    const { store } = storeWith(() => pageReply({ ...PAGE, version }));
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

/**
 * 圖片額度與 `image/offload`（[#1270](https://github.com/DemianLi/nexus-agent/issues/1270)）的純函式與 middleware 規則。
 *
 * 掛進真的組裝之後（pump 蓋記號、日誌落盤、續接）的行為在 `apps/harness/src/image-offload-pump.test.ts`。
 */

import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { describe, expect, it } from 'vitest';

import type { ImageAttachmentRef } from './attachment-ref.js';
import {
  applyImageOffload,
  base64Length,
  createImageOffloadMiddleware,
  hasImageBlock,
  imageOccurrences,
  imageOriginOf,
  offloadedImagesOf,
  requiredImageOffload,
  selectImagesToOffload,
  stampImageOrigin,
} from './image-offload.js';
import type { SessionLookup } from './registry.js';
import { SessionLog } from './session-log.js';

function ref(letter: string, bytes = 300): ImageAttachmentRef {
  return {
    attachmentId: `sha256:${letter.repeat(64)}`,
    mediaType: 'image/png',
    bytes,
    width: 4,
    height: 3,
  };
}

/** 一則使用者訊息：每個 ref 一個圖片區塊，後面一段字。 */
function human(refs: readonly ImageAttachmentRef[], seq?: number): HumanMessage {
  const message = new HumanMessage({
    content: [
      ...refs.map((attachment) => ({ type: 'nexus-image', attachment })),
      { type: 'text', text: '請看' },
    ] as never,
    id: `h-${String(seq ?? 'x')}`,
  });
  return seq === undefined ? message : stampImageOrigin(message, seq);
}

const flags = (message: BaseMessage | undefined) =>
  (message?.content as { type: string; offloaded?: boolean }[])
    .filter((block) => block.type === 'nexus-image')
    .map((block) => block.offloaded === true);

describe('base64Length', () => {
  it('是 4 × ceil(bytes / 3)，跟 Buffer 實際編出來的長度逐位相同', () => {
    for (const bytes of [0, 1, 2, 3, 4, 299, 300, 301, 65_536]) {
      expect(base64Length(bytes)).toBe(Buffer.alloc(bytes, 7).toString('base64').length);
    }
  });
});

describe('stampImageOrigin／imageOriginOf', () => {
  it('只替含圖的訊息蓋記號；沒有圖的訊息與蓋之前逐位元組相同', () => {
    const plain = new HumanMessage({ content: '只有字', id: 'p' });
    const before = JSON.stringify(plain.toDict());
    expect(stampImageOrigin(plain, 9)).toBe(plain);
    expect(JSON.stringify(plain.toDict())).toBe(before);
    expect(imageOriginOf(plain)).toBeUndefined();

    const withImage = stampImageOrigin(human([ref('a')]), 9);
    expect(imageOriginOf(withImage)).toBe(9);
    expect(withImage.additional_kwargs).toMatchObject({ nexus_event_seq: 9 });
  });

  it('記號不合格（負數、小數、字串）一律當沒有', () => {
    for (const bad of [-1, 1.5, '3', null]) {
      const message = human([ref('a')]);
      message.additional_kwargs = { nexus_event_seq: bad };
      expect(imageOriginOf(message)).toBeUndefined();
    }
  });
});

describe('imageOccurrences', () => {
  it('位置從 0 數，算上已經省略的', () => {
    const message = human([ref('a'), ref('b'), ref('c')]);
    const first = (message.content as { offloaded?: true }[])[0]!;
    first.offloaded = true;
    expect(
      imageOccurrences(message).map((o) => [o.imageIndex, o.block.offloaded === true]),
    ).toEqual([
      [0, true],
      [1, false],
      [2, false],
    ]);
    expect(hasImageBlock(message)).toBe(true);
    expect(hasImageBlock(new HumanMessage('字'))).toBe(false);
  });
});

describe('requiredImageOffload（逐字照 dsh offloadedImagePrefixCount，無 quantum）', () => {
  it('沒有額度、額度內：0', () => {
    const messages = [human([ref('a'), ref('b')], 1)];
    expect(requiredImageOffload(messages, {})).toBe(0);
    expect(requiredImageOffload(messages, { maxImages: 2 })).toBe(0);
    expect(requiredImageOffload(messages, { maxImages: 5, maxBytes: 10_000 })).toBe(0);
  });

  it('張數超出：超出幾張就省略幾張', () => {
    const messages = [human([ref('a'), ref('b')], 1), human([ref('c')], 2)];
    expect(requiredImageOffload(messages, { maxImages: 1 })).toBe(2);
    expect(requiredImageOffload(messages, { maxImages: 2 })).toBe(1);
  });

  it('位元組超出：從最舊的累計到移除量夠為止；兩種超出取較大的那個需求', () => {
    // 每張 300 bytes → base64 400。三張共 1200。
    const messages = [human([ref('a'), ref('b'), ref('c')], 1)];
    expect(requiredImageOffload(messages, { maxBytes: 1100 })).toBe(1);
    expect(requiredImageOffload(messages, { maxBytes: 700 })).toBe(2);
    expect(requiredImageOffload(messages, { maxBytes: 399 })).toBe(3);
    expect(requiredImageOffload(messages, { maxImages: 2, maxBytes: 700 })).toBe(2);
  });

  it('已經省略的不再算', () => {
    const message = human([ref('a'), ref('b')], 1);
    (message.content as { offloaded?: true }[])[0]!.offloaded = true;
    expect(requiredImageOffload([message], { maxImages: 1 })).toBe(0);
  });
});

describe('selectImagesToOffload', () => {
  it('挑最舊的，跨訊息、按 seq 由小到大、位置遞增', () => {
    const messages = [human([ref('a'), ref('b')], 4), new AIMessage('好'), human([ref('c')], 9)];
    expect(selectImagesToOffload(messages, 3)).toEqual({
      targets: [
        { seq: 4, imageIndexes: [0, 1] },
        { seq: 9, imageIndexes: [0] },
      ],
      selected: 3,
    });
    expect(selectImagesToOffload(messages, 1).targets).toEqual([{ seq: 4, imageIndexes: [0] }]);
  });

  it('跳過已省略的，位置仍是含已省略者的位置', () => {
    const message = human([ref('a'), ref('b')], 4);
    (message.content as { offloaded?: true }[])[0]!.offloaded = true;
    expect(selectImagesToOffload([message], 1).targets).toEqual([{ seq: 4, imageIndexes: [1] }]);
  });

  it('沒有來源記號的圖選不到：少於要求的張數，不亂記', () => {
    const marked = human([ref('a')], 4);
    const unmarked = human([ref('b')]);
    expect(selectImagesToOffload([unmarked, marked], 2)).toEqual({
      targets: [{ seq: 4, imageIndexes: [0] }],
      selected: 1,
    });
  });
});

describe('offloadedImagesOf', () => {
  it('把日誌上所有 image/offload 攤成 seq → 位置；同一 seq 的多筆合併；形狀不對的格略過', () => {
    const log = new SessionLog('s');
    log.append('image/offload', { targets: [{ seq: 3, imageIndexes: [0] }] });
    log.append('image/offload', {
      targets: [
        { seq: 3, imageIndexes: [1] },
        { seq: 8, imageIndexes: [0] },
      ],
    });
    const offloaded = offloadedImagesOf(log.events);
    expect([...offloaded.entries()].map(([seq, set]) => [seq, [...set].sort()])).toEqual([
      [3, [0, 1]],
      [8, [0]],
    ]);
    expect(offloadedImagesOf([]).size).toBe(0);
  });
});

describe('applyImageOffload', () => {
  it('沒有決定、沒有命中：回同一個陣列', () => {
    const messages = [human([ref('a')], 1)];
    expect(applyImageOffload(messages, new Map())).toBe(messages);
    expect(applyImageOffload(messages, new Map([[99, new Set([0])]]))).toBe(messages);
  });

  it('命中的圖在副本上標 offloaded、原訊息不動、其餘欄位帶過去', () => {
    const original = human([ref('a'), ref('b')], 1);
    const other = human([ref('c')], 2);
    const out = applyImageOffload([original, other], new Map([[1, new Set([0])]]));
    expect(flags(out[0])).toEqual([true, false]);
    expect(flags(out[1])).toEqual([false]);
    expect(out[1]).toBe(other);
    expect(flags(original)).toEqual([false, false]);
    expect(out[0]!.id).toBe(original.id);
    expect(imageOriginOf(out[0]!)).toBe(1);
  });

  it('沒有來源記號的訊息原樣通過', () => {
    const unmarked = human([ref('a')]);
    const out = applyImageOffload([unmarked], new Map([[0, new Set([0])]]));
    expect(out[0]).toBe(unmarked);
  });
});

describe('createImageOffloadMiddleware', () => {
  type Hook = (
    request: never,
    handler: (request: { messages: readonly BaseMessage[] }) => Promise<unknown>,
  ) => Promise<unknown>;

  function setup(budget: { maxImages?: number; maxBytes?: number } | undefined, found?: 'ok') {
    const log = new SessionLog('s');
    const lookup: SessionLookup =
      found === undefined || found === 'ok'
        ? { kind: 'ok', address: { kind: 'root' } as never, log }
        : { kind: 'not-attached' };
    const seen: unknown[] = [];
    const middleware = createImageOffloadMiddleware({
      sessions: { forCall: () => lookup },
      budgetOf: () => budget,
    }) as unknown as { wrapModelCall: Hook };
    const call = (messages: readonly BaseMessage[]) =>
      middleware.wrapModelCall(
        {
          model: new FakeListChatModel({ responses: ['好'] }),
          messages,
          runtime: { configurable: { checkpoint_ns: 'model_request:x' } },
        } as never,
        async (request) => {
          seen.push(request.messages);
          return 'ok';
        },
      );
    return { log, call, seen };
  }

  it('沒有圖的請求原樣通過、不讀日誌', async () => {
    const run = setup({ maxImages: 1 });
    const messages = [new HumanMessage('字')];
    await run.call(messages);
    expect(run.seen[0]).toBe(messages);
    expect(run.log.events).toHaveLength(0);
  });

  it('超額：記一筆 image/offload，送出去的請求最舊的圖已省略；下一次不重記', async () => {
    const run = setup({ maxImages: 1 });
    const messages = [human([ref('a')], 5), human([ref('b')], 7)];
    await run.call(messages);
    expect(run.log.events.map((e) => [e.type, e.data])).toEqual([
      ['image/offload', { targets: [{ seq: 5, imageIndexes: [0] }] }],
    ]);
    const sent = run.seen[0] as BaseMessage[];
    expect(sent.map(flags)).toEqual([[true], [false]]);
    expect(flags(messages[0])).toEqual([false]);

    await run.call(messages);
    expect(run.log.events).toHaveLength(1);
    expect((run.seen[1] as BaseMessage[]).map(flags)).toEqual([[true], [false]]);
  });

  it('額度內：不記、請求原樣', async () => {
    const run = setup({ maxImages: 2 });
    const messages = [human([ref('a')], 5), human([ref('b')], 7)];
    await run.call(messages);
    expect(run.log.events).toHaveLength(0);
    expect(run.seen[0]).toBe(messages);
  });

  it('沒宣告額度：不檢查；但日誌上已有的決定照樣沿用', async () => {
    const run = setup(undefined);
    run.log.append('image/offload', { targets: [{ seq: 5, imageIndexes: [0] }] });
    const messages = [human([ref('a')], 5), human([ref('b')], 7), human([ref('c')], 8)];
    await run.call(messages);
    expect(run.log.events).toHaveLength(1);
    expect((run.seen[0] as BaseMessage[]).map(flags)).toEqual([[true], [false], [false]]);
  });

  it('額度比能選的還緊（沒有記號的圖）：能省的省、其餘照送，不拋', async () => {
    const run = setup({ maxImages: 1 });
    const messages = [human([ref('a')]), human([ref('b')])];
    await run.call(messages);
    expect(run.log.events).toHaveLength(0);
    expect(run.seen[0]).toBe(messages);
  });

  it('沒接 session：不省略、不拋', async () => {
    const log = new SessionLog('s');
    const seen: unknown[] = [];
    const middleware = createImageOffloadMiddleware({
      sessions: { forCall: () => ({ kind: 'not-attached' }) },
      budgetOf: () => ({ maxImages: 1 }),
    }) as unknown as { wrapModelCall: Hook };
    const messages = [human([ref('a')], 5), human([ref('b')], 7)];
    await middleware.wrapModelCall({ model: {}, messages } as never, async (request) => {
      seen.push(request.messages);
      return 'ok';
    });
    expect(seen[0]).toBe(messages);
    expect(log.events).toHaveLength(0);
  });
});

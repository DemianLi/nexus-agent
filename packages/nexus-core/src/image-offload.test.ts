/**
 * 圖片額度與 `image/offload`（[#1270](https://github.com/DemianLi/nexus-agent/issues/1270)）的純函式與 middleware 規則。
 *
 * 掛進真的組裝之後（pump 蓋記號、日誌落盤、續接）的行為在 `apps/harness/src/image-offload-pump.test.ts`。
 */

import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { describe, expect, it } from 'vitest';

import type { ImageAttachmentRef } from './attachment-ref.js';
import {
  applyImageOffload,
  assertImageBudget,
  base64Length,
  createImageOffloadMiddleware,
  createImageOffloadRecoveryMiddleware,
  hasImageBlock,
  IMAGE_OFFLOAD_REQUIRED_CODE,
  ImageOffloadRequiredError,
  imageOffloadRequiredOf,
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

describe('assertImageBudget／ImageOffloadRequiredError（adapter 那一側：只量、不決定）', () => {
  it('額度內、沒宣告額度：什麼都不做', () => {
    const messages = [human([ref('a')], 5), human([ref('b')], 7)];
    expect(() => assertImageBudget(messages, { maxImages: 2 })).not.toThrow();
    expect(() => assertImageBudget(messages, {})).not.toThrow();
  });

  it('超額：拋 IMAGE_OFFLOAD_REQUIRED，offloadImages 就是 requiredImageOffload 算的量', () => {
    const messages = [human([ref('a')], 5), human([ref('b')], 7), human([ref('c')], 8)];
    let caught: unknown;
    try {
      assertImageBudget(messages, { maxImages: 1 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ImageOffloadRequiredError);
    expect(caught).toMatchObject({ code: IMAGE_OFFLOAD_REQUIRED_CODE, offloadImages: 2 });
    expect(IMAGE_OFFLOAD_REQUIRED_CODE).toBe('IMAGE_OFFLOAD_REQUIRED');
    // 位元組那一格也量：每張 300 位元組 → base64 400，額度 500 只容得下一張。
    expect(() => assertImageBudget(messages, { maxBytes: 500 })).toThrow(
      expect.objectContaining({ offloadImages: 2 }),
    );
  });

  it('已經標成省略的不再算', () => {
    const [a] = applyImageOffload([human([ref('a')], 5)], new Map([[5, new Set([0])]]));
    expect(() => assertImageBudget([a!, human([ref('b')], 7)], { maxImages: 1 })).not.toThrow();
  });

  it('imageOffloadRequiredOf 沿 cause 鏈找；別的錯誤回 undefined', () => {
    const inner = new ImageOffloadRequiredError(3);
    expect(imageOffloadRequiredOf(inner)).toBe(inner);
    expect(imageOffloadRequiredOf(new Error('包一層', { cause: inner }))).toBe(inner);
    expect(imageOffloadRequiredOf(new Error('別的'))).toBeUndefined();
    expect(imageOffloadRequiredOf('字串')).toBeUndefined();
  });
});

type Hook = (
  request: never,
  handler: (request: { messages: readonly BaseMessage[] }) => Promise<unknown>,
) => Promise<unknown>;

/**
 * 洋蔥：標記層（外）→ 接住層（內）→ 假 adapter（照真的：先量額度、超額拋、否則記下收到的請求）。
 * `attempts` 是假 adapter 被叫的次數（含被擋下的）；`seen` 是它放行的請求。
 */
function chain(
  budget: { maxImages?: number; maxBytes?: number } | undefined,
  lookup?: SessionLookup,
) {
  const log = new SessionLog('s');
  const resolved: SessionLookup = lookup ?? { kind: 'ok', address: { kind: 'root' } as never, log };
  const deps = { sessions: { forCall: () => resolved } };
  const outer = createImageOffloadMiddleware(deps) as unknown as { wrapModelCall: Hook };
  const inner = createImageOffloadRecoveryMiddleware(deps) as unknown as { wrapModelCall: Hook };
  const seen: (readonly BaseMessage[])[] = [];
  let attempts = 0;
  const adapter = async (request: { messages: readonly BaseMessage[] }) => {
    attempts += 1;
    if (budget !== undefined) assertImageBudget(request.messages, budget);
    seen.push(request.messages);
    return 'ok';
  };
  const call = (messages: readonly BaseMessage[]) => {
    const request = {
      model: new FakeListChatModel({ responses: ['好'] }),
      messages,
      runtime: { configurable: { checkpoint_ns: 'model_request:x' } },
    } as never;
    return outer.wrapModelCall(request, (next) => inner.wrapModelCall(next as never, adapter));
  };
  return { log, call, seen, attempts: () => attempts };
}

describe('createImageOffloadMiddleware（標記層：只套日誌上已經下的決定）', () => {
  it('沒有圖的請求原樣通過、不讀日誌', async () => {
    const lookups: unknown[] = [];
    const middleware = createImageOffloadMiddleware({
      sessions: {
        forCall: () => {
          lookups.push(1);
          return { kind: 'not-attached' };
        },
      },
    }) as unknown as { wrapModelCall: Hook };
    const messages = [new HumanMessage('字')];
    const seen: unknown[] = [];
    await middleware.wrapModelCall({ messages } as never, async (r) => {
      seen.push(r.messages);
      return 'ok';
    });
    expect(seen[0]).toBe(messages);
    expect(lookups).toHaveLength(0);
  });

  it('日誌上已有的決定照樣標上去；自己從不下新決定', async () => {
    const run = chain(undefined);
    run.log.append('image/offload', { targets: [{ seq: 5, imageIndexes: [0] }] });
    const messages = [human([ref('a')], 5), human([ref('b')], 7), human([ref('c')], 8)];
    await run.call(messages);
    expect(run.log.events).toHaveLength(1);
    expect(run.seen[0]!.map(flags)).toEqual([[true], [false], [false]]);
    expect(flags(messages[0])).toEqual([false]);
  });

  it('沒接 session：不標、不拋', async () => {
    const run = chain(undefined, { kind: 'not-attached' });
    const messages = [human([ref('a')], 5), human([ref('b')], 7)];
    await run.call(messages);
    expect(run.seen[0]).toBe(messages);
  });
});

describe('createImageOffloadRecoveryMiddleware（接住 adapter 的拋碼：下決定、再送一次）', () => {
  it('超額：adapter 拋一次，記一筆 image/offload，再送的請求最舊的圖已省略；下一次呼叫標記層直接套、不再拋也不重記', async () => {
    const run = chain({ maxImages: 1 });
    const messages = [human([ref('a')], 5), human([ref('b')], 7)];
    await run.call(messages);
    expect(run.log.events.map((e) => [e.type, e.data])).toEqual([
      ['image/offload', { targets: [{ seq: 5, imageIndexes: [0] }] }],
    ]);
    expect(run.attempts()).toBe(2);
    expect(run.seen).toHaveLength(1);
    expect(run.seen[0]!.map(flags)).toEqual([[true], [false]]);
    expect(flags(messages[0])).toEqual([false]);

    await run.call(messages);
    expect(run.attempts()).toBe(3);
    expect(run.log.events).toHaveLength(1);
    expect(run.seen[1]!.map(flags)).toEqual([[true], [false]]);
  });

  it('額度內：adapter 不拋，一次送出、不記', async () => {
    const run = chain({ maxImages: 2 });
    const messages = [human([ref('a')], 5), human([ref('b')], 7)];
    await run.call(messages);
    expect(run.attempts()).toBe(1);
    expect(run.log.events).toHaveLength(0);
    expect(run.seen[0]).toBe(messages);
  });

  it('一次要省多張：一筆 image/offload 帶全部目標、只再送一次', async () => {
    const run = chain({ maxImages: 1 });
    await run.call([human([ref('a')], 5), human([ref('b')], 7), human([ref('c')], 8)]);
    expect(run.log.events.map((e) => e.data)).toEqual([
      {
        targets: [
          { seq: 5, imageIndexes: [0] },
          { seq: 7, imageIndexes: [0] },
        ],
      },
    ]);
    expect(run.attempts()).toBe(2);
  });

  it('不是這個碼的錯誤原樣往外拋，什麼都不記', async () => {
    const log = new SessionLog('s');
    const middleware = createImageOffloadRecoveryMiddleware({
      sessions: { forCall: () => ({ kind: 'ok', address: { kind: 'root' } as never, log }) },
    }) as unknown as { wrapModelCall: Hook };
    const boom = new Error('別的失敗');
    await expect(
      middleware.wrapModelCall({ messages: [human([ref('a')], 5)] } as never, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(log.events).toHaveLength(0);
  });

  it('沒有記號的圖選不到：原錯誤往外（走一般失敗路徑），不亂記', async () => {
    const run = chain({ maxImages: 1 });
    await expect(run.call([human([ref('a')]), human([ref('b')])])).rejects.toMatchObject({
      code: IMAGE_OFFLOAD_REQUIRED_CODE,
      offloadImages: 1,
    });
    expect(run.log.events).toHaveLength(0);
    expect(run.attempts()).toBe(1);
  });

  it('能省的省、省完仍超額就往外拋：每圈至少多省一張所以一定會停', async () => {
    const run = chain({ maxImages: 1 });
    await expect(
      run.call([human([ref('a')], 5), human([ref('b')]), human([ref('c')])]),
    ).rejects.toMatchObject({ code: IMAGE_OFFLOAD_REQUIRED_CODE, offloadImages: 1 });
    expect(run.log.events.map((e) => e.data)).toEqual([
      { targets: [{ seq: 5, imageIndexes: [0] }] },
    ]);
    expect(run.attempts()).toBe(2);
  });

  it('選到了卻標不上（標記層只標人話訊息）：不記沒有效果的決定、不轉圈，原錯誤往外', async () => {
    const run = chain({ maxImages: 1 });
    const tool = stampImageOrigin(
      new ToolMessage({
        content: [{ type: 'nexus-image', attachment: ref('a') }] as never,
        tool_call_id: 't1',
      }),
      5,
    );
    await expect(run.call([tool, human([ref('b')], 7)])).rejects.toMatchObject({
      code: IMAGE_OFFLOAD_REQUIRED_CODE,
    });
    expect(run.attempts()).toBe(1);
    expect(run.log.events).toHaveLength(0);
  });

  it('沒接 session：決定記不下來，原錯誤往外', async () => {
    const run = chain({ maxImages: 1 }, { kind: 'not-attached' });
    await expect(run.call([human([ref('a')], 5), human([ref('b')], 7)])).rejects.toMatchObject({
      code: IMAGE_OFFLOAD_REQUIRED_CODE,
    });
    expect(run.attempts()).toBe(1);
  });
});

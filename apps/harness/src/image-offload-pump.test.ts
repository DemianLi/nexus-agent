/**
 * **圖片額度與 `image/offload` 在 pump 裡的走法**（[#1270](https://github.com/DemianLi/nexus-agent/issues/1270)，#732 第 8 項）。
 * 真的 `createNexusAgent`＋`ThreadPump`，模型是腳本（`ScriptedChatModel`），額度 `maxImages: 1`（90b 端點實測的上限）由腳本模型自己執行——
 * 跟真 adapter 一樣，請求進來先量、超額拋 `IMAGE_OFFLOAD_REQUIRED`，由上層接住、下決定、再送一次。量的是**決定怎麼記、怎麼沿用、續接後還在，
 * 以及失敗的那一次嘗試不算一次模型呼叫、不花重試**；佔位字進線上 body 與真 adapter 的拋碼由 `attachment-chat-openai.test.ts` 量。
 *
 * **零憑證、零外部連線**。
 */

import type { BaseMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import {
  applyImageOffload,
  imageOriginOf,
  offloadedImagesOf,
  replayConversation,
} from '@nexus/core';
import type { AttachmentRef, PluginEntry, SessionEvent } from '@nexus/core';
import { IMAGE_OFFLOAD, emptyConversation, reduceAll } from '@nexus/wire';
import type { Event } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import { restoreConversation } from './conversation-restore.js';
import { historyFrames } from './conversation-history.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

const imageRef = (letter: string, name: string): AttachmentRef => ({
  type: 'image',
  attachmentId: `sha256:${letter.repeat(64)}`,
  mediaType: 'image/png',
  bytes: 90,
  width: 3,
  height: 2,
  name,
});
const FIRST = imageRef('a', 'one.png');
const SECOND = imageRef('b', 'two.png');
const THIRD = imageRef('c', 'three.png');

const POKE: ScriptedTurn = { content: '', toolCalls: [{ name: 'poke', args: {} }] };

function pokePlugin(onPoke: () => void): PluginEntry {
  return {
    plugin: {
      name: 'poke',
      apply(registry) {
        registry.tools.register(
          tool(
            () => {
              onPoke();
              return 'poked';
            },
            { name: 'poke', description: '戳一下。', schema: z.object({}) },
          ),
        );
      },
    },
  };
}

const runs: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(runs.splice(0).map((close) => close()));
});

async function assemble(
  turns: readonly ScriptedTurn[],
  maxImages: number | undefined,
  onPoke?: () => void,
  seed?: readonly SessionEvent[],
) {
  const model = new ScriptedChatModel({
    turns,
    ...(maxImages === undefined ? {} : { imageBudget: { maxImages } }),
  });
  const built = await createNexusAgent({
    model,
    checkpointer: new MemorySaver(),
    summarization: false,
    observationPolicy: false,
    plugins: onPoke === undefined ? [] : [pokePlugin(onPoke)],
    ...(onPoke === undefined ? {} : { stepInbox: true }),
    // 有型錄（`modelLimits`）才掛這兩顆 middleware；額度本身在腳本模型上，不在這裡。
    modelLimits: () => ({ contextWindow: 32_768, maxOutputTokens: 4096 }),
  });
  const pump = new ThreadPump(
    built.agent as unknown as PumpAgent,
    'pump-image-offload',
    undefined,
    seed,
    undefined,
    undefined,
    undefined,
    built.stepInbox,
  );
  const detach = built.attachSession(pump.sessions);
  const frames: Event[] = [];
  const line = new AbortController();
  const draining = (async () => {
    for await (const frame of pump.subscribe(['messages', 'custom'], line.signal))
      frames.push(frame);
  })();
  runs.push(async () => {
    pump.close();
    line.abort();
    await draining;
    detach();
    await built.dispose();
  });
  return { model, built, pump, frames };
}

/** 一則訊息裡每個圖片區塊有沒有被標成已省略。 */
const imageFlags = (message: BaseMessage | undefined): boolean[] =>
  (Array.isArray(message?.content)
    ? (message.content as { type: string; offloaded?: boolean }[])
    : []
  )
    .filter((block) => block.type === 'nexus-image')
    .map((block) => block.offloaded === true);

const humans = (prompt: readonly BaseMessage[]) => prompt.filter((m) => m.getType() === 'human');

const offloadEvents = (events: readonly SessionEvent[]) =>
  events.filter((event): event is SessionEvent<'image/offload'> => event.type === 'image/offload');

describe('超出圖片額度', () => {
  it('第二張圖進來時記一筆 image/offload、最舊的那張在重送的請求裡變省略，之後每一步沿用、不再重記', async () => {
    const run = await assemble([{ content: '一' }, { content: '二' }, { content: '三' }], 1);

    await run.pump.submit({ kind: 'message', text: '看這張', id: 'm1', attachments: [FIRST] });
    await run.pump.whenIdle();
    expect(offloadEvents(run.pump.sessionLog.events)).toHaveLength(0);
    expect(imageFlags(humans(run.model.prompts[0]!)[0])).toEqual([false]);

    await run.pump.submit({ kind: 'message', text: '再看這張', id: 'm2', attachments: [SECOND] });
    await run.pump.whenIdle();

    const events = run.pump.sessionLog.events;
    const offloads = offloadEvents(events);
    expect(offloads).toHaveLength(1);
    // 目標是第一輪那顆 `turn/start` 的 seq 與它的第 0 張圖。
    const firstStart = events.filter((e) => e.type === 'turn/start')[0]!;
    expect(offloads[0]!.data).toEqual({ targets: [{ seq: firstStart.seq, imageIndexes: [0] }] });
    // 模型這一次讀到的：舊的省略、新的留著。
    const second = humans(run.model.prompts[1]!);
    expect(imageFlags(second[0])).toEqual([true]);
    expect(imageFlags(second[1])).toEqual([false]);
    // 該叫的次數：第二輪被額度擋下一次（拋 `IMAGE_OFFLOAD_REQUIRED`），但那一次沒有送出任何東西——
    // 不算一次模型呼叫（只有兩對 `model/start`／`model/end`、`model/end` 都沒帶 `outcome`）、不花重試額度（沒有 `llm/retry*`）。
    expect(run.model.prompts).toHaveLength(2);
    expect(run.model.rejectedImageRequests).toBe(1);
    expect(events.filter((e) => e.type === 'model/start')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'model/end').map((e) => e.data.outcome)).toEqual([
      undefined,
      undefined,
    ]);
    expect(events.filter((e) => e.type === 'llm/retry' || e.type === 'llm/retry-started')).toEqual(
      [],
    );
    expect(events.some((e) => e.type === 'turn/failed')).toBe(false);

    // 沒圖的第三輪：沿用，不再記。
    await run.pump.submit({ kind: 'message', text: '只是問個問題', id: 'm3' });
    await run.pump.whenIdle();
    expect(offloadEvents(run.pump.sessionLog.events)).toHaveLength(1);
    const third = humans(run.model.prompts[2]!);
    expect(imageFlags(third[0])).toEqual([true]);
    expect(imageFlags(third[1])).toEqual([false]);
  }, 20000);

  it('一則訊息帶兩張、額度一張：省略它自己的第 0 張，留第 1 張', async () => {
    const run = await assemble([{ content: '好' }], 1);
    await run.pump.submit({
      kind: 'message',
      text: '兩張',
      id: 'm1',
      attachments: [FIRST, SECOND],
    });
    await run.pump.whenIdle();
    const offloads = offloadEvents(run.pump.sessionLog.events);
    expect(offloads.map((e) => e.data)).toEqual([
      {
        targets: [
          {
            seq: run.pump.sessionLog.events.find((e) => e.type === 'turn/start')!.seq,
            imageIndexes: [0],
          },
        ],
      },
    ]);
    expect(imageFlags(humans(run.model.prompts[0]!)[0])).toEqual([true, false]);
  }, 20000);

  it('輪中插話帶的圖也算：插話被領走的那一步，更舊的圖讓出位子', async () => {
    const run = await assemble([POKE, { content: '完' }, { content: '再' }], 1, () => {
      void run.pump.submit({
        kind: 'message',
        text: '',
        id: 's1',
        steer: true,
        attachments: [SECOND],
      });
    });
    await run.pump.submit({ kind: 'message', text: '開場', id: 'm1', attachments: [FIRST] });
    await run.pump.whenIdle();

    expect(run.model.prompts).toHaveLength(2);
    expect(imageFlags(humans(run.model.prompts[0]!)[0])).toEqual([false]);
    const second = humans(run.model.prompts[1]!);
    expect(imageFlags(second[0])).toEqual([true]);
    expect(imageFlags(second[1])).toEqual([false]);
    const events = run.pump.sessionLog.events;
    expect(offloadEvents(events).map((e) => e.data)).toEqual([
      { targets: [{ seq: events.find((e) => e.type === 'turn/start')!.seq, imageIndexes: [0] }] },
    ]);

    // 插話那張圖自己也能被省略（它的來源是記插話的 `user/message`，由 pump 蓋記號）：下一輪再來一張，輪到它讓位。
    await run.pump.submit({ kind: 'message', text: '再來', id: 'm2', attachments: [THIRD] });
    await run.pump.whenIdle();
    const steered = run.pump.sessionLog.events.find(
      (e) => e.type === 'user/message' && e.data.source.kind === 'user',
    )!;
    expect(offloadEvents(run.pump.sessionLog.events)[1]?.data).toEqual({
      targets: [{ seq: steered.seq, imageIndexes: [0] }],
    });
    expect(
      humans(run.model.prompts[2]!)
        .map((m) => imageFlags(m))
        .filter((flags) => flags.length > 0),
    ).toEqual([[true], [true], [false]]);
  }, 20000);

  it('沒宣告額度就不檢查：多少張圖都原樣送', async () => {
    const run = await assemble(
      [{ content: '一' }, { content: '二' }, { content: '三' }],
      undefined,
    );
    for (const [index, image] of [FIRST, SECOND, THIRD].entries()) {
      await run.pump.submit({
        kind: 'message',
        text: `第 ${String(index)} 張`,
        id: `m${String(index)}`,
        attachments: [image],
      });
      await run.pump.whenIdle();
    }
    expect(offloadEvents(run.pump.sessionLog.events)).toHaveLength(0);
    expect(run.model.rejectedImageRequests).toBe(0);
    expect(humans(run.model.prompts[2]!).map((m) => imageFlags(m))).toEqual([
      [false],
      [false],
      [false],
    ]);
  }, 20000);
});

const FILE: AttachmentRef = {
  type: 'file',
  attachmentId: `sha256:${'f'.repeat(64)}`,
  name: 'report.csv',
  bytes: 12,
};

describe('畫面知道哪幾格附件被省略了', () => {
  it('即時一顆 image-offload frame（位置是 attachments 裡的位置、附 inboxId 與 seq）；折疊器累加、歷史冷載入標得一樣', async () => {
    const run = await assemble([{ content: '一' }, { content: '二' }], 1);
    // 檔案在前、圖在後：圖是 attachments[1]，但在模型訊息裡是第 0 張圖——位置要換算。
    await run.pump.submit({
      kind: 'message',
      text: '一',
      id: 'm1',
      attachments: [FILE, FIRST],
    });
    await run.pump.whenIdle();
    await run.pump.submit({ kind: 'message', text: '二', id: 'm2', attachments: [SECOND] });
    await run.pump.whenIdle();

    const events = run.pump.sessionLog.events;
    const firstStart = events.find((e) => e.type === 'turn/start')!;
    const payloads = run.frames.flatMap((frame) => {
      const data = frame.params.data as { name?: string; payload?: unknown } | null;
      return frame.method === 'custom' && data?.name === IMAGE_OFFLOAD ? [data.payload] : [];
    });
    expect(payloads).toEqual([{ items: [{ seq: firstStart.seq, inboxId: 'm1', positions: [1] }] }]);

    // 即時折疊：那句人話（`inbox:m1`）的 omittedAttachments 是 [1]，第二句沒有。
    const live = reduceAll(emptyConversation(), run.frames);
    const humansLive = live.entries.filter((e) => e.kind === 'human');
    expect(humansLive).toMatchObject([
      { inboxId: 'm1', omittedAttachments: [1] },
      { inboxId: 'm2' },
    ]);
    expect('omittedAttachments' in humansLive[1]!).toBe(false);

    // 冷載入：同一份日誌的歷史，人話的 message-start 直接帶；折出來與即時一致。
    const cold = reduceAll(emptyConversation(), historyFrames(events, 100_000));
    const humansCold = cold.entries.filter((e) => e.kind === 'human');
    expect(humansCold).toMatchObject([
      { id: `history-${String(firstStart.seq)}`, omittedAttachments: [1] },
      { text: '二' },
    ]);
    expect('omittedAttachments' in humansCold[1]!).toBe(false);
    // 冷載入之後又收到同一顆即時 frame（重連補送之類）：位置相同，不重複。
    const again = reduceAll(
      cold,
      run.frames.filter(
        (frame) => (frame.params.data as { name?: string } | null)?.name === IMAGE_OFFLOAD,
      ),
    );
    expect(again.entries.filter((e) => e.kind === 'human')[0]).toMatchObject({
      omittedAttachments: [1],
    });
  }, 20000);

  it('沒有超額就沒有 frame、歷史也沒有這一格', async () => {
    const run = await assemble([{ content: '一' }], 1);
    await run.pump.submit({ kind: 'message', text: '一', id: 'm1', attachments: [FIRST] });
    await run.pump.whenIdle();
    expect(
      run.frames.some(
        (frame) => (frame.params.data as { name?: string } | null)?.name === IMAGE_OFFLOAD,
      ),
    ).toBe(false);
    const cold = reduceAll(emptyConversation(), historyFrames(run.pump.sessionLog.events, 100_000));
    expect('omittedAttachments' in cold.entries.filter((e) => e.kind === 'human')[0]!).toBe(false);
  }, 20000);
});

describe('省略在續接之後還是省略', () => {
  it('重放蓋上的來源記號與即時的一致；日誌的決定套回重放出來的訊息，被省略的仍是被省略的', async () => {
    const run = await assemble([{ content: '一' }, { content: '二' }], 1);
    await run.pump.submit({ kind: 'message', text: '一', id: 'm1', attachments: [FIRST] });
    await run.pump.whenIdle();
    await run.pump.submit({ kind: 'message', text: '二', id: 'm2', attachments: [SECOND] });
    await run.pump.whenIdle();

    const events = run.pump.sessionLog.events;
    const state = (await run.built.agent.getState({
      configurable: { thread_id: 'pump-image-offload' },
    })) as { values: { messages: BaseMessage[] } };
    const replay = replayConversation(events);
    if (replay.kind !== 'replayed') throw new Error('日誌重放不出來');

    // 兩條路上同一個位置的人話，來源記號相同（存檔點裡的是 pump 蓋的、重放裡的是 `replayConversation` 蓋的）。
    const originsOf = (messages: readonly BaseMessage[]) =>
      messages.filter((m) => m.getType() === 'human').map((m) => imageOriginOf(m));
    expect(originsOf(replay.messages)).toEqual(originsOf(state.values.messages));
    expect(originsOf(replay.messages).every((origin) => origin !== undefined)).toBe(true);

    // 日誌上的決定套回重放出來的訊息：第一則的圖被省略，第二則沒有。
    const applied = applyImageOffload(replay.messages, offloadedImagesOf(events));
    expect(applied.filter((m) => m.getType() === 'human').map((m) => imageFlags(m))).toEqual([
      [true],
      [false],
    ]);
    // 帶旗標的是請求副本：重放出來的原訊息沒被改。
    expect(
      replay.messages.filter((m) => m.getType() === 'human').map((m) => imageFlags(m)),
    ).toEqual([[false], [false]]);
  }, 20000);
});

describe('重啟續接（日誌帶回來、對話照日誌灌回）', () => {
  it('被省略的圖在新行程裡仍是省略、不再記第二筆；新來的圖照常算額度', async () => {
    const before = await assemble([{ content: '一' }, { content: '二' }], 1);
    await before.pump.submit({ kind: 'message', text: '一', id: 'm1', attachments: [FIRST] });
    await before.pump.whenIdle();
    await before.pump.submit({ kind: 'message', text: '二', id: 'm2', attachments: [SECOND] });
    await before.pump.whenIdle();
    const events = [...before.pump.sessionLog.events];
    expect(offloadEvents(events)).toHaveLength(1);

    // 新行程：空的存檔點，從日誌續接。
    const after = await assemble([{ content: '三' }, { content: '四' }], 1, undefined, events);
    const restored = await restoreConversation(
      after.built.agent as never,
      'pump-image-offload',
      events,
    );
    expect(restored.kind).toBe('replayed');

    await after.pump.submit({ kind: 'message', text: '沒有新圖', id: 'm3' });
    await after.pump.whenIdle();
    const resumed = humans(after.model.prompts[0]!);
    expect(resumed.map((m) => imageFlags(m)).filter((flags) => flags.length > 0)).toEqual([
      [true],
      [false],
    ]);
    expect(offloadEvents(after.pump.sessionLog.events)).toHaveLength(1);

    // 續接之後再來一張：留著的第二張讓位，記第二筆，目標是第二輪那顆 `turn/start`。
    await after.pump.submit({ kind: 'message', text: '第三張', id: 'm4', attachments: [THIRD] });
    await after.pump.whenIdle();
    const starts = after.pump.sessionLog.events.filter((e) => e.type === 'turn/start');
    const second = offloadEvents(after.pump.sessionLog.events)[1];
    expect(second?.data).toEqual({
      targets: [
        {
          seq: starts.find((e) => e.data.kind === 'message' && e.data.text === '二')!.seq,
          imageIndexes: [0],
        },
      ],
    });
    expect(
      humans(after.model.prompts[1]!)
        .map((m) => imageFlags(m))
        .filter((flags) => flags.length > 0),
    ).toEqual([[true], [true], [false]]);
  }, 20000);
});

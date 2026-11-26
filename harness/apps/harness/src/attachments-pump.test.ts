/**
 * **帶附件的訊息在 pump 裡的走法**（[#732](https://github.com/DemianLi/nexus-agent/issues/732) 第二刀）：開場那句、輪中插話、
 * 排隊後改文字、重放與歷史。真的 `createNexusAgent`＋`ThreadPump`，模型是腳本（`ScriptedChatModel`）——這一檔量的是
 * **參照怎麼在佇列、日誌、state 裡走**，請求轉換那一層由 `attachment-wire.test.ts` 量。
 *
 * **零憑證、零外部連線**。
 */

import { tool } from '@langchain/core/tools';
import type { BaseMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { replayConversation } from '@nexus/core';
import type { AttachmentRef, PluginEntry } from '@nexus/core';
import type { Event, InboxPayload } from '@nexus/wire';
import { INBOX } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import { historyFrames } from './conversation-history.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

const FILE: AttachmentRef = {
  type: 'file',
  attachmentId: `sha256:${'a'.repeat(64)}`,
  name: 'report.csv',
  bytes: 12,
};
const IMAGE: AttachmentRef = {
  type: 'image',
  attachmentId: `sha256:${'b'.repeat(64)}`,
  mediaType: 'image/png',
  bytes: 90,
  width: 3,
  height: 2,
  name: 'shot.png',
};

async function until(predicate: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('等太久了');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

const POKE: ScriptedTurn = { content: '', toolCalls: [{ name: 'poke', args: {} }] };

function pokePlugin(onPoke: () => void | Promise<void>): PluginEntry {
  return {
    plugin: {
      name: 'poke',
      apply(registry) {
        registry.tools.register(
          tool(
            async () => {
              await onPoke();
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

async function assemble(turns: readonly ScriptedTurn[], onPoke: () => void | Promise<void>) {
  const model = new ScriptedChatModel({ turns });
  const built = await createNexusAgent({
    model,
    checkpointer: new MemorySaver(),
    plugins: [pokePlugin(onPoke)],
    stepInbox: true,
    summarization: false,
    observationPolicy: false,
  });
  const pump = new ThreadPump(
    built.agent as unknown as PumpAgent,
    'pump-attachments',
    undefined,
    undefined,
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

const blocksOf = (message: BaseMessage | undefined) =>
  (message?.content as { type: string; text?: string; attachment?: unknown }[]).map((b) =>
    b.type === 'text' ? `text:${b.text}` : b.type,
  );

function inboxPushes(frames: readonly Event[]): InboxPayload[] {
  return frames.flatMap((frame) => {
    const data = frame.params.data as { name?: unknown; payload?: unknown } | null;
    return frame.method === 'custom' && data?.name === INBOX ? [data.payload as InboxPayload] : [];
  });
}

describe('開場那句與輪中插話都帶附件', () => {
  it('參照在佇列、日誌、state、重放、推送、歷史裡一致；只有附件的插話不放空文字塊', async () => {
    const run = await assemble(
      [POKE, { content: '收到' }],
      () =>
        void run.pump.submit({
          kind: 'message',
          text: '',
          id: 's1',
          steer: true,
          attachments: [IMAGE],
        }),
    );
    await run.pump.submit({
      kind: 'message',
      text: '開始',
      id: 'm1',
      attachments: [FILE],
    });
    await run.pump.whenIdle();

    // 模型讀到的：開場那句 [檔案, 文字]，插話 [圖]（沒有空文字塊）。
    const humans = (prompt: readonly BaseMessage[]) =>
      prompt.filter((m) => m.getType() === 'human');
    expect(blocksOf(humans(run.model.prompts[0]!)[0])).toEqual(['nexus-file', 'text:開始']);
    expect(blocksOf(humans(run.model.prompts[1]!)[1])).toEqual(['nexus-image']);

    // 日誌：turn/start 與佇列項帶參照（欄位完整）。
    const events = run.pump.sessionLog.events;
    expect(events.find((e) => e.type === 'turn/start')?.data).toMatchObject({
      kind: 'message',
      text: '開始',
      attachments: [FILE],
    });
    const spliced = events.flatMap((e) => (e.type === 'inbox/spliced' ? e.data.inserted : []));
    expect(spliced.map((item) => item.attachments)).toEqual([[FILE], [IMAGE]]);

    // state（存檔點）與重放逐位一致：兩個人的訊息的內容區塊同形。
    const state = (await run.built.agent.getState({
      configurable: { thread_id: 'pump-attachments' },
    })) as { values: { messages: BaseMessage[] } };
    const replay = replayConversation(events);
    if (replay.kind !== 'replayed') throw new Error('日誌重放不出來');
    const humanContents = (messages: readonly BaseMessage[]) =>
      messages.filter((m) => m.getType() === 'human').map((m) => JSON.stringify(m.content));
    expect(humanContents(replay.messages)).toEqual(humanContents(state.values.messages));
    expect(JSON.stringify(state.values.messages)).not.toContain('base64');

    // 推送：排隊的與被領走的都帶 attachments。
    await until(() => inboxPushes(run.frames).some((p) => p.claimedNextStep !== undefined));
    const pushes = inboxPushes(run.frames);
    expect(pushes.find((p) => p.claimed !== undefined)?.claimed?.attachments).toEqual([FILE]);
    expect(
      pushes.find((p) => p.claimedNextStep !== undefined)?.claimedNextStep?.[0]?.attachments,
    ).toEqual([IMAGE]);
    expect(pushes.flatMap((p) => p.nextStep ?? []).map((item) => item.attachments)).toContainEqual([
      IMAGE,
    ]);

    // 歷史：人的那兩則 message-start 帶 attachments，文字只有文字塊。
    const starts = historyFrames(events, 100_000).filter(
      (frame) =>
        frame.method === 'messages' &&
        (frame.params.data as { event?: string; role?: string }).event === 'message-start' &&
        (frame.params.data as { role?: string }).role === 'human',
    );
    expect(starts.map((f) => (f.params.data as { attachments?: unknown }).attachments)).toEqual([
      [FILE],
      [IMAGE],
    ]);
  }, 20000);
});

describe('排著的一件改文字', () => {
  it('附件原樣保留，開跑時 turn/start 帶著它', async () => {
    const hold = gate();
    const run = await assemble([POKE, { content: '一' }, { content: '二' }], async () => {
      await hold.opened;
    });
    const first = run.pump.submit({ kind: 'message', text: '第一句', id: 'm1' });
    await until(() => run.pump.sessionLog.events.some((e) => e.type === 'model/start'));
    // 第一輪停在工具裡：這一句只能排隊。
    void run.pump.submit({ kind: 'message', text: '舊文字', id: 'm2', attachments: [FILE, IMAGE] });
    await until(() =>
      run.pump.sessionLog.events.some(
        (e) => e.type === 'inbox/spliced' && e.data.inserted.some((item) => item.id === 'm2'),
      ),
    );
    expect(run.pump.updateQueue('m2', { kind: 'edit', text: '新文字' })).toBe('updated');
    hold.open();
    await first;
    await run.pump.whenIdle();

    const edited = run.pump.sessionLog.events.flatMap((e) =>
      e.type === 'inbox/spliced' && e.data.outcome === 'canceled' ? e.data.inserted : [],
    );
    expect(edited).toEqual([
      { id: 'm2', text: '新文字', source: { kind: 'user' }, attachments: [FILE, IMAGE] },
    ]);
    const starts = run.pump.sessionLog.events.filter((e) => e.type === 'turn/start');
    expect(starts.at(-1)?.data).toMatchObject({
      kind: 'message',
      text: '新文字',
      attachments: [FILE, IMAGE],
    });
  }, 20000);
});

/**
 * **點名子代理的一句話在 pump 裡的走法**（[#328](https://github.com/DemianLi/nexus-agent/issues/328) 第 2 項）：開場那句、輪中插話、
 * 排隊後改文字、重放與歷史。真的 `createNexusAgent`＋`ThreadPump`，模型是腳本（`ScriptedChatModel`）。
 *
 * 量的是**點名怎麼在佇列、日誌、state、推送、歷史裡走**，以及模型到底讀到什麼：使用者那句話之後接一個提示區塊；
 * 沒點名的訊息跟以前逐位元組相同（回歸絆索）。接線與驗證（名字、形狀）在 `subagent-mention-wire.test.ts`。
 *
 * **零憑證、零外部連線**。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { tool } from '@langchain/core/tools';
import type { BaseMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import {
  foldInbox,
  mentionHintText,
  replayConversation,
  SESSION_LOG_FORMAT_VERSION,
} from '@nexus/core';
import type { PluginEntry, SessionEvent, SubagentMentionRef } from '@nexus/core';
import type { Event, InboxPayload } from '@nexus/wire';
import { INBOX } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import { historyFrames } from './conversation-history.js';
import { openJsonlSessionStore } from './jsonl-session-store.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

const MENTION: SubagentMentionRef = { kind: 'subagent', name: 'reviewer' };
const OTHER: SubagentMentionRef = { kind: 'subagent', name: 'writer' };

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
    'pump-mention',
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

const humans = (prompt: readonly BaseMessage[]) => prompt.filter((m) => m.getType() === 'human');

/** 一則人話的內容區塊，文字塊寫成 `text:…`。 */
const blocksOf = (message: BaseMessage | undefined) =>
  (message?.content as { type: string; text?: string }[]).map((b) =>
    b.type === 'text' ? `text:${b.text}` : b.type,
  );

function inboxPushes(frames: readonly Event[]): InboxPayload[] {
  return frames.flatMap((frame) => {
    const data = frame.params.data as { name?: unknown; payload?: unknown } | null;
    return frame.method === 'custom' && data?.name === INBOX ? [data.payload as InboxPayload] : [];
  });
}

const humanStarts = (events: readonly Event[]) =>
  events.filter(
    (frame) =>
      frame.method === 'messages' &&
      (frame.params.data as { event?: string; role?: string }).event === 'message-start' &&
      (frame.params.data as { role?: string }).role === 'human',
  );

describe('開場那句與輪中插話都帶點名', () => {
  it('模型讀到：文字在前、提示區塊在後；日誌、佇列、推送、state／重放、歷史一致；歷史的泡泡文字不含提示', async () => {
    const run = await assemble(
      [POKE, { content: '收到' }],
      () =>
        void run.pump.submit({
          kind: 'message',
          text: '再看這個',
          id: 's1',
          steer: true,
          mention: OTHER,
        }),
    );
    await run.pump.submit({ kind: 'message', text: '開始', id: 'm1', mention: MENTION });
    await run.pump.whenIdle();

    // 模型讀到的：開場那句 [文字, 提示]，插話 [文字, 提示]。
    expect(blocksOf(humans(run.model.prompts[0]!)[0])).toEqual([
      'text:開始',
      `text:${mentionHintText(MENTION)}`,
    ]);
    expect(blocksOf(humans(run.model.prompts[1]!)[1])).toEqual([
      'text:再看這個',
      `text:${mentionHintText(OTHER)}`,
    ]);

    // 日誌：turn/start 與佇列項帶點名。
    const events = run.pump.sessionLog.events;
    expect(events.find((e) => e.type === 'turn/start')?.data).toMatchObject({
      kind: 'message',
      text: '開始',
      mention: MENTION,
    });
    const spliced = events.flatMap((e) => (e.type === 'inbox/spliced' ? e.data.inserted : []));
    expect(spliced.map((item) => item.mention)).toEqual([MENTION, OTHER]);

    // state（存檔點）與重放逐位一致。
    const state = (await run.built.agent.getState({
      configurable: { thread_id: 'pump-mention' },
    })) as { values: { messages: BaseMessage[] } };
    const replay = replayConversation(events);
    if (replay.kind !== 'replayed') throw new Error('日誌重放不出來');
    const humanContents = (messages: readonly BaseMessage[]) =>
      messages.filter((m) => m.getType() === 'human').map((m) => JSON.stringify(m.content));
    expect(humanContents(replay.messages)).toEqual(humanContents(state.values.messages));

    // 推送：排隊的與被領走的都帶 mention。
    await until(() => inboxPushes(run.frames).some((p) => p.claimedNextStep !== undefined));
    const pushes = inboxPushes(run.frames);
    expect(pushes.find((p) => p.claimed !== undefined)?.claimed?.mention).toEqual(MENTION);
    expect(
      pushes.find((p) => p.claimedNextStep !== undefined)?.claimedNextStep?.[0]?.mention,
    ).toEqual(OTHER);
    expect(pushes.flatMap((p) => p.nextStep ?? []).map((item) => item.mention)).toContainEqual(
      OTHER,
    );

    // 歷史：開場那句讀 turn/start、插話從訊息裡的提示區塊讀回；兩則的泡泡文字都是使用者打的字，不含提示。
    const starts = humanStarts(historyFrames(events, 100_000));
    expect(starts.map((f) => (f.params.data as { mention?: unknown }).mention)).toEqual([
      MENTION,
      OTHER,
    ]);
    const historyText = historyFrames(events, 100_000)
      .filter((frame) => frame.method === 'messages')
      .map((frame) => JSON.stringify(frame.params.data))
      .join('\n');
    expect(historyText).toContain('再看這個');
    expect(historyText).not.toContain('system-reminder');
  }, 20000);

  it('沒點名的話跟以前逐位元組相同：內容仍是純字串，日誌與佇列項沒有 mention 這個 key', async () => {
    const run = await assemble([{ content: '好' }], () => undefined);
    await run.pump.submit({ kind: 'message', text: '沒點名', id: 'm1' });
    await run.pump.whenIdle();

    expect(humans(run.model.prompts[0]!)[0]?.content).toBe('沒點名');
    const events = run.pump.sessionLog.events;
    const start = events.find((e) => e.type === 'turn/start');
    expect(start !== undefined && 'mention' in start.data).toBe(false);
    for (const e of events) {
      if (e.type === 'inbox/spliced') {
        for (const item of e.data.inserted) expect('mention' in item).toBe(false);
      }
    }
    const starts = humanStarts(historyFrames(events, 100_000));
    expect('mention' in (starts[0]!.params.data as object)).toBe(false);
  });
});

describe('排著的一件', () => {
  it('改文字：點名原樣保留，開跑時 turn/start 帶著它；佇列在日誌裡折回來還在（重啟之後排著的那件）', async () => {
    const hold = gate();
    const run = await assemble([POKE, { content: '一' }, { content: '二' }], async () => {
      await hold.opened;
    });
    const first = run.pump.submit({ kind: 'message', text: '第一句', id: 'm1' });
    await until(() => run.pump.sessionLog.events.some((e) => e.type === 'model/start'));
    // 第一輪停在工具裡：這一句只能排隊。
    void run.pump.submit({ kind: 'message', text: '舊文字', id: 'm2', mention: MENTION });
    await until(() =>
      run.pump.sessionLog.events.some(
        (e) => e.type === 'inbox/spliced' && e.data.inserted.some((item) => item.id === 'm2'),
      ),
    );

    // 還排著的時候從日誌折出佇列（重啟之後走的那條）：點名還在。
    const folded = foldInbox(run.pump.sessionLog.events);
    expect(folded['next-turn'].map((item) => item.mention)).toEqual([MENTION]);

    expect(run.pump.updateQueue('m2', { kind: 'edit', text: '新文字' })).toBe('updated');
    hold.open();
    await first;
    await run.pump.whenIdle();

    const edited = run.pump.sessionLog.events.flatMap((e) =>
      e.type === 'inbox/spliced' && e.data.outcome === 'canceled' ? e.data.inserted : [],
    );
    expect(edited).toEqual([
      { id: 'm2', text: '新文字', source: { kind: 'user' }, mention: MENTION },
    ]);
    const starts = run.pump.sessionLog.events.filter((e) => e.type === 'turn/start');
    expect(starts.at(-1)?.data).toMatchObject({
      kind: 'message',
      text: '新文字',
      mention: MENTION,
    });
    expect(blocksOf(humans(run.model.prompts.at(-1)!).at(-1))).toEqual([
      'text:新文字',
      `text:${mentionHintText(MENTION)}`,
    ]);
  }, 20000);
});

describe('落盤再讀回', () => {
  it('turn/start、佇列項、插話訊息裡的點名都經得起 JSONL 往返：讀回的事件與寫出去的逐位相同，重放與折佇列看到同一份', async () => {
    const hold = gate();
    const run = await assemble([POKE, { content: '一' }, { content: '二' }], async () => {
      await hold.opened;
    });
    const first = run.pump.submit({ kind: 'message', text: '第一句', id: 'm1', mention: MENTION });
    await until(() => run.pump.sessionLog.events.some((e) => e.type === 'model/start'));
    // 第一輪停在工具裡：這一句排隊，另一句插話。
    void run.pump.submit({ kind: 'message', text: '排著', id: 'm2', mention: OTHER });
    void run.pump.submit({ kind: 'message', text: '插話', id: 's1', steer: true, mention: OTHER });
    await until(() =>
      run.pump.sessionLog.events.some(
        (e) => e.type === 'inbox/spliced' && e.data.inserted.some((item) => item.id === 's1'),
      ),
    );
    hold.open();
    await first;
    await run.pump.whenIdle();

    const events = [...run.pump.sessionLog.events];
    const dir = await mkdtemp(join(tmpdir(), 'nexus-mention-roundtrip-'));
    try {
      const store = openJsonlSessionStore({ directory: dir });
      const stored = store.create({
        version: SESSION_LOG_FORMAT_VERSION,
        id: 'mention-roundtrip',
        createdAt: 1,
        cwd: '/tmp',
      });
      await stored.append(events);
      await stored.close();
      const back = await openJsonlSessionStore({ directory: dir })
        .open('mention-roundtrip', 'read')
        .then((reader) => reader.read());

      expect(JSON.parse(JSON.stringify(back))).toEqual(JSON.parse(JSON.stringify(events)));
      const starts = back.filter((e) => e.type === 'turn/start');
      expect(starts.map((e) => (e.data as { mention?: unknown }).mention)).toContainEqual(MENTION);

      // 讀回來的重放：每則人話的內容逐位等於現場重放（含提示區塊）。
      const humanContents = (list: readonly SessionEvent[]) => {
        const replay = replayConversation(list);
        if (replay.kind !== 'replayed') throw new Error('日誌重放不出來');
        return replay.messages
          .filter((m) => m.getType() === 'human')
          .map((m) => JSON.stringify(m.content));
      };
      expect(humanContents(back)).toEqual(humanContents(events));
      expect(humanContents(back).join('\n')).toContain(mentionHintText(OTHER).slice(0, 20));
      // 折佇列：被領走之前的任何一刻都看得到點名（取排進去那一刻的日誌）。
      const queuedAt = back.findIndex(
        (e) => e.type === 'inbox/spliced' && e.data.inserted.some((item) => item.id === 'm2'),
      );
      expect(
        foldInbox(back.slice(0, queuedAt + 1))['next-turn'].map((item) => item.mention),
      ).toEqual([OTHER]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20000);
});

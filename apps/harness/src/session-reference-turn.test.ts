/**
 * 引用別的會話的輪次行為（[#713](https://github.com/DemianLi/nexus-agent/issues/713) 的準備那一半）：一句話 `@` 了別的會話，
 * 領走的那一刻把它凍成一則快照，附在那句話後面送進模型。
 *
 * 真的組裝（`createNexusAgent({ stepInbox: true })`＋`ScriptedChatModel`）加一條 pump，讀端換成記憶體裡的替身。問的是：
 * 模型真的讀到了什麼、日誌的先後、推回模型等不等於 checkpoint、失敗與取消怎麼收、畫面與歷史怎麼畫。
 * 解析、投影、預算的細節在 `session-reference.test.ts`。**零憑證、零外部連線**。
 */

import type { BaseMessage } from '@langchain/core/messages';
import { AIMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import {
  replayConversation,
  SESSION_LOG_FORMAT_VERSION,
  SessionLog,
  toLoggedMessage,
} from '@nexus/core';
import type { PluginEntry, SessionEvent, StoredSessionHeader } from '@nexus/core';
import type { Event, InboxPayload } from '@nexus/wire';
import {
  emptyConversation,
  formatSessionReferenceMention,
  INBOX,
  reduceAll,
  SessionReferenceError,
} from '@nexus/wire';
import { createMiddleware } from 'langchain';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import { historyPage } from './conversation-history.js';
import { emptyCommandPoint, loopbackRequest, TEST_BROWSER_AUTH } from './fixtures.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent, PumpInput } from './thread-pump.js';
import type { SessionReferenceReader } from './session-reference.js';
import { createWireHandler } from './wire-handler.js';
import { composeAttachSessions } from './session-attach.js';

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

const mention = (sessionId: string, label = sessionId) =>
  formatSessionReferenceMention({ sessionId, label });

const steer = (text: string, id: string): PumpInput => ({ kind: 'message', text, id, steer: true });

/** 被引用的那條會話：一問一答。 */
function source(id: string, said: string, answered: string) {
  const log = new SessionLog(id);
  log.append('turn/start', { kind: 'message', text: said });
  log.append('assistant/message', { message: toLoggedMessage(new AIMessage(answered)) });
  log.append('turn/end', {});
  const header: StoredSessionHeader = {
    version: SESSION_LOG_FORMAT_VERSION,
    id,
    createdAt: 1,
    cwd: '/專案/甲',
  };
  return { header, events: log.events };
}

interface FakeReader extends SessionReferenceReader {
  readonly reads: string[];
  /** 之後的每一次讀都等這一道閘。 */
  hold(opened: Promise<void>): void;
  /** 之後的每一次讀都失敗。 */
  failWith(error: Error): void;
}

function fakeReader(
  sessions: Record<string, { header: StoredSessionHeader; events: readonly SessionEvent[] }>,
): FakeReader {
  const reads: string[] = [];
  let held: Promise<void> | undefined;
  let failure: Error | undefined;
  return {
    reads,
    hold: (opened) => (held = opened),
    failWith: (error) => (failure = error),
    read: async (sessionId) => {
      reads.push(sessionId);
      await held;
      if (failure !== undefined) throw failure;
      const found = sessions[sessionId];
      if (found === undefined) throw new Error(`找不到 ${sessionId}`);
      return found;
    },
  };
}

function marks(events: readonly SessionEvent[]): string[] {
  return events.flatMap((event) => {
    switch (event.type) {
      case 'turn/start': {
        const data = event.data as { kind: string; text?: string };
        return [`start:${data.kind}${data.text === undefined ? '' : `:${data.text}`}`];
      }
      case 'turn/end':
        return [event.data.reason?.kind === 'aborted' ? 'end:aborted' : 'end'];
      case 'turn/failed':
        return ['failed'];
      case 'inbox/spliced': {
        const { target, removedCount } = event.data;
        return removedCount === undefined
          ? []
          : [`${target === 'next-step' ? 'step' : 'turn'}:claim`];
      }
      case 'user/message':
        return event.data.source.kind === 'user'
          ? [`steer:${String(event.data.message.data.content)}`]
          : event.data.source.kind === 'session-reference'
            ? ['snapshot']
            : [`injected`];
      case 'model/start':
        return ['model'];
      default:
        return [];
    }
  });
}

function humanTexts(prompt: readonly BaseMessage[] | undefined): string[] {
  return (prompt ?? []).filter((message) => message.getType() === 'human').map((m) => m.text);
}

function inboxPushes(frames: readonly Event[]): InboxPayload[] {
  return frames.flatMap((frame) => {
    const data = frame.params.data as { name?: unknown; payload?: unknown } | null;
    return frame.method === 'custom' && data?.name === INBOX ? [data.payload as InboxPayload] : [];
  });
}

interface Hooks {
  onPoke?: (call: number) => void;
}

function pokePlugin(hooks: Hooks): PluginEntry {
  let pokes = 0;
  return {
    plugin: {
      name: 'reference-poke',
      apply(registry) {
        registry.tools.register(
          tool(
            async () => {
              pokes += 1;
              hooks.onPoke?.(pokes);
              return 'poked';
            },
            { name: 'poke', description: '戳一下。', schema: z.object({}) },
          ),
        );
        registry.middleware.use(createMiddleware({ name: 'referencePoke' }));
      },
    },
  };
}

const POKE: ScriptedTurn = { content: '', toolCalls: [{ name: 'poke', args: {} }] };

const runs: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(runs.splice(0).map((run) => run.close()));
});

async function assemble(
  turns: readonly ScriptedTurn[],
  reader: SessionReferenceReader | undefined,
  options: { hooks?: Hooks; stepInbox?: boolean } = {},
) {
  const model = new ScriptedChatModel({ turns });
  const stepInbox = options.stepInbox ?? true;
  const built = await createNexusAgent({
    model,
    checkpointer: new MemorySaver(),
    plugins: [pokePlugin(options.hooks ?? {})],
    stepInbox,
  });
  const pump = new ThreadPump(
    built.agent as unknown as PumpAgent,
    'me',
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    built.stepInbox,
    reader,
  );
  const detach = built.attachSession(pump.sessions);
  const frames: Event[] = [];
  const line = new AbortController();
  const stream = pump.subscribe(['messages', 'tools', 'lifecycle', 'input', 'custom'], line.signal);
  const draining = (async () => {
    for await (const frame of stream) frames.push(frame);
  })();
  const run = {
    model,
    built,
    pump,
    frames,
    marks: () => marks(pump.sessionLog.events),
    close: async () => {
      pump.close();
      line.abort();
      await draining;
      detach();
      await built.dispose();
    },
  };
  runs.push(run);
  return run;
}

const A = source('a', '甲的問題', '甲的回答');
const B = source('b', '乙的問題', '乙的回答');

describe('一輪開頭的那一句 @ 了別的會話', () => {
  it('模型讀到換過的人話與一則快照；日誌先記人話（turn/start）再記快照，快照緊跟在領走之後', async () => {
    const reader = fakeReader({ a: A });
    const run = await assemble([{ content: '看完了' }], reader);
    await run.pump.submit({
      kind: 'message',
      text: `幫我看 ${mention('a', '甲')} 這份`,
      id: 'm1',
    });
    await run.pump.whenIdle();

    expect(reader.reads).toEqual(['a']);
    const prompt = run.model.prompts[0]!;
    const humans = prompt.filter((message) => message.getType() === 'human');
    expect(humans.map((message) => message.text)[0]).toBe('幫我看 @甲 這份');
    expect(humans).toHaveLength(2);
    expect(humans[1]!.text).toContain('<referenced-sessions>');
    expect(humans[1]!.text).toContain('甲的問題');
    expect(humans[1]!.id).toBe('m1:session-reference');

    // 日誌上的人話是換過的那份，網址不在裡面。
    const start = run.pump.sessionLog.events.find((event) => event.type === 'turn/start')!;
    expect((start.data as { text: string }).text).toBe('幫我看 @甲 這份');
    expect(run.marks()).toEqual([
      'start:message:幫我看 @甲 這份',
      'turn:claim',
      'snapshot',
      'model',
      'end',
    ]);
    const snapshot = run.pump.sessionLog.events.find(
      (event) => event.type === 'user/message',
    ) as SessionEvent<'user/message'>;
    expect(snapshot.data.source).toMatchObject({
      kind: 'session-reference',
      form: 'recall',
      version: 1,
      references: [{ sessionId: 'a', label: '甲', inputIndex: 0 }],
    });
  });

  it('後面每一次叫模型都帶著同一則快照，不再領一次、不重讀', async () => {
    const reader = fakeReader({ a: A });
    const run = await assemble([POKE, { content: '好' }], reader);
    await run.pump.submit({ kind: 'message', text: `看 ${mention('a', '甲')}`, id: 'm1' });
    await run.pump.whenIdle();
    expect(run.model.prompts).toHaveLength(2);
    expect(reader.reads).toEqual(['a']);
    const snapshotsIn = (prompt: readonly BaseMessage[]) =>
      prompt.filter((message) => message.id === 'm1:session-reference').length;
    expect(snapshotsIn(run.model.prompts[0]!)).toBe(1);
    expect(snapshotsIn(run.model.prompts[1]!)).toBe(1);
    expect(run.marks().filter((mark) => mark === 'snapshot')).toHaveLength(1);
  });

  it('推回模型的那一串等於 checkpoint：重開之後快照原樣在，不重讀（凍住）', async () => {
    const reader = fakeReader({ a: A });
    const run = await assemble([{ content: '好' }], reader);
    await run.pump.submit({ kind: 'message', text: `看 ${mention('a', '甲')}`, id: 'm1' });
    await run.pump.whenIdle();
    const state = (await run.built.agent.getState({ configurable: { thread_id: 'me' } })) as {
      values: { messages: BaseMessage[] };
    };
    const replay = replayConversation(run.pump.sessionLog.events);
    expect(replay.kind).toBe('replayed');
    const shape = (messages: readonly BaseMessage[]) =>
      // 一輪開頭那句人話的 id 是基座隨機給的（日誌上沒有），只比快照的 id。
      messages.map(
        (message) =>
          `${message.getType()}:${message.id?.endsWith(':session-reference') === true ? message.id : ''}:${message.text}`,
      );
    expect(shape((replay as { messages: readonly BaseMessage[] }).messages)).toEqual(
      shape(state.values.messages),
    );
  });

  it('多條引用：一則快照裡按出現先後放，各讀一次；重複的只讀一次', async () => {
    const reader = fakeReader({ a: A, b: B });
    const run = await assemble([{ content: '好' }], reader);
    await run.pump.submit({
      kind: 'message',
      text: `比較 ${mention('a', '甲')} 和 ${mention('b', '乙')}，再看 ${mention('a', '甲')}`,
      id: 'm1',
    });
    await run.pump.whenIdle();
    expect(reader.reads.sort()).toEqual(['a', 'b']);
    const snapshot = run.model.prompts[0]!.find(
      (message) => message.id === 'm1:session-reference',
    )!;
    expect(snapshot.text.indexOf('甲的問題')).toBeGreaterThan(-1);
    expect(snapshot.text.indexOf('甲的問題')).toBeLessThan(snapshot.text.indexOf('乙的問題'));
  });

  it('推送：claimed 帶換過的字與引用；即時折疊出一則人話（不畫快照），引用標記掛在人話上', async () => {
    const run = await assemble([{ content: '好' }], fakeReader({ a: A }));
    await run.pump.submit({ kind: 'message', text: `看 ${mention('a', '甲')}`, id: 'm1' });
    await run.pump.whenIdle();
    await until(() => inboxPushes(run.frames).some((push) => push.claimed !== undefined));
    const claimed = inboxPushes(run.frames).find((push) => push.claimed !== undefined)!.claimed;
    expect(claimed).toEqual({
      id: 'm1',
      text: '看 @甲',
      references: [{ sessionId: 'a', label: '甲' }],
    });
    const state = reduceAll(emptyConversation(), run.frames);
    const humans = state.entries.filter((entry) => entry.kind === 'human');
    expect(humans).toHaveLength(1);
    expect(humans[0]).toMatchObject({
      text: '看 @甲',
      references: [{ sessionId: 'a', label: '甲' }],
    });
  });

  it('歷史：人話畫一則、引用標記掛在人話上，快照不畫成泡泡；沒引用的人話不帶這一格', async () => {
    const run = await assemble([{ content: '好' }, { content: '再好' }], fakeReader({ a: A }));
    await run.pump.submit({ kind: 'message', text: `看 ${mention('a', '甲')}`, id: 'm1' });
    await run.pump.submit({ kind: 'message', text: '沒有引用的下一句', id: 'm2' });
    await run.pump.whenIdle();
    const state = reduceAll(emptyConversation(), historyPage(run.pump.sessionLog.events).events);
    const humans = state.entries.filter((entry) => entry.kind === 'human');
    expect(humans.map((entry) => entry.text)).toEqual(['看 @甲', '沒有引用的下一句']);
    expect(humans[0]).toMatchObject({ references: [{ sessionId: 'a', label: '甲' }] });
    expect(humans[1]).not.toHaveProperty('references');
  });
});

describe('輪中插的話 @ 了別的會話', () => {
  it('插話在前、它的快照緊跟在後；推送的 claimedNextStep 帶引用；排著的那份仍是原文', async () => {
    const reader = fakeReader({ a: A });
    let queuedText: string | undefined;
    const run = await assemble([POKE, { content: '收到' }], reader, {
      hooks: {
        onPoke: () => {
          void run.pump.submit(steer(`改看 ${mention('a', '甲')}`, 's1'));
          queuedText = run.pump.nextStep[0]?.text;
        },
      },
    });
    await run.pump.submit({ kind: 'message', text: '開始', id: 'm1' });
    await run.pump.whenIdle();

    expect(queuedText).toBe(`改看 ${mention('a', '甲')}`);
    expect(run.marks()).toEqual([
      'start:message:開始',
      'turn:claim',
      'model',
      'step:claim',
      'steer:改看 @甲',
      'snapshot',
      'model',
      'end',
    ]);
    // 工具結果加插話加快照：推回模型的那一串等於 checkpoint（重開之後順序不會錯位）。
    const state = (await run.built.agent.getState({ configurable: { thread_id: 'me' } })) as {
      values: { messages: BaseMessage[] };
    };
    const replay = replayConversation(run.pump.sessionLog.events);
    expect(replay.kind).toBe('replayed');
    const shape = (messages: readonly BaseMessage[]) =>
      messages.map(
        (message) =>
          `${message.getType()}:${message.id?.endsWith(':session-reference') === true ? message.id : ''}:${message.text}`,
      );
    expect(shape((replay as { messages: readonly BaseMessage[] }).messages)).toEqual(
      shape(state.values.messages),
    );
    const second = run.model.prompts[1]!;
    expect(humanTexts(second)[1]).toBe('改看 @甲');
    expect(second.at(-1)!.id).toBe('s1:session-reference');
    await until(() => inboxPushes(run.frames).some((push) => push.claimedNextStep !== undefined));
    expect(
      inboxPushes(run.frames).find((push) => push.claimedNextStep !== undefined)!.claimedNextStep,
    ).toEqual([{ id: 's1', text: '改看 @甲', references: [{ sessionId: 'a', label: '甲' }] }]);
  });

  it('準備到一半又來了一句插話：它不被這一次領走吞掉，留在 next-step 由下一次領', async () => {
    const reader = fakeReader({ a: A });
    const held = gate();
    const run = await assemble([POKE, { content: '說完了' }, { content: '收到後來的' }], reader, {
      hooks: {
        onPoke: () => {
          reader.hold(held.opened);
          void run.pump.submit(steer(`改看 ${mention('a', '甲')}`, 's1'));
        },
      },
    });
    const done = run.pump.submit({ kind: 'message', text: '開始', id: 'm1' });
    await until(() => reader.reads.length === 1);
    await run.pump.submit(steer('後來的一句', 's2'));
    expect(run.pump.nextStep.map((item) => item.id)).toEqual(['s2']);
    held.open();
    await done;
    await run.pump.whenIdle();
    const last = run.model.prompts.at(-1)!;
    expect(humanTexts(last)).toHaveLength(4);
    expect(humanTexts(last)[1]).toBe('改看 @甲');
    expect(
      last.map((message) => message.id).filter((id) => id === 's1:session-reference'),
    ).toHaveLength(1);
    expect(humanTexts(last)[3]).toBe('後來的一句');
    expect(run.pump.nextStep).toEqual([]);
  });
});

describe('準備失敗與取消', () => {
  it('讀不了：這一輪失敗（lifecycle failed 帶原因），模型一次都沒叫，日誌不留快照', async () => {
    const reader = fakeReader({ a: A });
    reader.failWith(new Error('磁碟壞了'));
    const run = await assemble([{ content: '不會被叫到' }], reader);
    await expect(
      run.pump.submit({ kind: 'message', text: `看 ${mention('a', '甲')}`, id: 'm1' }),
    ).rejects.toThrow('磁碟壞了');
    await run.pump.whenIdle();
    expect(run.model.prompts).toHaveLength(0);
    expect(run.marks()).toEqual(['start:message:看 @甲', 'turn:claim', 'failed']);
    const failed = run.frames.filter(
      (frame) =>
        frame.method === 'lifecycle' &&
        (frame.params.data as { event?: string }).event === 'failed',
    );
    expect(failed).toHaveLength(1);
    expect(JSON.stringify(failed[0]!.params.data)).toContain('磁碟壞了');
  });

  it('準備到一半按停止：不等讀完就收成中止，不算失敗；讀完之後也不會補記快照', async () => {
    const reader = fakeReader({ a: A });
    const held = gate();
    reader.hold(held.opened);
    const run = await assemble([{ content: '不會被叫到' }], reader);
    const done = run.pump.submit({ kind: 'message', text: `看 ${mention('a', '甲')}`, id: 'm1' });
    await until(() => reader.reads.length === 1);
    run.pump.cancel();
    await done;
    await run.pump.whenIdle();
    held.open();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(run.model.prompts).toHaveLength(0);
    expect(run.marks()).toEqual(['start:message:看 @甲', 'turn:claim', 'end:aborted']);
  });
});

describe('收下的時候就驗（referencedText）', () => {
  it('壞掉的、引用自己、太多條：各拋各的碼，什麼都沒進佇列', async () => {
    const run = await assemble([], fakeReader({}));
    const codeOf = (text: string) => {
      try {
        run.pump.referencedText(text);
        return undefined;
      } catch (error: unknown) {
        return (error as SessionReferenceError).code;
      }
    };
    expect(codeOf('@[壞](nexus-session:!!!)')).toBe('SESSION_REFERENCE_INVALID_REFERENCE');
    expect(codeOf(mention('me'))).toBe('SESSION_REFERENCE_SELF_REFERENCE');
    expect(codeOf([1, 2, 3, 4].map((n) => mention(`s${n}`)).join(' '))).toBe(
      'SESSION_REFERENCE_TOO_MANY',
    );
    expect(codeOf('沒有引用')).toBeUndefined();
    expect(run.pump.inbox).toEqual([]);
  });

  it('沒接讀會話的載體，或圖裡沒掛插話的載體：有引用就不收（不悄悄收下再不展開）', async () => {
    for (const [reader, stepInbox] of [
      [undefined, true],
      [fakeReader({ a: A }), false],
    ] as const) {
      const run = await assemble([], reader, { stepInbox });
      expect(() => run.pump.referencedText(`看 ${mention('a')}`)).toThrow(
        expect.objectContaining({ code: 'SESSION_REFERENCE_INVALID_CONFIG' }) as Error,
      );
      // 沒有引用的照收。
      expect(run.pump.referencedText('一般的一句').references).toEqual([]);
    }
  });
});

describe('wire：收下那句話的時候就驗，壞的不進佇列', () => {
  async function wire(reader: SessionReferenceReader | undefined) {
    const model = new ScriptedChatModel({ turns: [{ content: '好' }] });
    const built = await createNexusAgent({
      model,
      checkpointer: new MemorySaver(),
      plugins: [],
      stepInbox: true,
    });
    let logOf: (() => readonly SessionEvent[]) | undefined;
    const handler = createWireHandler({
      auth: TEST_BROWSER_AUTH,
      ...(reader === undefined ? {} : { sessionReferenceReader: reader }),
      createAgent: async () => ({
        agent: built.agent as unknown as PumpAgent,
        stepInbox: true,
        commands: emptyCommandPoint(),
        dispose: async () => {},
        attachSessions: (sessions, backgroundPort) => {
          logOf = () => sessions.root.events;
          return composeAttachSessions(built)(sessions, backgroundPort);
        },
      }),
    });
    runs.push({
      close: async () => {
        await handler.close();
        await built.dispose();
      },
    });
    let nextId = 1;
    const raw = async (method: string, params: unknown) => {
      const response = await handler.handle(
        loopbackRequest(`http://ref.test/threads/wire/commands/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: nextId++, method, params }),
        }),
      );
      return (await response.json()) as Record<string, unknown>;
    };
    const start = (text: string) =>
      raw('run.start', {
        assistant_id: 'nexus',
        input: { messages: [{ role: 'user', content: text }] },
      });
    return { raw, start, model, log: () => logOf?.() ?? [] };
  }

  it('run.start：壞掉的、引用自己、太多條都回 invalid_argument 帶碼，那句話沒進佇列、沒開輪', async () => {
    const { start, log } = await wire(fakeReader({ a: A }));
    for (const [text, code] of [
      ['@[壞](nexus-session:!!!)', 'SESSION_REFERENCE_INVALID_REFERENCE'],
      [mention('wire'), 'SESSION_REFERENCE_SELF_REFERENCE'],
      [[1, 2, 3, 4].map((n) => mention(`s${n}`)).join(' '), 'SESSION_REFERENCE_TOO_MANY'],
    ] as const) {
      const response = await start(text);
      expect(response).toMatchObject({ type: 'error', error: 'invalid_argument' });
      expect(String(response.message)).toContain(code);
    }
    expect(
      log().filter((event) => event.type === 'inbox/spliced' || event.type === 'turn/start'),
    ).toEqual([]);
  });

  it('這台 server 沒接讀會話的載體：有引用的 run.start 回 invalid_argument（INVALID_CONFIG），沒引用的照收', async () => {
    const { start, log } = await wire(undefined);
    const rejected = await start(`看 ${mention('a', '甲')}`);
    expect(rejected).toMatchObject({ type: 'error', error: 'invalid_argument' });
    expect(String(rejected.message)).toContain('SESSION_REFERENCE_INVALID_CONFIG');
    expect(await start('一般的一句')).toMatchObject({ type: 'success' });
    await until(() => log().some((event) => event.type === 'turn/end'));
  });

  it('合法的引用收下、開輪，模型讀到快照；queue.update 的 edit 同樣先驗', async () => {
    const reader = fakeReader({ a: A });
    const { start, raw, model, log } = await wire(reader);
    expect(await start(`看 ${mention('a', '甲')}`)).toMatchObject({ type: 'success' });
    await until(() => log().some((event) => event.type === 'turn/end'));
    expect(model.prompts[0]!.some((message) => message.id?.endsWith(':session-reference'))).toBe(
      true,
    );

    // 改排著的那一件時：壞的引用不收，原件不動。這裡沒有排著的，item_id 不存在也先驗文字。
    const bad = await raw('queue.update', {
      item_id: 'nobody',
      action: { kind: 'edit', text: '@[壞](nexus-session:!!!)' },
    });
    expect(bad).toMatchObject({ type: 'error', error: 'invalid_argument' });
    expect(String(bad.message)).toContain('SESSION_REFERENCE_INVALID_REFERENCE');
  });
});

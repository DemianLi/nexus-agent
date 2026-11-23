/**
 * 續接灌回 graph state 時，訊息巢狀的值與讀盤的日誌共用、層數用讀盤時記下的（[#2117](https://github.com/DemianLi/nexus-agent/issues/2117)）。
 *
 * 事件一律照讀盤那條路造：一行行 JSON 解出來，交給 `shareStoredEvents`。灌進去走真的 `createNexusAgent` 與 `PrunedMemorySaver`。
 */

import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import {
  replayConversation,
  SESSION_EVENT_MAX_DEPTH,
  shareStoredEvents,
  storedEventDepth,
  toLoggedMessage,
} from '@nexus/core';
import type { SessionEvent } from '@nexus/core';
import { afterEach, describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import {
  CHECKPOINT_DEPTH_EXCEEDED,
  CHECKPOINT_MAX_DEPTH,
  checkpointDepth,
  DepthCheckedSerializer,
} from './checkpoint-serde.js';
import { restoreConversation, toolResultAsSeen } from './conversation-restore.js';
import type { RestorableAgent } from './conversation-restore.js';
import {
  CHECKPOINT_MESSAGE_WRAPPER_DEPTH,
  messageCheckpointDepth,
  PrunedMemorySaver,
} from './pruned-memory-saver.js';
import { ScriptedChatModel } from './scripted-model.js';

const THREAD = 'share';
const config = { configurable: { thread_id: THREAD } };

/** 一份日誌：每顆照順序補 `seq`、`time`，拿去當原料。 */
function lines(events: readonly Pick<SessionEvent, 'type' | 'data'>[]): string[] {
  return events.map((event, seq) => JSON.stringify({ ...event, seq, time: 1 }));
}

/** 讀盤那條路：逐行解、整批交給 `shareStoredEvents`。 */
function readBack(text: readonly string[]): readonly SessionEvent[] {
  return shareStoredEvents(text.map((line) => JSON.parse(line) as SessionEvent));
}

/** 不經過共用的那條路：同樣解出來，但沒凍、沒記層數。 */
function plain(text: readonly string[]): readonly SessionEvent[] {
  return text.map((line) => JSON.parse(line) as SessionEvent);
}

/** `levels` 層物件與陣列交錯的巢狀，最外層是物件。 */
function nested(levels: number): unknown {
  let value: unknown = 'leaf';
  for (let level = 0; level < levels; level++) value = level % 2 ? [value] : { next: value };
  return value;
}

/** 一輪：使用者說話、模型呼叫一次工具、工具回來、模型收尾。 */
function oneTurn(args: Record<string, unknown>): Pick<SessionEvent, 'type' | 'data'>[] {
  return [
    { type: 'turn/start', data: { kind: 'message', text: '查' } },
    {
      type: 'assistant/message',
      // 沒有 `id`：灌進去時 `messagesStateReducer` 要補上（寫 `id` 與 `lc_kwargs.id`）。
      data: {
        message: toLoggedMessage(
          new AIMessage({
            content: [{ type: 'text', text: '查一下' }],
            tool_calls: [{ id: 'c1', name: 'look', args }],
          }),
        ),
      },
    },
    { type: 'tool/call', data: { callId: 'c1', name: 'look', arguments: '{}' } },
    {
      type: 'tool/result',
      data: {
        callId: 'c1',
        isError: false,
        message: toLoggedMessage(
          new ToolMessage({
            content: '結果',
            tool_call_id: 'c1',
            name: 'look',
            artifact: { rows: [{ a: 1 }] },
          }),
        ),
      },
    },
    { type: 'assistant/message', data: { message: toLoggedMessage(new AIMessage('好了')) } },
    { type: 'turn/end', data: {} },
  ] as Pick<SessionEvent, 'type' | 'data'>[];
}

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
});

/**
 * 真的 agent。`langgraph` 的存檔點是產品那顆，量的是寫進存檔點的層數；native 照產品組裝不建存檔點，灌回 thread 之前用同一把尺量
 * （`pruned-memory-saver.ts` 的 `messageCheckpointDepth`）。
 */
async function realAgent(loop: 'langgraph' | 'native' = 'langgraph') {
  const built = await createNexusAgent({
    model: new ScriptedChatModel({ turns: [] }),
    ...(loop === 'langgraph' && { checkpointer: new PrunedMemorySaver() }),
    plugins: [],
    agentLoop: loop,
  });
  disposers.push(() => built.dispose());
  return built.agent;
}

async function stateMessages(agent: Awaited<ReturnType<typeof realAgent>>): Promise<BaseMessage[]> {
  const state = (await agent.getState(config)) as { values: { messages: BaseMessage[] } };
  return state.values.messages;
}

/** 推回的第一則模型回覆與日誌裡那一則。 */
function firstReply(
  messages: readonly BaseMessage[],
  events: readonly SessionEvent[],
): { reply: AIMessage; logged: { data: Record<string, unknown> } } {
  const reply = messages.find((message) => AIMessage.isInstance(message)) as AIMessage;
  const event = events.find((candidate) => candidate.type === 'assistant/message');
  if (event?.type !== 'assistant/message') throw new Error('日誌裡沒有回覆');
  return { reply, logged: event.data.message as unknown as { data: Record<string, unknown> } };
}

/** 舊格式的一輪：回覆只有 `additional_kwargs.tool_calls` 的參數字串 `{v: nested(levels)}`，事件很淺，解析之後才深。 */
function oldFormatTurn(levels: number): readonly SessionEvent[] {
  const argsJson = JSON.stringify({ v: nested(levels) });
  const raw = oneTurn({});
  raw[1] = {
    type: 'assistant/message',
    data: {
      message: {
        type: 'ai',
        data: {
          content: '',
          additional_kwargs: {
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'look', arguments: argsJson } },
            ],
          },
        },
      },
    },
  } as Pick<SessionEvent, 'type' | 'data'>;
  return readBack(lines(raw));
}

/** 舊格式那一則推出來的回覆，照存檔點的尺量有幾層。 */
function oldFormatDepth(levels: number): number {
  const replay = replayConversation(oldFormatTurn(levels), { toolResultAsSeen, shareStored: true });
  if (replay.kind !== 'replayed') throw new Error('推不出來');
  return messageCheckpointDepth(replay.messages.find((message) => AIMessage.isInstance(message)));
}

describe('巢狀的值與讀盤的日誌共用', () => {
  it('經真的 updateState 寫進去：巢狀的值就是日誌那一份（同一個物件），沒有 id 的那則補上了 id，整則凍過', async () => {
    const agent = await realAgent();
    const events = readBack(lines(oneTurn({ q: { deep: [1, 2] } })));

    await restoreConversation(agent, THREAD, events);

    const messages = await stateMessages(agent);
    const { reply, logged } = firstReply(messages, events);
    const loggedCalls = logged.data['tool_calls'] as { args: unknown }[];
    expect(reply.tool_calls?.[0]?.args).toBe(loggedCalls[0]?.args);
    expect(typeof reply.id).toBe('string');
    expect(reply.lc_kwargs['id']).toBe(reply.id);
    // 層數登記過、`seal` 不量的這則，照樣整則深凍。
    expect(Object.isFrozen(reply)).toBe(true);
    expect(Object.isFrozen(reply.lc_kwargs)).toBe(true);
    const result = messages.find((message) => ToolMessage.isInstance(message)) as ToolMessage;
    expect(Object.isFrozen(result.artifact)).toBe(true);
  });

  it('「推回 → 第一次存檔」之間有人就地改巢狀的值：當場 TypeError，日誌那一份不變', async () => {
    const agent = await realAgent();
    const events = readBack(lines(oneTurn({ q: 'x' })));
    const before = JSON.stringify(events);
    const meddling: RestorableAgent = {
      updateState: async (cfg, values) => {
        const [, reply] = values['messages'] as BaseMessage[];
        (reply as AIMessage).tool_calls![0]!.args['q'] = '被改了';
        return agent.updateState(cfg, values);
      },
    };

    await expect(restoreConversation(meddling, THREAD, events)).rejects.toThrow(TypeError);
    expect(JSON.stringify(events)).toBe(before);
  });

  it.each([
    ['工具參數', (reply: AIMessage) => void (reply.tool_calls![0]!.args['q'] = 1)],
    [
      '內容區塊',
      (reply: AIMessage) => void ((reply.content as { text: string }[])[0]!.text = '改'),
    ],
  ])('寫進存檔點之後就地改%s：當場 TypeError', async (_label, meddle) => {
    const agent = await realAgent();
    const events = readBack(lines(oneTurn({ q: 'x' })));

    await restoreConversation(agent, THREAD, events);

    const { reply } = firstReply(await stateMessages(agent), events);
    expect(() => meddle(reply)).toThrow(TypeError);
  });

  it('沒經過讀盤共用的事件（沒凍）照舊深拷：改得動，改的不是日誌那一份', async () => {
    const events = plain(lines(oneTurn({ q: 'x' })));
    const written: BaseMessage[][] = [];

    await restoreConversation(
      {
        updateState: async (_cfg, values) => {
          written.push(values['messages'] as BaseMessage[]);
          return {};
        },
      },
      THREAD,
      events,
    );

    const { reply, logged } = firstReply(written[0]!, events);
    reply.tool_calls![0]!.args['q'] = '改了';
    expect((logged.data['tool_calls'] as { args: { q: string } }[])[0]?.args.q).toBe('x');
  });
});

describe('層數：讀盤記下的夠淺就不再量，其餘照舊量', () => {
  it('讀盤記下的是 `data` 的層數，算法同寫入那一關；沒經過共用的沒有', () => {
    const text = lines([{ type: 'turn/start', data: { kind: 'message', text: 'a' } }]);
    expect(storedEventDepth(readBack(text)[0]!)).toBe(1);
    expect(storedEventDepth(plain(text)[0]!)).toBeUndefined();
  });

  it('上限一半那麼深的事件：回覆、工具結果、插話推出來的，寫進存檔點只比事件深 3 層以內', () => {
    const half = SESSION_EVENT_MAX_DEPTH / 2;
    // 每一則都在最深的那個欄位放一顆帶 `lc` 鍵的物件：`toJSON` 會把它多包一層 `__lc_escaped__`。
    const deep = (room: number): unknown => ({ lc: 1, v: nested(room) });
    const raw: Pick<SessionEvent, 'type' | 'data'>[] = [
      { type: 'turn/start', data: { kind: 'message', text: '查' } },
      {
        type: 'assistant/message',
        data: {
          message: toLoggedMessage(
            new AIMessage({
              content: '',
              tool_calls: [{ id: 'c1', name: 'look', args: { v: deep(half - 7) } }],
            }),
          ),
        },
      },
      {
        type: 'tool/result',
        data: {
          callId: 'c1',
          isError: false,
          message: toLoggedMessage(
            new ToolMessage({
              content: '結果',
              tool_call_id: 'c1',
              name: 'look',
              artifact: deep(half - 4),
            }),
          ),
        },
      },
      {
        type: 'user/message',
        data: {
          source: { kind: 'user' },
          message: toLoggedMessage(
            new HumanMessage({ content: [{ type: 'text', text: '補', extra: deep(half - 6) }] }),
          ),
        },
      },
      { type: 'assistant/message', data: { message: toLoggedMessage(new AIMessage('好')) } },
      { type: 'turn/end', data: {} },
    ] as Pick<SessionEvent, 'type' | 'data'>[];
    const events = readBack(lines(raw));
    const seen: [BaseMessage, SessionEvent][] = [];

    const replay = replayConversation(events, {
      toolResultAsSeen,
      shareStored: true,
      origin: (message, event) => seen.push([message, event]),
    });

    expect(replay.kind).toBe('replayed');
    const deepEvents = seen.filter(([, event]) => storedEventDepth(event)! > 10);
    // 前提：三則都真的造到上限的一半。
    expect(deepEvents.map(([, event]) => storedEventDepth(event))).toEqual([half, half, half]);
    for (const [message, event] of deepEvents) {
      const inCheckpoint = checkpointDepth(message) + CHECKPOINT_MESSAGE_WRAPPER_DEPTH;
      expect(inCheckpoint - storedEventDepth(event)!).toBeLessThanOrEqual(3);
    }
  });

  it('事件剛好 600 層、最深那格帶 `lc` 鍵：寫進存檔點多一層跳脫，照樣灌得回去，之後再寫一筆、序列化再讀回都成功（#2315）', async () => {
    const agent = await realAgent();
    // `data` → `message` → `data` → `tool_calls` → `[0]` → `args` → `v` 是 7 層，跳脫的那顆在第 7 層。
    const args = { v: { lc: 1, v: nested(SESSION_EVENT_MAX_DEPTH - 7) } };
    const events = readBack(lines(oneTurn(args)));
    const reply = events.find((event) => event.type === 'assistant/message')!;
    // 前提：日誌那一關收得下（剛好在上限上），寫進存檔點剛好在上限上。
    expect(storedEventDepth(reply)).toBe(SESSION_EVENT_MAX_DEPTH);

    await restoreConversation(agent, THREAD, events);
    const restored = firstReply(await stateMessages(agent), events).reply;
    expect(checkpointDepth(restored) + CHECKPOINT_MESSAGE_WRAPPER_DEPTH).toBe(CHECKPOINT_MAX_DEPTH);

    // 之後再寫一筆：不拋，深的那則參數不變（它已凍結，`seal` 跳過、不再量）。
    await agent.updateState(config, { messages: [new HumanMessage('再一句')] });
    const after = await stateMessages(agent);
    expect(after.at(-1)?.content).toBe('再一句');
    expect(firstReply(after, events).reply.tool_calls?.[0]?.args).toEqual(args);

    // `messages` 平常留在側表；中斷或出錯那一輪的 pending writes 才序列化，同一個上限、讀回時同一個數字給 `load`。
    const serde = new DepthCheckedSerializer(new MemorySaver().serde);
    const [type, bytes] = await serde.dumpsTyped([restored]);
    const [readBackReply] = (await serde.loadsTyped(type, bytes)) as AIMessage[];
    expect(readBackReply?.tool_calls?.[0]?.args).toEqual(args);
  });

  it.each(['langgraph', 'native'] as const)(
    '舊日誌的事件 601 層、最深那格帶 `lc` 鍵（上限再多 1 層）：照舊量、照舊拒，錯誤帶 seq（%s）',
    async (loop) => {
      const agent = await realAgent(loop);
      // 日誌那一關收不下 601 層；這是上限之前寫下的舊日誌，讀方不設限，讀得進來。
      const events = readBack(
        lines(oneTurn({ v: { lc: 1, v: nested(SESSION_EVENT_MAX_DEPTH + 1 - 7) } })),
      );
      const reply = events.find((event) => event.type === 'assistant/message')!;
      expect(storedEventDepth(reply)).toBe(SESSION_EVENT_MAX_DEPTH + 1);

      const error = await restoreConversation(agent, THREAD, events).then(
        () => undefined,
        (caught: unknown) => caught as Error & { code?: string; seq?: number; depth?: number },
      );

      expect(error?.code).toBe(CHECKPOINT_DEPTH_EXCEEDED);
      expect(error?.seq).toBe(reply.seq);
      expect(error?.depth).toBe(CHECKPOINT_MAX_DEPTH + 1);
    },
  );

  it.each([
    ['不帶 `lc` 鍵', (room: number) => nested(room)],
    ['`extra` 那顆帶 `lc` 鍵', (room: number) => ({ lc: 1, v: nested(room - 1) })],
  ])(
    '`turn/start` 的附件參照帶型別以外的深鍵、事件剛好 600 層（%s）：多出來的鍵不進訊息，照樣灌得回去，之後再寫一筆也成功（#2323）',
    async (_, extra) => {
      const agent = await realAgent();
      const file = { attachmentId: `sha256:${'ab'.repeat(32)}`, name: 'a.txt', bytes: 1 };
      const raw = oneTurn({});
      // `data` → `attachments` → `[0]` → `extra` 是 4 層，`extra` 的值從第 4 層起算。
      raw[0] = {
        type: 'turn/start',
        data: {
          kind: 'message',
          text: '看',
          attachments: [{ type: 'file', ...file, extra: extra(SESSION_EVENT_MAX_DEPTH - 3) }],
        },
      } as Pick<SessionEvent, 'type' | 'data'>;
      const events = readBack(lines(raw));
      // 前提：日誌那一關收得下（剛好在上限上）。
      expect(storedEventDepth(events[0]!)).toBe(SESSION_EVENT_MAX_DEPTH);

      await restoreConversation(agent, THREAD, events);
      const human = (await stateMessages(agent)).find((message) =>
        HumanMessage.isInstance(message),
      )!;
      expect(human.content).toEqual([
        { type: 'nexus-file', attachment: file },
        { type: 'text', text: '看' },
      ]);

      await agent.updateState(config, { messages: [new HumanMessage('再一句')] });
      expect((await stateMessages(agent)).at(-1)?.content).toBe('再一句');
    },
  );

  it.each(['langgraph', 'native'] as const)(
    '舊格式：只有 `additional_kwargs.tool_calls` 的參數字串，事件很淺，解析出來超過上限：照舊量、照舊拒（%s）',
    async (loop) => {
      const agent = await realAgent(loop);
      const events = oldFormatTurn(CHECKPOINT_MAX_DEPTH);
      // 前提：事件本身很淺，參數只是一個字串。
      expect(storedEventDepth(events[1]!)).toBeLessThan(10);

      const error = await restoreConversation(agent, THREAD, events).then(
        () => undefined,
        (caught: unknown) => caught as Error & { code?: string; seq?: number },
      );

      expect(error?.code).toBe(CHECKPOINT_DEPTH_EXCEEDED);
      expect(error?.seq).toBe(1);
    },
  );

  // 量的那一條路的邊界：參數一層對一層加深，剛好在上限上的照收、多一層的拒，兩個 loop 是同一個數字。
  const probe = 10;
  const atLimit = CHECKPOINT_MAX_DEPTH - (oldFormatDepth(probe) - probe);

  it.each(['langgraph', 'native'] as const)(
    '舊格式解析出來剛好在上限上（%s）：照收，灌回的參數一模一樣',
    async (loop) => {
      // 前提：這一則照存檔點的尺量剛好是上限。
      expect(oldFormatDepth(atLimit)).toBe(CHECKPOINT_MAX_DEPTH);
      const agent = await realAgent(loop);
      const events = oldFormatTurn(atLimit);
      await restoreConversation(agent, THREAD, events);
      const { reply } = firstReply(await stateMessages(agent), events);
      expect(reply.tool_calls?.[0]?.args).toEqual({ v: nested(atLimit) });
    },
  );

  it.each(['langgraph', 'native'] as const)(
    '舊格式解析出來比上限多一層（%s）：拒，碼與層數一樣',
    async (loop) => {
      expect(oldFormatDepth(atLimit + 1)).toBe(CHECKPOINT_MAX_DEPTH + 1);
      const agent = await realAgent(loop);
      const error = await restoreConversation(agent, THREAD, oldFormatTurn(atLimit + 1)).then(
        () => undefined,
        (caught: unknown) => caught as Error & { code?: string; seq?: number; depth?: number },
      );
      expect(error?.code).toBe(CHECKPOINT_DEPTH_EXCEEDED);
      expect(error?.seq).toBe(1);
      expect(error?.depth).toBe(CHECKPOINT_MAX_DEPTH + 1);
    },
  );
});

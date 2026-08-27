import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import type { Event } from '@nexus/wire';
import { commandPath, createWireClient, streamPath } from '@nexus/wire';
import { createDeepAgent, StateBackend } from 'deepagents';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';

/**
 * web 與 agent 之間那條線。
 *
 * 主測法沿用 `stream-parity.test.ts` 立下的規矩：**同一份腳本走兩條路再比對**。
 * 一邊走 `invoke`（線外的基準），一邊走完整的線——pump → SSE 編碼 → 解碼 → 瀏覽器端
 * client。兩邊的工具呼叫與逐輪文字必須一樣。這條路徑上沒有任何 port、網路或憑證：
 * handler 是 `(Request) => Response`，測試自己當載體。
 *
 * 其餘每一條都對著決策 6 記下的一個實測約束，紅了就代表那個約束變了。
 */

const BASE_URL = 'http://wire.test';

function recordingTool(calls: string[]) {
  return tool(
    ({ text }: { text: string }) => {
      calls.push(text);
      return `已記下：${text}`;
    },
    {
      name: 'take_note',
      description: '把一段文字記下來。',
      schema: z.object({ text: z.string().describe('要記下的內容') }),
    },
  );
}

interface Built {
  readonly agent: PumpAgent;
  readonly calls: string[];
}

function buildAgent(turns: readonly ScriptedTurn[], options: { gated?: boolean } = {}): Built {
  const calls: string[] = [];
  const agent = createDeepAgent({
    model: new ScriptedChatModel({ turns }),
    tools: [recordingTool(calls)],
    backend: new StateBackend(),
    ...(options.gated === true
      ? {
          checkpointer: new MemorySaver(),
          interruptOn: { take_note: { allowedDecisions: ['approve', 'reject'] as const } },
        }
      : {}),
  });
  return { agent: agent as unknown as PumpAgent, calls };
}

/** 把 handler 當成 fetch 用——瀏覽器端跑的是同一份 client。 */
function connect(agent: PumpAgent) {
  const handler = createWireHandler({ createAgent: async () => agent });
  const fetchImpl: typeof globalThis.fetch = async (input, init) =>
    handler.handle(new Request(input as string, init));
  return {
    handler,
    fetch: fetchImpl,
    client: createWireClient({ baseUrl: BASE_URL, fetch: fetchImpl }),
  };
}

/**
 * 抽到某個條件成立為止，避免用時間當同步機制。
 *
 * **刻意用 `next()` 而不是 `for await` ＋ `break`**：`break` 會替你呼叫
 * `iterator.return()`，把整條下行關掉——而這條線是要跨好幾輪重複抽的。
 */
async function collectUntil(
  events: AsyncGenerator<Event, void, undefined>,
  done: (frames: readonly Event[]) => boolean,
): Promise<Event[]> {
  const frames: Event[] = [];
  while (!done(frames)) {
    const next = await events.next();
    if (next.done === true) {
      break;
    }
    frames.push(next.value);
  }
  return frames;
}

function isMethod(frame: Event, method: string): boolean {
  return frame.method === method;
}

/** root 走完一輪就發一顆 `completed`——**中斷那一輪也發**，所以它可以拿來數輪次。 */
function countRootCompleted(frames: readonly Event[]): number {
  return frames.filter((frame) => {
    if (!isMethod(frame, 'lifecycle')) {
      return false;
    }
    const data = frame.params.data as { event: string; graph_name?: string };
    return data.event === 'completed' && data.graph_name === 'root';
  }).length;
}

/** 線上重建出來的每一輪文字——只用 delta 拼，證明串流的顆粒真的到了瀏覽器。 */
function textsFromWire(frames: readonly Event[]): string[] {
  const texts: string[] = [];
  let current: string | undefined;
  for (const frame of frames) {
    if (!isMethod(frame, 'messages')) {
      continue;
    }
    const data = frame.params.data as { event: string; delta?: { type: string; text?: string } };
    if (data.event === 'message-start') {
      current = '';
    } else if (data.event === 'content-block-delta' && data.delta?.type === 'text-delta') {
      current = (current ?? '') + (data.delta.text ?? '');
    } else if (data.event === 'message-finish') {
      texts.push(current ?? '');
      current = undefined;
    }
  }
  return texts;
}

function toolCallsFromWire(frames: readonly Event[]): { id: string; name: string }[] {
  return frames
    .filter((frame) => isMethod(frame, 'tools'))
    .map((frame) => frame.params.data as { event: string; tool_call_id: string; tool_name: string })
    .filter((data) => data.event === 'tool-started')
    .map((data) => ({ id: data.tool_call_id, name: data.tool_name }));
}

/**
 * 會炸的模型。
 *
 * 讓**模型**炸而不是讓工具炸，是刻意的：工具拋錯那條路除了失敗 frame 之外還會多一個
 * `run.output.catch()` 攔不掉的 unhandled rejection——那是開發計劃 Phase 4 記著的
 * 「工具拋錯就整場死」，我們的組裝有 `@nexus/plugin-validation` 圍堵著。這裡要驗的是
 * 「run 失敗時線上看得到原因」，不該順便把那個老問題拖進來。
 */
class ThrowingModel extends ScriptedChatModel {
  /** 基座的 `bindTools` 會回一個 `ScriptedChatModel`，覆寫掉才輪得到這個子類。 */
  override bindTools(): this {
    return this;
  }

  /** 刻意不是 generator：呼叫當下就炸，模擬供應商那一端接不通。 */
  override _streamResponseChunks(): AsyncGenerator<never> {
    throw new Error('模型自己炸了');
  }
}

const ONE_CALL: readonly ScriptedTurn[] = [
  { content: '我來記。', toolCalls: [{ name: 'take_note', args: { text: '第一筆' } }] },
  { content: '記好了。' },
];

describe('線的兩端對得起來', () => {
  it('走完整條線的結果與 invoke 一模一樣', async () => {
    // 基準：線外的那條路。
    const direct = buildAgent(ONE_CALL);
    const result = await (
      direct.agent as unknown as { invoke(input: unknown): Promise<{ messages: unknown[] }> }
    ).invoke({ messages: [new HumanMessage('記一筆。')] });
    const ai = (result.messages ?? []).filter((message) => AIMessage.isInstance(message));
    const byInvoke = {
      calls: direct.calls,
      texts: ai.map((message) => message.text),
      toolCalls: ai.flatMap((message) =>
        (message.tool_calls ?? []).map((call) => ({ id: call.id ?? '', name: call.name })),
      ),
    };
    // 兩邊都空也會「相等」，所以先各自斷言絕對值。
    expect(byInvoke.calls).toEqual(['第一筆']);
    expect(byInvoke.texts).toEqual(['我來記。', '記好了。']);
    expect(byInvoke.toolCalls).toEqual([{ id: 'call_1_0', name: 'take_note' }]);

    const overWire = buildAgent(ONE_CALL);
    const { client } = connect(overWire.agent);
    const events = await client.openEvents('t1');
    await client.runStart('t1', '記一筆。');
    const frames = await collectUntil(events, (collected) =>
      collected.some(
        (frame) =>
          isMethod(frame, 'lifecycle') &&
          (frame.params.data as { event: string; graph_name?: string }).event === 'completed' &&
          (frame.params.data as { graph_name?: string }).graph_name === 'root',
      ),
    );

    expect(overWire.calls).toEqual(byInvoke.calls);
    expect(textsFromWire(frames)).toEqual(byInvoke.texts);
    expect(toolCallsFromWire(frames)).toEqual(byInvoke.toolCalls);
  });

  it('白名單外的 channel 一顆都不上線，而 run 自己確實在發那些', async () => {
    const { agent } = buildAgent(ONE_CALL);
    const { client } = connect(agent);
    const events = await client.openEvents('t2');
    await client.runStart('t2', '記一筆。');
    const frames = await collectUntil(events, (collected) =>
      collected.some(
        (frame) =>
          isMethod(frame, 'lifecycle') &&
          (frame.params.data as { event: string; graph_name?: string }).graph_name === 'root' &&
          (frame.params.data as { event: string }).event === 'completed',
      ),
    );
    const methods = new Set(frames.map((frame) => frame.method));
    expect([...methods].sort()).toEqual(['lifecycle', 'messages', 'tools']);

    // **對照組**：沒有這一段的話，「白名單有效」與「基座根本沒發過那些」長得一樣。
    const control = buildAgent(ONE_CALL);
    const run = await control.agent.streamEvents(
      { messages: [new HumanMessage('記一筆。')] } as never,
      {
        version: 'v3',
        configurable: { thread_id: 'control' },
      },
    );
    const rawMethods = new Set<string>();
    for await (const raw of run) {
      rawMethods.add(raw.method);
    }
    expect([...rawMethods].sort()).toContain('updates');
    expect([...rawMethods].sort()).toContain('tasks');
    expect([...rawMethods].sort()).toContain('values');
  });
});

describe('一條下行接得起 N 個 run', () => {
  it('核准前後是同一條線，seq 跨 run 單調遞增', async () => {
    const { agent, calls } = buildAgent(ONE_CALL, { gated: true });
    const { client } = connect(agent);
    const events = await client.openEvents('t3');
    await client.runStart('t3', '記一筆。');

    const beforeApproval = await collectUntil(events, (collected) =>
      collected.some((frame) => isMethod(frame, 'input.requested')),
    );
    const request = beforeApproval.find((frame) => isMethod(frame, 'input.requested'));
    const requestData = request?.params.data as {
      interrupt_id: string;
      payload: {
        actionRequests: { name: string }[];
        reviewConfigs: { allowedDecisions: string[] }[];
      };
    };
    expect(requestData.payload.actionRequests.map((action) => action.name)).toEqual(['take_note']);
    expect(requestData.payload.reviewConfigs[0]?.allowedDecisions).toEqual(['approve', 'reject']);
    expect(calls).toEqual([]);

    await client.inputRespond('t3', {
      namespace: [],
      interrupt_id: requestData.interrupt_id,
      response: { decisions: [{ type: 'approve' }] },
    });
    // 收到第二個 root `completed` 為止：第一顆是中斷那一輪留下來的（它在中斷時照樣發，
    // 見下一條），第二顆才是核准之後那一輪跑完。
    const afterApproval = await collectUntil(
      events,
      (collected) => countRootCompleted(collected) === 2,
    );

    expect(calls).toEqual(['第一筆']);
    // **這一條釘住的是 `seq` 每個 run 都從 0 重來這件事。** pump 不重新編號的話，
    // 第二段的第一顆會是 0，這裡就會紅——而瀏覽器那側只會靜靜地排錯序。
    const seqs = [...beforeApproval, ...afterApproval].map((frame) => frame.seq ?? -1);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs[0]).toBe(0);
    // 兩段確實分屬兩個 run：第二段裡有第一段沒有的工具事件。
    expect(toolCallsFromWire(beforeApproval)).toEqual([]);
    expect(toolCallsFromWire(afterApproval)).toEqual([{ id: 'call_1_0', name: 'take_note' }]);
  });

  it('中斷時 root 照樣發 completed，所以它不能當關線的訊號', async () => {
    const { agent } = buildAgent(ONE_CALL, { gated: true });
    const { client } = connect(agent);
    const events = await client.openEvents('t4', { channels: ['lifecycle', 'input'] });
    await client.runStart('t4', '記一筆。');
    const frames = await collectUntil(
      events,
      (collected) =>
        collected.some((frame) => isMethod(frame, 'input.requested')) &&
        countRootCompleted(collected) === 1,
    );
    // 停在核准點的那一輪，root 的最後一顆仍然是 completed 而不是別的什麼。
    const lifecycle = frames
      .filter((frame) => isMethod(frame, 'lifecycle'))
      .map((frame) => frame.params.data as { event: string; graph_name?: string })
      .filter((data) => data.graph_name === 'root');
    expect(lifecycle.map((data) => data.event)).toEqual(['running', 'completed']);
  });

  it('瀏覽器斷線不會把 run 停掉', async () => {
    const { agent, calls } = buildAgent(ONE_CALL);
    const { client, handler } = connect(agent);
    const controller = new AbortController();
    const events = await client.openEvents('t5', { signal: controller.signal });
    await client.runStart('t5', '記一筆。');

    // 一收到第一顆就把線砍掉——這一刻工具還沒跑。
    await events.next();
    expect(calls).toEqual([]);
    controller.abort();
    await events.return(undefined);

    // run 自己會前進：不抽它也照跑（決策 6 的第 1 條）。
    for (let i = 0; i < 50 && calls.length === 0; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(calls).toEqual(['第一筆']);
    handler.close();
  });
});

describe('失敗與拒絕', () => {
  it('run 炸掉時原因先上線，下行不跟著斷', async () => {
    const agent = createDeepAgent({
      model: new ThrowingModel({ turns: ONE_CALL }),
      tools: [recordingTool([])],
      backend: new StateBackend(),
    }) as unknown as PumpAgent;
    const { client } = connect(agent);
    const events = await client.openEvents('t6', { channels: ['lifecycle'] });
    await client.runStart('t6', '記一筆。');
    const frames = await collectUntil(events, (collected) =>
      collected.some(
        (frame) =>
          (frame.params.data as { event: string }).event === 'failed' &&
          (frame.params.data as { graph_name?: string }).graph_name === 'root',
      ),
    );
    const failed = frames
      .map((frame) => frame.params.data as { event: string; graph_name?: string; error?: string })
      .find((data) => data.event === 'failed' && data.graph_name === 'root');
    expect(failed?.error).toBe('模型自己炸了');
  });

  it('載體層的錯用 HTTP status，協定層的錯用 200 加 error 封包', async () => {
    const { agent } = buildAgent(ONE_CALL);
    const { fetch: wireFetch } = connect(agent);
    const post = (path: string, body: unknown, contentType = 'application/json') =>
      wireFetch(`${BASE_URL}${path}`, {
        method: 'POST',
        headers: { 'content-type': contentType },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });

    // 載體層。
    expect((await post(streamPath('t7'), { channels: ['messages'] }, 'text/plain')).status).toBe(
      415,
    );
    expect((await post(streamPath('t7'), '{ 壞掉的 JSON')).status).toBe(400);
    expect((await post('/threads/t7/commands/state.get', { id: 1 })).status).toBe(404);
    expect((await wireFetch(`${BASE_URL}${streamPath('t7')}`, { method: 'GET' })).status).toBe(404);

    // 協定層：200 ＋ error 封包。
    const sinceRejected = await post(streamPath('t7'), { channels: ['messages'], since: 3 });
    expect(sinceRejected.status).toBe(200);
    expect(await sinceRejected.json()).toMatchObject({ type: 'error', error: 'not_supported' });

    const badChannel = await post(streamPath('t7'), { channels: ['values'] });
    expect(await badChannel.json()).toMatchObject({ type: 'error', error: 'invalid_argument' });

    const mismatch = await post(commandPath('t7', 'run.start'), {
      id: 7,
      method: 'input.respond',
      params: {},
    });
    expect(await mismatch.json()).toMatchObject({
      type: 'error',
      id: 7,
      error: 'invalid_argument',
    });
  });

  it('上行的回應是收件回條，不是跑完了', async () => {
    const { agent, calls } = buildAgent(ONE_CALL);
    const { client } = connect(agent);
    await client.openEvents('t8');
    const ack = await client.runStart('t8', '記一筆。');
    expect(ack).toMatchObject({ type: 'success', id: 1 });
    expect(calls).toEqual([]);
  });
});

describe('線上的 channel 名', () => {
  it('觀測到的 method 全都在協定的 Channel 詞彙裡', async () => {
    const { agent } = buildAgent(ONE_CALL, { gated: true });
    const { client } = connect(agent);
    const events = await client.openEvents('t9');
    await client.runStart('t9', '記一筆。');
    const frames = await collectUntil(events, (collected) =>
      collected.some((frame) => isMethod(frame, 'input.requested')),
    );
    // 這是一條升版絆索：基座加了頻道、或把某個頻道改名，這裡會紅。
    const known: readonly string[] = ['messages', 'tools', 'lifecycle', 'input.requested'];
    for (const frame of frames) {
      expect(known).toContain(frame.method);
    }
    expect(new Set(frames.map((frame) => frame.method))).toEqual(
      new Set(['lifecycle', 'messages', 'input.requested']),
    );
  });
});

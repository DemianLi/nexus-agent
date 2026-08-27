import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import type { ConversationState, Event, WireChannel } from '@nexus/wire';
import {
  appendHumanTurn,
  createWireClient,
  emptyConversation,
  reduceConversation,
} from '@nexus/wire';
import { createDeepAgent, StateBackend } from 'deepagents';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';

/**
 * 折疊器對著**真的**線驗。
 *
 * 這是 `stream-parity.test.ts` 立下的規矩往上再走一層：同一份腳本，一邊走 `invoke`，
 * 一邊走 pump → SSE → 解碼 → `reduceConversation`，比對兩邊。折疊器住在
 * `@nexus/wire` 就是為了這件事——放在 `apps/web` 只驗得到手寫的 fixture，而手寫
 * fixture 會靜靜地與基座漂移。
 */

const BASE_URL = 'http://wire.test';

interface Built {
  readonly agent: PumpAgent;
  readonly calls: string[];
}

function noteTool(calls: string[]) {
  return tool(
    ({ text }: { text: string }) => {
      calls.push(text);
      return `已記下：${text}`;
    },
    {
      name: 'take_note',
      description: '把一段文字記下來。',
      schema: z.object({ text: z.string() }),
    },
  );
}

function build(
  turns: readonly ScriptedTurn[],
  options: { gated?: boolean; subagents?: readonly string[] } = {},
): Built {
  const calls: string[] = [];
  const agent = createDeepAgent({
    model: new ScriptedChatModel({ turns }),
    tools: [noteTool(calls)],
    backend: new StateBackend(),
    ...(options.subagents === undefined
      ? {}
      : {
          subagents: options.subagents.map((name) => ({
            name,
            description: `${name} 的職責。`,
            prompt: `你是 ${name}。`,
          })),
        }),
    ...(options.gated === true
      ? {
          checkpointer: new MemorySaver(),
          interruptOn: { take_note: { allowedDecisions: ['approve', 'reject'] as const } },
        }
      : {}),
  });
  return { agent: agent as unknown as PumpAgent, calls };
}

function connect(agent: PumpAgent) {
  const handler = createWireHandler({
    createAgent: async () => ({ agent, dispose: async () => undefined }),
  });
  return {
    handler,
    client: createWireClient({
      baseUrl: BASE_URL,
      fetch: async (input, init) => handler.handle(new Request(input as string, init)),
    }),
  };
}

/** 開線、送話、折到某個條件成立為止。 */
async function converse(
  agent: PumpAgent,
  threadId: string,
  text: string,
  done: (state: ConversationState) => boolean,
  channels?: readonly WireChannel[],
): Promise<{ state: ConversationState; frames: Event[] }> {
  const { client, handler } = connect(agent);
  const events = await client.openEvents(
    threadId,
    ...(channels === undefined ? [] : [{ channels }]),
  );
  await client.runStart(threadId, text);

  let state = appendHumanTurn(emptyConversation(), text);
  const frames: Event[] = [];
  while (!done(state)) {
    const next = await events.next();
    if (next.done === true) {
      break;
    }
    frames.push(next.value);
    state = reduceConversation(state, next.value);
  }
  await handler.close();
  return { state, frames };
}

const ONE_CALL: readonly ScriptedTurn[] = [
  { content: '我來記。', toolCalls: [{ name: 'take_note', args: { text: '第一筆' } }] },
  { content: '記好了。' },
];

const TWO_SUBAGENTS: readonly ScriptedTurn[] = [
  {
    content: '兩個都派。',
    toolCalls: [
      { name: 'task', args: { description: '寫甲', subagent_type: 'writer' } },
      { name: 'task', args: { description: '查乙', subagent_type: 'checker' } },
    ],
  },
  { content: 'writer 寫好了。' },
  { content: 'checker 查好了。' },
  { content: '收工。' },
];

/** 折出來的 AI 文字，依歸屬分組。 */
function aiTexts(state: ConversationState, kind: 'root' | 'subagent' | 'unattributed'): string[] {
  return state.entries
    .filter((entry) => entry.kind === 'ai' && entry.attribution.kind === kind)
    .map((entry) => (entry.kind === 'ai' ? entry.text : ''));
}

describe('折疊器與 invoke 對得起來', () => {
  it('一次工具呼叫：文字、工具、狀態三樣都一致', async () => {
    const direct = build(ONE_CALL);
    const result = await (
      direct.agent as unknown as { invoke(input: unknown): Promise<{ messages: unknown[] }> }
    ).invoke({ messages: [new HumanMessage('記一筆。')] });
    const ai = result.messages.filter((message) => AIMessage.isInstance(message));
    expect(ai.map((message) => message.text)).toEqual(['我來記。', '記好了。']);
    expect(direct.calls).toEqual(['第一筆']);

    const overWire = build(ONE_CALL);
    const { state } = await converse(
      overWire.agent,
      'c1',
      '記一筆。',
      (current) => current.status === 'idle' && aiTexts(current, 'root').length === 2,
    );

    expect(aiTexts(state, 'root')).toEqual(['我來記。', '記好了。']);
    expect(state.entries.filter((entry) => entry.kind === 'human').map((e) => e.text)).toEqual([
      '記一筆。',
    ]);
    const tools = state.entries.filter((entry) => entry.kind === 'tool');
    expect(tools.map((entry) => (entry.kind === 'tool' ? [entry.name, entry.status] : []))).toEqual(
      [['take_note', 'done']],
    );
    expect(state.status).toBe('idle');
    expect(overWire.calls).toEqual(direct.calls);
  });

  it('兩個平行 subagent 各歸各的，即使訊息逐字交錯', async () => {
    const { agent } = build(TWO_SUBAGENTS, { subagents: ['writer', 'checker'] });
    const { state } = await converse(
      agent,
      'c2',
      '派工。',
      (current) => current.status === 'idle' && aiTexts(current, 'root').length === 2,
    );

    const bySubagent = state.entries
      .filter((entry) => entry.kind === 'ai' && entry.attribution.kind === 'subagent')
      .map((entry) =>
        entry.kind === 'ai' && entry.attribution.kind === 'subagent'
          ? [entry.attribution.name, entry.text]
          : [],
      );
    // 名字是 join 出來的：`task` 那顆 tools frame 的 `input.subagent_type` ↔ namespace 前綴。
    expect(bySubagent).toEqual([
      ['writer', 'writer 寫好了。'],
      ['checker', 'checker 查好了。'],
    ]);
    expect(aiTexts(state, 'root')).toEqual(['兩個都派。', '收工。']);
    expect(aiTexts(state, 'unattributed')).toEqual([]);
  });

  it('訂閱沒帶 tools channel 時，巢狀訊息標成未歸屬而不是猜一個', async () => {
    const { agent } = build(TWO_SUBAGENTS, { subagents: ['writer', 'checker'] });
    const { state } = await converse(
      agent,
      'c3',
      '派工。',
      (current) => current.status === 'idle' && aiTexts(current, 'root').length === 2,
      ['messages', 'lifecycle'],
    );

    // 鑰匙（`tools` frame）根本沒上線，所以歸屬不出來——**而它說的是不知道，不是猜**。
    expect(aiTexts(state, 'unattributed')).toEqual(['writer 寫好了。', 'checker 查好了。']);
    expect(aiTexts(state, 'subagent')).toEqual([]);
    expect(aiTexts(state, 'root')).toEqual(['兩個都派。', '收工。']);
  });
});

describe('折疊器的狀態', () => {
  it('停在核准點：status 是 awaiting-input，root 的 completed 翻不掉它', async () => {
    const { agent, calls } = build(ONE_CALL, { gated: true });
    const { state, frames } = await converse(
      agent,
      'c4',
      '記一筆。',
      (current) =>
        current.status === 'awaiting-input' &&
        // 多折一顆：中斷之後 root 還會發一顆 completed，那顆不能把狀態翻成 idle。
        current.entries.length > 0,
    );
    expect(state.status).toBe('awaiting-input');
    expect(state.pending?.actions.map((action) => action.name)).toEqual(['take_note']);
    expect(state.pending?.allowedDecisions).toEqual(['approve', 'reject']);
    expect(calls).toEqual([]);
    void frames;
  });

  it('run 炸掉：status 是 failed，而且說得出原因', async () => {
    const agent = createDeepAgent({
      model: new ThrowingModel({ turns: ONE_CALL }),
      tools: [noteTool([])],
      backend: new StateBackend(),
    }) as unknown as PumpAgent;
    const { state } = await converse(
      agent,
      'c5',
      '記一筆。',
      (current) => current.status === 'failed',
    );
    expect(state.status).toBe('failed');
    expect(state.error).toBe('模型自己炸了');
  });
});

describe('升版絆索', () => {
  it('subagent 的 lifecycle 還是沒帶 cause——帶了的話這個 join 就可以退休', async () => {
    const { agent } = build(TWO_SUBAGENTS, { subagents: ['writer', 'checker'] });
    const { frames } = await converse(
      agent,
      'c6',
      '派工。',
      (current) => current.status === 'idle' && aiTexts(current, 'root').length === 2,
    );
    const nestedStarts = frames.filter(
      (frame) =>
        frame.method === 'lifecycle' &&
        frame.params.namespace.length > 1 &&
        (frame.params.data as { event?: string }).event === 'started',
    );
    expect(nestedStarts.length).toBeGreaterThan(0);
    // 協定留了 `LifecycleData.cause` 這格，註解明寫由 deepagents 的 SubagentTransformer 填。
    // `deepagents@1.13.1` 沒填，所以歸屬只能自己 join。這裡紅了代表基座開始填了。
    for (const frame of nestedStarts) {
      expect((frame.params.data as { cause?: unknown }).cause).toBeUndefined();
    }
  });
});

/** 會炸的模型；讓模型炸而不是工具炸的理由見 `wire.test.ts`。 */
class ThrowingModel extends ScriptedChatModel {
  override bindTools(): this {
    return this;
  }

  override _streamResponseChunks(): AsyncGenerator<never> {
    throw new Error('模型自己炸了');
  }
}

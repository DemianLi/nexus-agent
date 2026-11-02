/**
 * **點名子代理走完 wire**（[#328](https://github.com/DemianLi/nexus-agent/issues/328) 第 2 項）：`subagent.list` 與 `run.start` 的 `mention`。
 *
 * 真的 `createWireHandler`＋真的 wire client＋真的 `createNexusAgent`＋`ThreadPump`。量的是：
 *
 * - 清單就是 `task` 實際收的那份（`general-purpose` 在前，其餘依註冊順序）；
 * - 名字不在清單上、形狀不對：`invalid_argument`，**那句話不進佇列**（日誌沒有 `turn/start`，模型一次都沒被叫）；
 * - 合格的點名：模型讀到提示區塊；人話泡泡在即時（`inbox` 的 `claimed`）與冷載入（`GET /history`）兩條路上都帶 `mention`，文字不含提示。
 *
 * **零憑證、零外部連線**。
 */

import { MemorySaver } from '@langchain/langgraph';
import { mentionHintText } from '@nexus/core';
import type { PluginEntry, SessionRegistry } from '@nexus/core';
import { createWireClient, emptyConversation, reduceAll, reduceConversation } from '@nexus/wire';
import type { ConversationState, Event } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { emptyCommandPoint, loopbackRequest, TEST_BROWSER_AUTH } from './fixtures.js';
import { ScriptedChatModel } from './scripted-model.js';
import { composeAttachSessions } from './session-attach.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';
import type { WireHandler } from './wire-handler.js';

const BASE_URL = 'http://mention.test';
const THREAD = 'mention-wire';

const CREW: PluginEntry = {
  plugin: {
    name: 'crew',
    apply(registry) {
      registry.subagents.register({ name: 'reviewer', description: '審查程式碼。' });
      registry.subagents.register({ name: 'writer', description: '寫文件。' });
    },
  },
};

const opened: WireHandler[] = [];
afterEach(async () => {
  for (const handler of opened.splice(0)) await handler.close();
});

async function open() {
  const model = new ScriptedChatModel({ turns: [{ content: '好，我派它。' }] });
  const built = await createNexusAgent({
    model,
    checkpointer: new MemorySaver(),
    plugins: [CREW],
  });
  let registry: SessionRegistry | undefined;
  const handler = createWireHandler({
    auth: TEST_BROWSER_AUTH,
    createAgent: async () => ({
      agent: built.agent as unknown as PumpAgent,
      commands: emptyCommandPoint(),
      projections: built.projections,
      subagentKinds: built.subagentKinds,
      dispose: () => built.dispose(),
      attachSessions: (sessions, port) => {
        registry = sessions;
        return composeAttachSessions(built)(sessions, port);
      },
    }),
  });
  opened.push(handler);
  const fetch = async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) =>
    handler.handle(loopbackRequest(input as string, init));
  const client = createWireClient({ baseUrl: BASE_URL, fetch });
  const events = await client.openEvents(THREAD);
  const frames: Event[] = [];
  let state: ConversationState = emptyConversation();
  const pump = async (done: () => boolean) => {
    while (!done()) {
      const next = await events.next();
      if (next.done === true) break;
      frames.push(next.value);
      state = reduceConversation(state, next.value);
    }
  };
  return {
    client,
    model,
    frames,
    state: () => state,
    pump,
    turnStarts: () => (registry?.root.events ?? []).filter((e) => e.type === 'turn/start'),
    close: async () => {
      await events.return?.(undefined);
    },
  };
}

const humansOf = (state: ConversationState) =>
  state.entries.filter((entry) => entry.kind === 'human');

describe('subagent.list', () => {
  it('就是 task 實際收的那份：general-purpose 在前，其餘依註冊順序，各帶說明', async () => {
    const run = await open();
    try {
      const reply = await run.client.subagentList(THREAD);
      expect(reply.kind).toBe('ok');
      if (reply.kind !== 'ok') return;
      expect(reply.result.value.subagents.map((kind) => kind.name)).toEqual([
        'general-purpose',
        'reviewer',
        'writer',
      ]);
      expect(reply.result.value.subagents[1]).toEqual({
        name: 'reviewer',
        description: '審查程式碼。',
      });
    } finally {
      await run.close();
    }
  });
});

describe('run.start 的 mention', () => {
  it('合格的點名：模型讀到提示；即時與冷載入的人話泡泡都帶 mention，文字不含提示', async () => {
    const run = await open();
    try {
      const reply = await run.client.runStart(THREAD, '請看一下這份 diff', {
        mention: { kind: 'subagent', name: 'reviewer' },
      });
      expect(reply).toMatchObject({ type: 'success' });
      await run.pump(() => run.state().status === 'idle' && run.state().entries.length >= 2);

      const prompt = run.model.prompts[0]!;
      const human = prompt.find((message) => message.getType() === 'human')!;
      expect(human.content).toEqual([
        { type: 'text', text: '請看一下這份 diff' },
        { type: 'text', text: mentionHintText({ kind: 'subagent', name: 'reviewer' }) },
      ]);
      expect(run.turnStarts().map((event) => event.data)).toMatchObject([
        {
          kind: 'message',
          text: '請看一下這份 diff',
          mention: { kind: 'subagent', name: 'reviewer' },
        },
      ]);

      // 即時：領走那一刻長出的人話泡泡。
      expect(humansOf(run.state())).toMatchObject([
        { text: '請看一下這份 diff', mention: { kind: 'subagent', name: 'reviewer' } },
      ]);

      // 冷載入：同一份日誌折出來的歷史。
      const history = await run.client.threadHistory(THREAD);
      expect(history.kind).toBe('ok');
      if (history.kind !== 'ok') return;
      const cold = reduceAll(emptyConversation(), history.result.events);
      expect(humansOf(cold)).toMatchObject([
        { text: '請看一下這份 diff', mention: { kind: 'subagent', name: 'reviewer' } },
      ]);
      expect(JSON.stringify(cold.entries)).not.toContain('system-reminder');
    } finally {
      await run.close();
    }
  }, 20000);

  it('名字不在清單上：invalid_argument、說出可點名的有哪些；那句話不進佇列，模型一次都沒被叫', async () => {
    const run = await open();
    try {
      const reply = await run.client.runStart(THREAD, '請 ghost 看一下', {
        mention: { kind: 'subagent', name: 'ghost' },
      });
      expect(reply).toMatchObject({ type: 'error', error: 'invalid_argument' });
      expect(JSON.stringify(reply)).toContain('ghost');
      expect(JSON.stringify(reply)).toContain('reviewer');
      expect(run.turnStarts()).toHaveLength(0);
      expect(run.model.prompts).toHaveLength(0);
    } finally {
      await run.close();
    }
  });

  it('形狀不對：kind 不是 subagent、name 空字串、不是物件——都是 invalid_argument，也不進佇列', async () => {
    const run = await open();
    try {
      for (const mention of [
        { kind: 'skill', name: 'reviewer' },
        { kind: 'subagent', name: '' },
        { kind: 'subagent' },
        'reviewer',
        42,
      ]) {
        const reply = await run.client.runStart(THREAD, '嗨', { mention } as never);
        expect(reply, JSON.stringify(mention)).toMatchObject({
          type: 'error',
          error: 'invalid_argument',
        });
      }
      expect(run.turnStarts()).toHaveLength(0);
      expect(run.model.prompts).toHaveLength(0);
    } finally {
      await run.close();
    }
  });
});

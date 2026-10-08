/**
 * MCP 反問走線上（[#1098](https://github.com/DemianLi/nexus-agent/issues/1098)）：真的 `createWireHandler`＋`WireClient`，
 * 量 web 端實際會收到、會送的東西——
 *
 * 1. 下行是問答卡，`origin` 說清楚哪台 server、哪支工具在問；折出來的待答項是 `question`，不是核准卡。
 * 2. 上行：看不懂的回覆（例如核准形狀）**在 `input.respond` 就被退回**（`invalid_argument`），卡片不動、之後還能答；
 *    `answerResponse` 與 `declineResponse` 這兩個既有的 wire 回覆形狀，server 分別收到 `accept`／`decline`。
 */

import { fileURLToPath } from 'node:url';
import { MemorySaver } from '@langchain/langgraph';
import { createHostServicesPlugin } from '@nexus/core';
import { createMcpPlugin } from '@nexus/plugin-mcp';
import {
  answerResponse,
  appendAnswers,
  createWireClient,
  declineResponse,
  emptyConversation,
  QUESTION_PENDING_KIND,
  reduceConversation,
} from '@nexus/wire';
import type { ConversationState, Event } from '@nexus/wire';
import { afterEach, expect, it } from 'vitest';
import { createNexusAgent } from './agent-factory.js';
import {
  emptyCommandPoint,
  loopbackRequest,
  shippedPlugins,
  TEST_BROWSER_AUTH,
} from './fixtures.js';
import { ScriptedChatModel } from './scripted-model.js';
import { composeAttachSessions } from './session-attach.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';
import type { WireHandler } from './wire-handler.js';

const SERVER = fileURLToPath(
  new URL('../../../packages/nexus-plugin-mcp/src/modern-stdio-server.ts', import.meta.url),
);
const shipped = await shippedPlugins();
const opened: WireHandler[] = [];
afterEach(async () => {
  for (const handler of opened.splice(0)) await handler.close();
});

async function open(threadId: string) {
  const built = await createNexusAgent({
    model: new ScriptedChatModel({
      turns: [
        { content: '問', toolCalls: [{ name: 'mcp__srv__ask_form', args: {} }] },
        { content: '收工' },
      ],
    }),
    checkpointer: new MemorySaver(),
    plugins: [
      createHostServicesPlugin({ channel: { kind: 'human' } }, 'wire-elicit-channel'),
      ...shipped,
      createMcpPlugin({
        serverName: 'srv',
        connection: {
          transport: 'stdio',
          command: process.execPath,
          args: ['--import', 'tsx', SERVER],
        },
      }),
    ],
  });
  const handler = createWireHandler({
    auth: TEST_BROWSER_AUTH,
    createAgent: async () => ({
      agent: built.agent as unknown as PumpAgent,
      commands: emptyCommandPoint(),
      dispose: () => built.dispose(),
      attachSessions: composeAttachSessions(built),
    }),
  });
  opened.push(handler);
  const client = createWireClient({
    baseUrl: 'http://wire-elicit.test',
    fetch: async (input, init) => handler.handle(loopbackRequest(input as string, init)),
  });
  const events = await client.openEvents(threadId);
  const session = {
    client,
    events,
    frames: [] as Event[],
    state: emptyConversation() as ConversationState,
  };
  await client.runStart(threadId, '動手');
  return session;
}

async function until(
  session: Awaited<ReturnType<typeof open>>,
  done: (state: ConversationState) => boolean,
): Promise<void> {
  while (!done(session.state)) {
    const next = await session.events.next();
    if (next.done === true) break;
    session.frames.push(next.value);
    session.state = reduceConversation(session.state, next.value);
  }
}

const toolText = (state: ConversationState): string =>
  JSON.stringify(state.entries.filter((entry) => entry.kind === 'tool'));

it('下行是帶 origin 的問答卡；看不懂的回覆被退回、卡片還在；接受之後 server 收到 accept', async () => {
  const session = await open('wire-accept');
  await until(session, (state) => state.status === 'awaiting-input');
  const pending = session.state.pendings[0]!;
  expect(pending.kind).toBe(QUESTION_PENDING_KIND);
  if (pending.kind !== QUESTION_PENDING_KIND) throw new Error('不是問答卡');
  expect(pending.origin).toMatchObject({
    kind: 'mcp-elicitation',
    server: 'srv',
    tool: 'ask_form',
  });
  expect(pending.questions.map((q) => q.id)).toEqual([
    'profile/name',
    'profile/color',
    'profile/age',
    'profile/vip',
  ]);

  // 核准形狀的回覆：不是問答卡的回法，在 input.respond 就被退回。
  const wrong = await session.client.inputRespond('wire-accept', {
    namespace: [...pending.namespace],
    interrupt_id: pending.interruptId,
    response: { decisions: [{ type: 'approve' }] },
  });
  expect(JSON.stringify(wrong)).toContain('invalid_argument');

  const answers = [
    { id: 'profile/name', selected: [], custom: '阿明' },
    { id: 'profile/color', selected: ['藍'] },
    { id: 'profile/age', selected: [], custom: '7' },
    { id: 'profile/vip', selected: ['是'] },
  ];
  session.state = appendAnswers(session.state, pending.interruptId, answers);
  const ok = await session.client.inputRespond('wire-accept', {
    namespace: [...pending.namespace],
    interrupt_id: pending.interruptId,
    response: answerResponse(answers),
  });
  expect(JSON.stringify(ok)).not.toContain('invalid_argument');
  await until(
    session,
    (state) => state.status === 'idle' && toolText(state).includes('profile=accept'),
  );
  expect(toolText(session.state)).toContain('阿明');
}, 60_000);

it('拒絕（declineResponse）→ server 收到 decline', async () => {
  const session = await open('wire-decline');
  await until(session, (state) => state.status === 'awaiting-input');
  const pending = session.state.pendings[0]!;
  await session.client.inputRespond('wire-decline', {
    namespace: [...pending.namespace],
    interrupt_id: pending.interruptId,
    response: declineResponse(),
  });
  await until(
    session,
    (state) => state.status === 'idle' && toolText(state).includes('profile=decline'),
  );
  expect(toolText(session.state)).toContain('profile=decline');
}, 60_000);

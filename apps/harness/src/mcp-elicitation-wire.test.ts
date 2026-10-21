/**
 * MCP 反問走線上（[#1098](https://github.com/DemianLi/nexus-agent/issues/1098)）：真的 `createWireHandler`＋`WireClient`，
 * 量 web 端實際會收到、會送的東西——
 *
 * 1. 下行是問答卡，`origin` 說清楚哪台 server、哪支工具在問；折出來的待答項是 `question`，不是核准卡。
 * 2. 上行：看不懂的回覆（例如核准形狀）**在 `input.respond` 就被退回**（`invalid_argument`），卡片不動、之後還能答；
 *    `answerResponse` 與 `declineResponse` 這兩個既有的 wire 回覆形狀，server 分別收到 `accept`／`decline`。
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MemorySaver } from '@langchain/langgraph';
import { createHostServicesPlugin } from '@nexus/core';
import { createMcpPlugin, MCP_POOL_SERVICE, McpConnectionPool } from '@nexus/plugin-mcp';
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

/**
 * @param shared - 給了就經宿主服務交連線池（serve 的形狀，#1677），`args` 多帶一個記號好數子行程；`call` 換掉這條 thread 要叫的工具。
 */
async function open(
  threadId: string,
  shared?: { pool: McpConnectionPool; marker: string; call?: { name: string; args: object } },
) {
  const call = shared?.call ?? { name: 'mcp__srv__ask_form', args: {} };
  const built = await createNexusAgent({
    model: new ScriptedChatModel({
      turns: [{ content: '問', toolCalls: [call] }, { content: '收工' }],
    }),
    checkpointer: new MemorySaver(),
    plugins: [
      createHostServicesPlugin(
        {
          channel: { kind: 'human' },
          ...(shared !== undefined && { [MCP_POOL_SERVICE]: shared.pool }),
        },
        'wire-elicit-channel',
      ),
      ...shipped,
      createMcpPlugin({
        serverName: 'srv',
        // 量的不是核准：這台的工具都不問（#1622 起沒寫 approval 就整台都問）。
        approval: { default: 'allow' },
        connection: {
          transport: 'stdio',
          command: process.execPath,
          args: ['--import', 'tsx', SERVER, ...(shared === undefined ? [] : [shared.marker])],
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

/**
 * #1677 驗收 E：兩條 thread 共用池裡同一條連線（同一個子行程），A 叫會反問的工具停在問答卡上的時候，B 叫別支工具照常完成、
 * 下行沒有問答卡；A 回答之後那支呼叫完成。adapter 的反問走 LangGraph `interrupt()`，停在**呼叫者**那張圖上，所以不用另外路由
 * （Q3 (a)）。每條 thread 各自一份組裝（各自的註冊表與工具物件），跟 serve 一樣。
 */
it('共用一條連線：A 的問答卡只出在 A；B 同時叫別支工具不受影響；A 回答後完成', async () => {
  const pool = new McpConnectionPool({ log: () => undefined });
  const marker = `--marker-${randomUUID()}`;
  try {
    const a = await open('shared-a', { pool, marker });
    await until(a, (state) => state.status === 'awaiting-input');
    expect(a.state.pendings[0]?.kind).toBe(QUESTION_PENDING_KIND);

    const b = await open('shared-b', {
      pool,
      marker,
      call: { name: 'mcp__srv__fetch_release_note', args: { topic: '共用' } },
    });
    await until(b, (state) => state.status === 'idle' && toolText(state).includes('共用｜'));
    expect(b.state.pendings).toEqual([]);
    expect(b.frames.some((frame) => JSON.stringify(frame).includes('mcp-elicitation'))).toBe(false);
    expect(pidsOf(marker)).toHaveLength(1);

    const pending = a.state.pendings[0]!;
    const answers = [
      { id: 'profile/name', selected: [], custom: '阿明' },
      { id: 'profile/color', selected: ['藍'] },
      { id: 'profile/age', selected: [], custom: '7' },
      { id: 'profile/vip', selected: ['是'] },
    ];
    await a.client.inputRespond('shared-a', {
      namespace: [...pending.namespace],
      interrupt_id: pending.interruptId,
      response: answerResponse(answers),
    });
    await until(
      a,
      (state) => state.status === 'idle' && toolText(state).includes('profile=accept'),
    );
  } finally {
    for (const handler of opened.splice(0)) await handler.close();
    await pool.close();
  }
}, 60_000);

/** 命令列含記號的行程；不經 shell（同 `idle-eviction.test.ts`）。 */
function pidsOf(marker: string): number[] {
  try {
    return execFileSync('pgrep', ['-f', '--', marker])
      .toString()
      .split('\n')
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

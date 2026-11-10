/**
 * `--agent-loop native` 在產品組裝上（[#2356](https://github.com/DemianLi/nexus-agent/issues/2356)）：組裝根、pump、wire。
 *
 * 兩個 loop 算出來的答題管道一樣（[#2358](https://github.com/DemianLi/nexus-agent/issues/2358)）：native 沒人可問的是那顆呼叫上放了
 * `NO_HUMAN_INPUT` 的（帶 thread 的 `streamEvents` 之外的 run），由生產者自己判。serve 走帶 thread 的 `streamEvents`，樹上的 ask-user
 * 停在問題上、答了收完，日誌跟 `langgraph` 寫的一樣；直接 `invoke` 組裝根時沙箱升級當下拒絕（no-channel），不掛核准卡。
 *
 * **零憑證、零外部連線**：模型是腳本。
 */

import { readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BaseMessage } from '@langchain/core/messages';

import type { SessionEvent } from '@nexus/core';
import { ASK_USER_QUESTION_TOOL_NAME } from '@nexus/plugin-ask-user';
import { SANDBOX_ESCALATION_TOOL_NAME, unaskedRefusal } from '@nexus/plugin-sandbox-policy';
import type { ConversationState, Event } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';

import { createCliAgent } from './assembly-root.js';
import { parseCliArgs } from './cli.js';
import { foldTurn, serveClient, shippedPlugins, withScriptedModel } from './fixtures.js';
import { toAgentInvocation } from './messages.js';
import { startScriptedServe } from './scripted-serve.js';
import { parseServeArgs } from './serve-run.js';
import type { ScriptedServe } from './scripted-serve.js';
import type { ScriptedTurn } from './scripted-model.js';
import { sessionEventsOf } from './session-files.fixture.js';

const ASK: readonly ScriptedTurn[] = [
  {
    content: '我先問。',
    toolCalls: [
      {
        name: ASK_USER_QUESTION_TOOL_NAME,
        args: { questions: [{ id: 'day', question: '哪一天？', options: [{ label: '週一' }] }] },
      },
    ],
  },
  { content: '收工。' },
];

let serve: ScriptedServe | undefined;

afterEach(async () => {
  await serve?.close();
  serve = undefined;
});

/** 每次跑都不同的欄位。 */
const VOLATILE = new Set(['time', 'interruptId', 'id', 'durationMs', 'sampledAt']);
/** 時間脈絡那一則裡取樣的時刻。 */
const SAMPLED = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d/gu;

/** 日誌去掉每次跑都不同的欄位，留種類、順序與內容。 */
function shapeOf(events: readonly SessionEvent[]): unknown[] {
  const strip = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(strip)
      : typeof value === 'object' && value !== null
        ? Object.fromEntries(
            Object.entries(value)
              .filter(([key]) => !VOLATILE.has(key))
              .map(([key, inner]) => [key, strip(inner)]),
          )
        : typeof value === 'string'
          ? value.replace(SAMPLED, '<time>')
          : value;
  return events.map(({ type, data }) => ({ type, data: strip(data) }));
}

/** 起一台 serve、問一題、答了跑完，回兩段的線上狀態與落盤的日誌。 */
async function askAndAnswer(
  loop: 'langgraph' | 'native',
): Promise<{ parked: ConversationState; done: ConversationState; log: SessionEvent[] }> {
  const logs = await mkdtemp(join(tmpdir(), 'nexus-native-ask-logs-'));
  const thread = `ask-${loop}`;
  serve = await startScriptedServe(ASK, { argv: ['--agent-loop', loop, '--session-log', logs] });
  try {
    const client = await serveClient(serve.running);
    const events: AsyncIterator<Event> = await client.openEvents(thread);
    await client.runStart(thread, '動手。');
    const parked = await foldTurn(events);
    const question = parked.pendings[0];
    if (question === undefined) throw new Error(`${loop}：沒有停在問題上`);
    await client.inputRespond(thread, {
      namespace: [...question.namespace],
      interrupt_id: question.interruptId,
      response: { answers: [{ id: 'day', selected: ['週一'] }] },
    });
    const done = await foldTurn(events, parked);
    await events.return?.(undefined);
    await serve.close();
    serve = undefined;
    const [project] = readdirSync(logs);
    return { parked, done, log: await sessionEventsOf(join(logs, project!), thread) };
  } finally {
    await rm(logs, { recursive: true, force: true });
  }
}

describe('--agent-loop', () => {
  it.each([
    ['CLI', parseCliArgs],
    ['serve', parseServeArgs],
  ] as const)('%s：只收 langgraph、native，省略即不設', (_label, parse) => {
    expect(parse(['--agent-loop', 'native']).agentLoop).toBe('native');
    expect(parse(['--agent-loop', 'langgraph']).agentLoop).toBe('langgraph');
    expect(parse([])).not.toHaveProperty('agentLoop');
    for (const raw of ['Native', 'pregel', '']) {
      expect(() => parse([`--agent-loop=${raw}`])).toThrow(
        /--agent-loop 只收 langgraph、native[\s\S]*用法/,
      );
    }
  });
});

describe('serve --agent-loop native', () => {
  it('ask_user_question 停在問題上，答了收完；日誌（含 interrupt/raised 與接回那一對）跟 langgraph 的一樣', async () => {
    const native = await askAndAnswer('native');
    expect(native.parked.pendings).toHaveLength(1);
    expect(native.done.pendings).toEqual([]);
    expect(JSON.stringify(native.done)).toContain('收工。');

    const raised = native.log.filter((event) => event.type === 'interrupt/raised');
    expect(raised).toHaveLength(1);
    expect(native.log.filter((event) => event.type === 'tool/call')).toHaveLength(2);

    const langgraph = await askAndAnswer('langgraph');
    expect(shapeOf(native.log)).toEqual(shapeOf(langgraph.log));
  }, 120000);

  it('沙箱升級當下拒絕（no-channel），不掛核准卡', async () => {
    const workspace = await mkdtemp(join('/var/tmp', 'nexus-native-escalation-'));
    const built = await createCliAgent(
      { live: false, workspace, sandbox: 'read-only', agentLoop: 'native' },
      withScriptedModel(await shippedPlugins(), [
        {
          content: '',
          toolCalls: [
            {
              name: SANDBOX_ESCALATION_TOOL_NAME,
              args: {
                file_path: '/note.txt',
                sandbox_permissions: 'workspace-write',
                justification: '使用者要這個檔',
              },
            },
          ],
        },
        { content: '停。' },
      ]),
      workspace,
    );
    const detach = built.attachSession(built.sessions);
    try {
      const result = await built.agent.invoke(toAgentInvocation('升級。'), {
        configurable: { thread_id: 'native-escalation' },
      });
      expect((result as { __interrupt__?: unknown }).__interrupt__).toBeUndefined();
      const reply = (result.messages as BaseMessage[])
        .filter((message) => message.getType() === 'tool')
        .map((message) => String(message.content))
        .join('\n');
      expect(reply).toContain(unaskedRefusal('no-channel', 'workspace-write'));
    } finally {
      detach();
      await built.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  }, 60000);
});

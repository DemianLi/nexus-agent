/**
 * `--agent-loop native` 在產品組裝上（[#2356](https://github.com/DemianLi/nexus-agent/issues/2356)）：組裝根、pump、wire。
 *
 * native loop 接不回中斷（TODO(#2358)），所以兩處算答題管道時「有存檔點」是 `false`：要問人的工具當下拒絕，不發中斷。
 * 入口那一份（`cordis-root.ts` 的 `entryApprovalChannel`）給樹上的 ask-user，組裝根那一份（`assembly-root.ts`）給沙箱升級，各一條。
 * 對照組是 `ask-user-assembly.test.ts` 的 serve 那條與 `legacy-thread-escalation.test.ts`（LangGraph 下停在中斷）。
 *
 * **零憑證、零外部連線**：模型是腳本。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { BaseMessage } from '@langchain/core/messages';

import { ASK_USER_QUESTION_TOOL_NAME, noAnswererMessage } from '@nexus/plugin-ask-user';
import { SANDBOX_ESCALATION_TOOL_NAME, unaskedRefusal } from '@nexus/plugin-sandbox-policy';
import type { ConversationState } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';

import { createCliAgent } from './assembly-root.js';
import { parseCliArgs } from './cli.js';
import { foldTurn, serveClient, shippedPlugins, withScriptedModel } from './fixtures.js';
import { toAgentInvocation } from './messages.js';
import { startScriptedServe } from './scripted-serve.js';
import { parseServeArgs } from './serve.js';
import type { ScriptedServe } from './scripted-serve.js';
import type { ScriptedTurn } from './scripted-model.js';

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

async function finishedTurn(server: ScriptedServe, threadId: string): Promise<ConversationState> {
  const client = await serveClient(server.running);
  const events = await client.openEvents(threadId);
  await client.runStart(threadId, '動手。');
  const state = await foldTurn(events);
  await events.return?.(undefined);
  return state;
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
  it('ask_user_question 當下拒絕（no-channel），這一輪照常收完', async () => {
    serve = await startScriptedServe(ASK, { argv: ['--agent-loop', 'native'] });
    const state = await finishedTurn(serve, 'native-ask');

    expect(state.pendings).toEqual([]);
    const text = JSON.stringify(state);
    expect(text).toContain(noAnswererMessage({ kind: 'no-channel' }).slice(0, 20));
    expect(text).toContain('收工。');
  }, 60000);

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

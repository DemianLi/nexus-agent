/**
 * 背景子代理被 MCP server 反問（[#1098](https://github.com/DemianLi/nexus-agent/issues/1098)）：背後沒有人，一律回絕。
 *
 * 走產品的線：真的組裝、真的 `createWireHandler`、新協議 stdio server、假模型。背景子代理的串流以前只抽乾、不看中斷——
 * 反問會讓它停在一顆沒人會答的中斷上；現在它收到 `decline`，工具照常回傳，子代理繼續做完、主對話被叫醒。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemorySaver } from '@langchain/langgraph';
import { createHostServicesPlugin } from '@nexus/core';
import type { PluginEntry, SessionEvent, SessionRegistry } from '@nexus/core';
import { createMcpPlugin } from '@nexus/plugin-mcp';
import { createWireClient } from '@nexus/wire';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
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

const SERVER = fileURLToPath(
  new URL('../../../packages/nexus-plugin-mcp/src/modern-stdio-server.ts', import.meta.url),
);
const shipped = await shippedPlugins();

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexus-bg-elicit-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function until(predicate: () => boolean, ms = 20_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('等太久了');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

it('背景子代理的工具被反問：系統回絕、工具照常回傳、子代理做完，日誌記代答', async () => {
  const worker: PluginEntry = {
    plugin: {
      name: 'worker-host',
      apply(registry) {
        registry.subagents.register({
          name: 'worker',
          description: '幹活的。',
          systemPrompt: '你是 worker。',
          model: new ScriptedChatModel({
            turns: [
              { content: '', toolCalls: [{ name: 'mcp__srv__ask_form', id: 'bg-ask', args: {} }] },
              { content: '做完，表單被拒絕了' },
            ],
          }) as never,
        });
      },
    },
  };
  const built = await createNexusAgent({
    model: new ScriptedChatModel({
      turns: [
        {
          content: '委派。',
          toolCalls: [
            {
              name: 'subagent',
              id: 'root-call',
              args: { description: '幹活', subagent_type: 'worker', run_in_background: true },
            },
          ],
        },
        { content: '根收尾' },
        { content: '收到' },
        { content: '也收到' },
      ],
    }),
    checkpointer: new MemorySaver(),
    plugins: [
      createHostServicesPlugin({ channel: { kind: 'human' } }, 'bg-elicit-channel'),
      ...shipped,
      worker,
      createMcpPlugin({
        serverName: 'srv',
        connection: {
          transport: 'stdio',
          command: process.execPath,
          args: ['--import', 'tsx', SERVER],
        },
      }),
    ],
    backend: new ContainedFilesystemBackend({ rootDir: dir, mode: 'workspace-write' }),
    backgroundSubagents: {},
  });
  let sessions: SessionRegistry | undefined;
  const handler = createWireHandler({
    auth: TEST_BROWSER_AUTH,
    createAgent: async () => ({
      agent: built.agent as unknown as PumpAgent,
      commands: emptyCommandPoint(),
      stepInbox: built.stepInbox,
      attachSessions: (registry, backgroundPort) => {
        sessions = registry;
        return composeAttachSessions(built)(registry, backgroundPort);
      },
      dispose: built.dispose,
    }),
  });
  const client = createWireClient({
    baseUrl: 'http://bg-elicit.test',
    fetch: async (input, init) => handler.handle(loopbackRequest(input as string, init)),
  });
  const events = await client.openEvents('bg-elicit-thread');
  const draining = (async () => {
    for (;;) {
      const next = await events.next();
      if (next.done === true) return;
    }
  })();
  const childLogs = (): (readonly SessionEvent[])[] =>
    sessions
      ?.list()
      .filter((entry) => entry.address.kind === 'subagent')
      .map((entry) => entry.log.events) ?? [];
  try {
    await client.runStart('bg-elicit-thread', '幫我查');
    const child = (): readonly SessionEvent[] =>
      childLogs().find((log) => log.some((event) => event.type === 'interrupt/system-answered')) ??
      [];
    await until(() => child().some((event) => event.type === 'tool/result'));
    expect(
      child()
        .filter((event) => event.type === 'interrupt/system-answered')
        .map((event) => event.data),
    ).toMatchObject([{ reason: 'subagent', keys: ['profile'] }]);
    // 工具照常回傳：server 收到的是 decline，不是工具錯誤。
    const results = child().filter((event) => event.type === 'tool/result');
    expect(JSON.stringify(results.map((event) => event.data))).toContain('profile=decline');
    expect(results.every((event) => (event.data as { isError?: boolean }).isError !== true)).toBe(
      true,
    );
    // 子代理做完，主對話被叫醒（背景子代理沒有因此卡在中斷上）。
    await until(() =>
      (sessions?.list().find((e) => e.address.kind === 'root')?.log.events ?? []).some(
        (event) => event.type === 'turn/start' && event.data.kind === 'subagent-settled',
      ),
    );
  } finally {
    await handler.close();
    await draining.catch(() => undefined);
  }
}, 60_000);

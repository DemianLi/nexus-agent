/**
 * MCP 那一列的核准宣告碰上子代理（[#1622](https://github.com/DemianLi/nexus-agent/issues/1622) 的 G、H 兩格）：
 *
 * - **G 背景子代理**：背後沒有人，閘門換成管道固定 `policy-never` 的那一顆，宣告要問的工具一律回絕，碼 `APPROVAL_POLICY_NEVER`。
 * - **H 前景子代理**：照 #328 問 root 的人；核准前 server 收不到。
 *
 * 量的同樣是 **server 那一側有沒有收到 `tools/call`**（`FIXTURE_CALL_LOG`，見 [`mcp-approval-wire.test.ts`](./mcp-approval-wire.test.ts)）。
 * 0 行的反面在 H：核准之後同一支收到一次，證明這個檔的夾具寫得到記號。
 *
 * 產品路徑：真的 `createNexusAgent`、真的 MCP 插件與 stdio server、腳本模型。G 走 `createWireHandler`（背景子代理要它給的背景埠），
 * 形狀照 `mcp-elicitation-background.test.ts`；H 走 `ThreadPump`，形狀照 `subagent-approval.test.ts`。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemorySaver } from '@langchain/langgraph';
import { APPROVAL_POLICY_NEVER, createHostServicesPlugin } from '@nexus/core';
import type { PluginEntry, SessionEvent, SessionRegistry } from '@nexus/core';
import { createMcpPlugin, publicToolName } from '@nexus/plugin-mcp';
import { createWireClient } from '@nexus/wire';
import type { Event } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { emptyCommandPoint, loopbackRequest, TEST_BROWSER_AUTH } from './fixtures.js';
import { ScriptedChatModel } from './scripted-model.js';
import { composeAttachSessions } from './session-attach.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';

const SERVER = fileURLToPath(new URL('./mcp-fixture-server.ts', import.meta.url));
const RECORD = publicToolName('crm', 'record_order');
const REASON = 'MCP server crm 的工具 record_order 要先讓人看過（設定 approval）';

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

async function until(predicate: () => boolean, ms = 20_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('等太久了');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 一列沒寫 `approval` 的 MCP（Q2 (a)：整台都問），server 收到的呼叫記進回傳的檔。 */
function crmRow(): { readonly row: PluginEntry; calls(): string[] } {
  const callLog = join(temp('nexus-mcp-calls-'), 'calls.log');
  return {
    row: createMcpPlugin({
      serverName: 'crm',
      connection: {
        transport: 'stdio',
        command: process.execPath,
        args: ['--import', 'tsx', SERVER],
        env: { FIXTURE_CALL_LOG: callLog },
      },
    }),
    calls: () =>
      existsSync(callLog) ? readFileSync(callLog, 'utf8').split('\n').filter(Boolean) : [],
  };
}

/** 一個叫 MCP 寫入工具的子代理，模型自己帶，所以跟 root 的腳本不搶輪。 */
function workerHost(): PluginEntry {
  return {
    plugin: {
      name: 'worker-host',
      apply(registry) {
        registry.subagents.register({
          name: 'worker',
          description: '幹活的。',
          systemPrompt: '你是 worker。',
          model: new ScriptedChatModel({
            turns: [
              {
                content: '',
                toolCalls: [{ name: RECORD, id: 'sub-call', args: { item: '螺絲' } }],
              },
              { content: '子代理收工。' },
            ],
          }) as never,
        });
      },
    },
  };
}

describe('子代理叫宣告要問的 MCP 工具', () => {
  it('G：背景子代理一律回絕，碼 APPROVAL_POLICY_NEVER；server 一次都沒收到', async () => {
    const crm = crmRow();
    const built = await createNexusAgent({
      model: new ScriptedChatModel({
        turns: [
          {
            content: '委派。',
            toolCalls: [
              {
                name: 'subagent',
                id: 'root-call',
                args: { description: '登記', subagent_type: 'worker', run_in_background: true },
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
        createHostServicesPlugin({ channel: { kind: 'human' } }, 'bg-approval-channel'),
        workerHost(),
        crm.row,
      ],
      backend: new ContainedFilesystemBackend({
        rootDir: temp('nexus-mcp-bg-'),
        mode: 'workspace-write',
      }),
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
      baseUrl: 'http://mcp-bg-approval.test',
      fetch: async (input, init) => handler.handle(loopbackRequest(input as string, init)),
    });
    const events = await client.openEvents('bg-approval');
    const draining = (async () => {
      for (;;) {
        const next = await events.next();
        if (next.done === true) return;
      }
    })();
    const logOf = (kind: 'root' | 'subagent'): readonly SessionEvent[] =>
      sessions?.list().find((entry) => entry.address.kind === kind)?.log.events ?? [];
    try {
      await client.runStart('bg-approval', '幫我登記');
      await until(() => logOf('subagent').some((event) => event.type === 'tool/result'));

      const result = logOf('subagent').find((event) => event.type === 'tool/result');
      expect(result?.data).toMatchObject({ error: { code: APPROVAL_POLICY_NEVER } });
      expect(logOf('subagent').some((event) => event.type === 'interrupt/raised')).toBe(false);
      expect(logOf('root').some((event) => event.type === 'interrupt/raised')).toBe(false);
      // 子代理照常做完、主對話被叫醒：沒有卡在一顆沒人會答的中斷上。
      await until(() =>
        logOf('root').some(
          (event) => event.type === 'turn/start' && event.data.kind === 'subagent-settled',
        ),
      );
      expect(crm.calls()).toEqual([]);
    } finally {
      await handler.close();
      await draining.catch(() => undefined);
    }
  }, 60_000);

  it('H：前景子代理問 root 的人；核准前 server 沒收到，按允許之後收到一次', async () => {
    const crm = crmRow();
    const built = await createNexusAgent({
      model: new ScriptedChatModel({
        turns: [
          {
            content: '委派。',
            toolCalls: [{ name: 'task', args: { description: '登記', subagent_type: 'worker' } }],
          },
          { content: '根收工。' },
        ],
      }),
      checkpointer: new MemorySaver(),
      plugins: [workerHost(), crm.row],
    });
    const pump = new ThreadPump(built.agent as unknown as PumpAgent, 'fg-approval');
    const detach = built.attachSession(pump.sessions);
    const frames: Event[] = [];
    const line = new AbortController();
    const stream = pump.subscribe(['messages', 'tools', 'lifecycle', 'input'], line.signal);
    const draining = (async () => {
      for await (const frame of stream) frames.push(frame);
    })();
    try {
      await pump.submit({ kind: 'message', text: '委派' });
      await until(() => pump.awaitingInput);
      await pump.whenIdle();

      const requests = frames.filter((frame) => frame.method === 'input.requested');
      expect(requests).toHaveLength(1);
      // 問的是 root 的人，卡上標著是哪個子代理（namespace 第一段是那次委派呼叫）。
      expect(requests[0]?.params.namespace[0]).toMatch(/^tools:/);
      const asked = pump.sessions.root.events.filter((event) => event.type === 'approval/asked');
      expect(asked.map((event) => event.data)).toMatchObject([
        { toolName: RECORD, reason: REASON },
      ]);
      expect(crm.calls()).toEqual([]);

      await pump.submit({
        kind: 'resume',
        interruptId: pump.pendings[0]!.interruptId,
        response: { decisions: [{ type: 'approve' }] },
      });
      await pump.whenIdle();
      expect(crm.calls()).toEqual(['record_order']);
    } finally {
      line.abort();
      await draining;
      detach();
      await built.dispose();
    }
  }, 60_000);
});

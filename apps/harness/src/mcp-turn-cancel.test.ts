/**
 * **按停止之後，MCP 那支慢呼叫在 server 那一側也被取消**——[#1985](https://github.com/DemianLi/nexus-agent/issues/1985) 的驗收。
 *
 * 走真的進入點（`ThreadPump`）與真的 stdio 子行程：慢查詢被呼叫時往記號檔寫 `started`，server 收到取消時寫 `cancelled`。
 * 判準是 server 那一側的記號，不是 client 看到什麼；沒收到取消的話，這一輪要等慢查詢自己睡醒（{@link SLOW_QUERY_MS}）才落定。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`。
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemorySaver } from '@langchain/langgraph';
import { TOOL_ABORTED } from '@nexus/core';
import type { SessionEvent } from '@nexus/core';
import { createMcpPlugin } from '@nexus/plugin-mcp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { CHANGELOG, SLOW_QUERY, SLOW_QUERY_MS, SLOW_REPORT_URI } from './mcp-fixture-server.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

const FIXTURE_SERVER = fileURLToPath(new URL('./mcp-fixture-server.ts', import.meta.url));
const SLOW_TOOL = `mcp__docs__${SLOW_QUERY}`;
const FETCH_TOOL = 'mcp__docs__fetch_changelog';

let dir: string;
let slowLog: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexus-mcp-cancel-'));
  slowLog = join(dir, 'slow.log');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** 記號檔目前的每一行；還沒寫過就是空的。 */
async function marks(): Promise<string[]> {
  try {
    return (await readFile(slowLog, 'utf8')).split('\n').filter((line) => line !== '');
  } catch {
    return [];
  }
}

async function until(predicate: () => Promise<boolean>, ms: number): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > ms) throw new Error('等太久了');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function assemble(turns: readonly ScriptedTurn[], toolCallTimeoutMs?: number) {
  const model = new ScriptedChatModel({ turns });
  const built = await createNexusAgent({
    model,
    checkpointer: new MemorySaver(),
    plugins: [
      createMcpPlugin({
        serverName: 'docs',
        // 量的不是核准：這台的工具都不問。
        approval: { default: 'allow' },
        ...(toolCallTimeoutMs !== undefined && { toolCallTimeoutMs }),
        connection: {
          transport: 'stdio',
          command: process.execPath,
          args: ['--import', 'tsx', FIXTURE_SERVER],
          env: { FIXTURE_SLOW_LOG: slowLog },
        },
      }),
    ],
  });
  const pump = new ThreadPump(built.agent as unknown as PumpAgent, 'mcp-cancel');
  const detach = built.attachSession(pump.sessions);
  const root = (): readonly SessionEvent[] =>
    pump.sessions.list().find((entry) => entry.address.kind === 'root')?.log.events ?? [];
  return {
    model,
    pump,
    root,
    close: async () => {
      detach();
      await built.dispose();
    },
  };
}

const resultsOf = (events: readonly SessionEvent[]) =>
  events.flatMap((event) => {
    if (event.type !== 'tool/result') return [];
    const { message: _message, ...verdict } = event.data;
    return [verdict];
  });

describe('MCP 呼叫跑到一半按停止', () => {
  it('server 收到取消、這一輪不等慢查詢睡醒就落定成中止；下一輪同一台照常', async () => {
    const run = await assemble([
      { content: '查一下。', toolCalls: [{ name: SLOW_TOOL, args: { query: '庫存' } }] },
      { content: '', toolCalls: [{ name: FETCH_TOOL, args: { project: 'nexus-agent' } }] },
      { content: '查到了。' },
    ]);
    try {
      const turn = run.pump.submit({ kind: 'message', text: '查庫存' });
      await until(async () => (await marks()).includes('started'), 20_000);
      const stoppedAt = Date.now();
      expect(run.pump.cancel()).toBe('run');
      await turn;
      const settledIn = Date.now() - stoppedAt;

      expect(await marks()).toEqual(['started', 'cancelled']);
      expect(settledIn).toBeLessThan(SLOW_QUERY_MS / 3);
      const events = run.root();
      expect(events.at(-1)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'aborted', cause: { kind: 'user' } } },
      });
      expect(resultsOf(events)).toEqual([
        {
          callId: expect.any(String),
          isError: true,
          error: { name: 'AbortError', code: TOOL_ABORTED },
        },
      ]);

      // 中止的錯不能被當成斷線：同一台 server 下一輪照常回資料。
      await run.pump.submit({ kind: 'message', text: '那變更紀錄呢' });
      const texts = run
        .root()
        .flatMap((event) => (event.type === 'tool/result' ? [JSON.stringify(event.data)] : []));
      expect(texts.at(-1)).toContain(CHANGELOG);
    } finally {
      await run.close();
    }
  }, 60_000);

  it('讀資源跑到一半按停止：server 收到取消，這一輪不等它睡醒', async () => {
    const run = await assemble([
      {
        content: '讀報表。',
        toolCalls: [{ name: 'read_mcp_resource', args: { server: 'docs', uri: SLOW_REPORT_URI } }],
      },
      { content: '讀到了。' },
    ]);
    try {
      const turn = run.pump.submit({ kind: 'message', text: '讀報表' });
      await until(async () => (await marks()).includes('started'), 20_000);
      const stoppedAt = Date.now();
      expect(run.pump.cancel()).toBe('run');
      await turn;

      expect(await marks()).toEqual(['started', 'cancelled']);
      expect(Date.now() - stoppedAt).toBeLessThan(SLOW_QUERY_MS / 3);
      expect(run.root().at(-1)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'aborted', cause: { kind: 'user' } } },
      });
      expect(resultsOf(run.root())).toEqual([
        {
          callId: expect.any(String),
          isError: true,
          error: { name: 'AbortError', code: TOOL_ABORTED },
        },
      ]);
    } finally {
      await run.close();
    }
  }, 60_000);

  it('沒按停止、是 MCP 自己的逾時到點：不記成 ABORTED，這一輪照常往下走', async () => {
    const run = await assemble(
      [
        { content: '查一下。', toolCalls: [{ name: SLOW_TOOL, args: { query: '庫存' } }] },
        { content: '查不到。' },
      ],
      300,
    );
    try {
      await run.pump.submit({ kind: 'message', text: '查庫存' });

      const events = run.root();
      // 正常落定的 turn/end 不帶 reason。
      expect(events.at(-1)).toMatchObject({ type: 'turn/end', data: {} });
      expect(events.at(-1)).not.toHaveProperty('data.reason');
      const [verdict] = resultsOf(events);
      const [result] = events.filter((event) => event.type === 'tool/result');
      expect(verdict).toMatchObject({ isError: true });
      expect(JSON.stringify(result?.data)).toContain('aborted due to timeout');
      expect(verdict).not.toHaveProperty('error.code', TOOL_ABORTED);
    } finally {
      await run.close();
    }
  }, 60_000);
});

/**
 * MCP 工具結果的 artifact 不會把原始資料帶進會話日誌，也到不了瀏覽器（[#1320](https://github.com/DemianLi/nexus-agent/issues/1320)）。
 *
 * 起一台真的 MCP server（stdio），要它回幾 MB 的內嵌資源、結構值與圖片，走完整條線——agent、會話日誌、
 * 即時串流與歷史端點——量每一層看到多大。對照 `packages/nexus-plugin-mcp/src/artifact-bound.ts` 裡的實測表：
 * 沒有上限處理之前，內嵌資源 3 MB 就是 3 MB 的 `tool/result`。
 */

import { fileURLToPath } from 'node:url';
import { SessionRegistry } from '@nexus/core';
import type { SessionEvent } from '@nexus/core';
import { createMcpPlugin } from '@nexus/plugin-mcp';
import { createWireClient } from '@nexus/wire';
import { describe, expect, it } from 'vitest';
import { createNexusAgent } from './agent-factory.js';
import { emptyCommandPoint, loopbackRequest, TEST_BROWSER_AUTH } from './fixtures.js';
import { PrunedMemorySaver } from './pruned-memory-saver.js';
import { ScriptedChatModel } from './scripted-model.js';
import { composeAttachSessions } from './session-attach.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';

const SERVER = fileURLToPath(
  new URL('../../../packages/nexus-plugin-mcp/src/fixture-server.ts', import.meta.url),
);

/** 一次完整呼叫量到的東西。 */
interface Measured {
  /** 會話日誌裡 `tool/result` 序列化後的位元組。 */
  readonly logResult: number;
  readonly artifact: unknown;
  /** 即時串流所有 frame 的序列化總位元組。 */
  readonly stream: number;
  /** `GET /threads/:id/history` 回應的序列化位元組。 */
  readonly history: number;
  /** 串流與歷史端點中是否出現過填充字元（原始資料漏上線的徵兆）。 */
  readonly leaked: boolean;
}

async function measure(tool: string, kb: number): Promise<Measured> {
  const model = new ScriptedChatModel({
    turns: [
      { content: '', toolCalls: [{ name: `mcp__srv__${tool}`, args: { kb } }] },
      { content: '收工。' },
    ],
  });
  const built = await createNexusAgent({
    model,
    checkpointer: new PrunedMemorySaver(),
    plugins: [
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
  let sessions: SessionRegistry | undefined;
  const handler = createWireHandler({
    auth: TEST_BROWSER_AUTH,
    createAgent: async () => ({
      agent: built.agent as unknown as PumpAgent,
      commands: emptyCommandPoint(),
      attachSessions: (registry, backgroundPort) => {
        sessions = registry;
        return composeAttachSessions(built)(registry, backgroundPort);
      },
      dispose: built.dispose,
    }),
  });
  try {
    const client = createWireClient({
      baseUrl: 'http://m.test',
      fetch: async (input, init) => handler.handle(loopbackRequest(input as string, init)),
    });
    const thread = `artifact-size-${tool}`;
    const events = await client.openEvents(thread);
    await client.runStart(thread, '呼叫工具');
    const frames: string[] = [];
    for (;;) {
      const next = await events.next();
      if (next.done === true) break;
      frames.push(JSON.stringify(next.value));
      const data = next.value.params.data as { event?: string; graph_name?: string } | null;
      if (
        next.value.method === 'lifecycle' &&
        next.value.params.namespace.length === 0 &&
        data?.graph_name === 'root' &&
        (data.event === 'completed' || data.event === 'failed')
      ) {
        break;
      }
    }
    const history = JSON.stringify(await client.threadHistory(thread));
    const log: readonly SessionEvent[] =
      sessions
        ?.list()
        .filter((entry) => entry.address.kind === 'root')
        .map((entry) => entry.log.events)[0] ?? [];
    const result = log.find((event) => event.type === 'tool/result');
    const message =
      result?.type === 'tool/result'
        ? (result.data.message?.data as { artifact?: unknown } | undefined)
        : undefined;
    return {
      logResult: JSON.stringify(result).length,
      artifact: message?.artifact,
      stream: frames.reduce((sum, frame) => sum + frame.length, 0),
      history: history.length,
      leaked: [...frames, history].some((text) => text.includes('AAAAAAAAAAAAAAAA')),
    };
  } finally {
    void handler.close();
    await built.dispose();
  }
}

describe('MCP 的 artifact 到會話日誌與瀏覽器各多大（#1320）', () => {
  it('內嵌資源 3 MB：日誌只有占位，串流與歷史端點不帶原始資料', async () => {
    const m = await measure('embed_blob', 3072);
    expect(m.logResult).toBeLessThan(16 * 1024);
    expect(m.artifact).toEqual([
      expect.objectContaining({
        type: 'mcp_omitted',
        originalType: 'resource',
        uri: expect.any(String),
      }),
    ]);
    expect(m.stream).toBeLessThan(64 * 1024);
    expect(m.history).toBeLessThan(64 * 1024);
    expect(m.leaked).toBe(false);
  }, 60_000);

  it('structuredContent 1 MB：日誌只有占位', async () => {
    const m = await measure('structured', 1024);
    expect(m.logResult).toBeLessThan(16 * 1024);
    expect(JSON.stringify(m.artifact)).toContain('mcp_omitted');
    expect(m.stream).toBeLessThan(64 * 1024);
    expect(m.history).toBeLessThan(64 * 1024);
  }, 60_000);

  it('圖片 3 MB：adapter 不把它放 artifact，日誌只有說明文字', async () => {
    const m = await measure('big_image', 3072);
    expect(m.logResult).toBeLessThan(16 * 1024);
    expect(m.leaked).toBe(false);
  }, 60_000);
});

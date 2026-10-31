/**
 * 工具卡的結果文字（[#2174](https://github.com/DemianLi/nexus-agent/issues/2174)）。
 *
 * 起一台真的 MCP server（stdio），走完整條線到 wire，比同一張卡即時收到的 `tool-finished` 與重新載入讀到的歷史。
 * 抽字規則的逐項形狀在 `tool-result-text.test.ts`，前綴的形狀在 `packages/nexus-plugin-mcp/src/untrusted-mark.test.ts`。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTERNAL_MCP_CONTENT_NOTICE, SessionRegistry } from '@nexus/core';
import { createMcpPlugin } from '@nexus/plugin-mcp';
import { createWireClient } from '@nexus/wire';
import { describe, expect, it } from 'vitest';
import { createNexusAgent } from './agent-factory.js';
import { emptyCommandPoint, loopbackRequest, TEST_BROWSER_AUTH } from './fixtures.js';
import { PrunedMemorySaver } from './pruned-memory-saver.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedToolCall } from './scripted-model.js';
import { composeAttachSessions } from './session-attach.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';

const SERVER = fileURLToPath(
  new URL('../../../packages/nexus-plugin-mcp/src/fixture-server.ts', import.meta.url),
);

const PREFIX = `${EXTERNAL_MCP_CONTENT_NOTICE}\n\n`;

interface Finished {
  readonly event?: string;
  readonly tool_call_id?: string;
  readonly message?: string;
}

/** 每張卡最後一顆 `tool-finished` 的文字，依第一次出現的順序。 */
function cardTexts(frames: readonly Finished[]): (string | undefined)[] {
  const byCall = new Map<string | undefined, string | undefined>();
  for (const frame of frames) {
    if (frame.event === 'tool-finished') byCall.set(frame.tool_call_id, frame.message);
  }
  return [...byCall.values()];
}

/** 深入一個 JSON 值，收集所有 `tool-finished`：歷史頁的外殼不是這一檔要量的。 */
function finishedIn(value: unknown): Finished[] {
  if (Array.isArray(value)) return value.flatMap(finishedIn);
  if (typeof value !== 'object' || value === null) return [];
  const record = value as Finished & Record<string, unknown>;
  if (record.event === 'tool-finished') return [record];
  return Object.values(record).flatMap(finishedIn);
}

/** @returns 即時與重新載入各自看到的卡片文字。 */
async function run(
  calls: readonly ScriptedToolCall[],
  spill?: { readonly stashRoot: string; readonly maxInlineTokens: number },
): Promise<{ readonly live: (string | undefined)[]; readonly reloaded: (string | undefined)[] }> {
  const model = new ScriptedChatModel({
    turns: [{ content: '', toolCalls: calls }, { content: '收工。' }],
  });
  const built = await createNexusAgent({
    model,
    checkpointer: new PrunedMemorySaver(),
    ...(spill !== undefined && {
      spillPolicy: { maxInlineTokens: spill.maxInlineTokens },
      toolResultStash: { rootDir: spill.stashRoot, session: 'tool-card-text' },
    }),
    plugins: [
      createMcpPlugin({
        serverName: 'srv',
        approval: { default: 'allow' },
        connection: {
          transport: 'stdio',
          command: process.execPath,
          args: ['--import', 'tsx', SERVER],
          env: { FIXTURE_RESOURCES: '1' },
        },
      }),
    ],
  });
  const handler = createWireHandler({
    auth: TEST_BROWSER_AUTH,
    createAgent: async () => ({
      agent: built.agent as unknown as PumpAgent,
      commands: emptyCommandPoint(),
      attachSessions: (registry: SessionRegistry, backgroundPort) =>
        composeAttachSessions(built)(registry, backgroundPort),
      dispose: built.dispose,
    }),
  });
  try {
    const client = createWireClient({
      baseUrl: 'http://m.test',
      fetch: async (input, init) => handler.handle(loopbackRequest(input as string, init)),
    });
    const thread = 'tool-card-text';
    const events = await client.openEvents(thread);
    await client.runStart(thread, '呼叫工具');
    const live: Finished[] = [];
    for (;;) {
      const next = await events.next();
      if (next.done === true) break;
      const data = next.value.params.data as (Finished & { graph_name?: string }) | null;
      if (data === null) continue;
      if (next.value.method === 'tools') live.push(data);
      if (
        next.value.method === 'lifecycle' &&
        next.value.params.namespace.length === 0 &&
        data.graph_name === 'root' &&
        (data.event === 'completed' || data.event === 'failed')
      ) {
        break;
      }
    }
    const page = await client.threadHistory(thread);
    return { live: cardTexts(live), reloaded: cardTexts(finishedIn(page)) };
  } finally {
    void handler.close();
    await built.dispose();
  }
}

const call = (name: string, args: Record<string, unknown> = {}): ScriptedToolCall => ({
  name: `mcp__srv__${name}`,
  args,
});

describe('MCP 結果的文字到得了工具卡（#2174）', () => {
  it('多塊文字、只回一張圖、文字夾圖；單塊與資源不變；即時與重新載入相同', async () => {
    const { live, reloaded } = await run([
      call('two_texts'),
      call('only_image'),
      call('snapshot'),
      call('fetch_release_note', { topic: '發行說明' }),
      { name: 'read_mcp_resource', args: { server: 'srv', uri: 'memo://readme' } },
    ]);
    const image = '[image unavailable: image/png; no attachment store is mounted]';
    expect(live.slice(0, 3)).toEqual([
      `${PREFIX}第一段\n\n第二段`,
      `${PREFIX}${image}`,
      `${PREFIX}畫面之前\n\n${image}\n\n畫面之後`,
    ]);
    expect(live[3]).toBe(`${PREFIX}發行說明｜nexus-agent 0.1.0：plugin 契約與 MCP 接入。`);
    expect(live[4]?.startsWith(`MCP server: srv\n\n${PREFIX}`)).toBe(true);
    expect(reloaded).toEqual(live);
  }, 90_000);

  it('多塊結果外溢之後，前綴後面仍是空一行', async () => {
    const stashRoot = await mkdtemp(join(tmpdir(), 'nexus-tool-card-text-'));
    try {
      const { live, reloaded } = await run([call('two_texts', { kb: 64 })], {
        stashRoot,
        maxInlineTokens: 400,
      });
      expect(live[0]?.length).toBeLessThan(64 * 1024);
      expect(live[0]?.startsWith(PREFIX)).toBe(true);
      expect(reloaded).toEqual(live);
    } finally {
      await rm(stashRoot, { recursive: true, force: true });
    }
  }, 90_000);
});

/**
 * 錯誤路徑的遮蔽（[#2669](https://github.com/DemianLi/nexus-agent/issues/2669)）：`toolCallOf`、`connectGeneration`、`openClient`
 * 各自把憑證值從拋出去的錯誤裡遮掉；沒有憑證的連線原樣。
 *
 * 逾時那一條是回歸釘：遮過的 `cause` 必須保留 `code`／`name`，連線層（`isRequestTimeout`）靠它們認逾時、才會探活。
 */

import type { Client, Tool } from '@modelcontextprotocol/client';
import type { ToolExec } from '@nexus/tools';
import { describe, expect, it } from 'vitest';
import { connectGeneration, isRequestTimeout, openClient } from './connection.js';
import { mcpConfigSchema } from './index.js';
import { createRedactor, NO_REDACTION } from './redact.js';
import { toolCallOf } from './tool-call.js';

const SECRET = 'FAKE-token-0123456789';
const redactor = createRedactor([SECRET]);

const descriptor = { name: 'probe', inputSchema: { type: 'object' } } as Tool;
const exec = { callId: 'call_1', signal: undefined } as unknown as ToolExec;
const options = (r = redactor) => ({ elicitation: false, timeoutMs: 1000, redactor: r });

/** 只有 `callTool` 的假 client：`behave` 決定它回什麼或拋什麼。 */
function clientThat(behave: () => unknown): Client {
  return {
    getProtocolEra: () => 'legacy',
    callTool: () => Promise.resolve().then(behave),
  } as unknown as Client;
}

const caught = (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => undefined,
    (error: unknown) => error,
  );

describe('toolCallOf：錯誤送出前遮掉憑證值', () => {
  it('SDK 拋的錯誤：訊息遮掉；cause 換成遮過的副本、保留 code，連線層仍認得逾時', async () => {
    const timeout = Object.assign(new Error(`timed out talking to ${SECRET}`), {
      code: 'REQUEST_TIMEOUT',
    });
    const call = toolCallOf(
      clientThat(() => {
        throw timeout;
      }),
      'srv',
      descriptor,
      options(),
    );
    const thrown = (await caught(call({}, exec))) as Error;
    expect(thrown.message).toContain('[redacted]');
    expect(thrown.message).not.toContain(SECRET);
    expect((thrown.cause as Error).message).not.toContain(SECRET);
    expect(thrown.cause).not.toBe(timeout);
    expect(isRequestTimeout(thrown)).toBe(true);
  });

  it('沒有憑證：cause 是原來那個 error', async () => {
    const original = new Error(`plain failure ${SECRET}`);
    const call = toolCallOf(
      clientThat(() => {
        throw original;
      }),
      'srv',
      descriptor,
      options(NO_REDACTION),
    );
    const thrown = (await caught(call({}, exec))) as Error;
    expect(thrown.cause).toBe(original);
  });

  it('isError 結果：文字遮掉', async () => {
    const call = toolCallOf(
      clientThat(() => ({ isError: true, content: [{ type: 'text', text: `denied ${SECRET}` }] })),
      'srv',
      descriptor,
      options(),
    );
    const thrown = (await caught(call({}, exec))) as Error;
    expect(thrown.message).toBe('denied [redacted]');
  });

  it('McpToolError 訊息帶 server 給的字串：遮掉、保留 class（isError 結果裡有認不得的內容類型）', async () => {
    const call = toolCallOf(
      clientThat(() => ({ isError: true, content: [{ type: SECRET }] })),
      'srv',
      descriptor,
      options(),
    );
    const thrown = (await caught(call({}, exec))) as Error;
    expect(thrown.name).toBe('McpToolError');
    expect(thrown.message).toContain('unexpected content type');
    expect(thrown.message).toContain('[redacted]');
    expect(thrown.message).not.toContain(SECRET);
  });

  it('成功結果裡認不得的內容類型：同樣遮掉、保留 class', async () => {
    const call = toolCallOf(
      clientThat(() => ({ content: [{ type: SECRET }] })),
      'srv',
      descriptor,
      options(),
    );
    const thrown = (await caught(call({}, exec))) as Error;
    expect(thrown.name).toBe('McpToolError');
    expect(thrown.message).not.toContain(SECRET);
  });
});

const httpConfig = mcpConfigSchema.parse({
  serverName: 'srv',
  connection: { transport: 'http', url: 'http://127.0.0.1:1/mcp' },
});

describe('connectGeneration／openClient：連線階段的錯誤遮掉憑證值', () => {
  it('tools/list 失敗：訊息與 cause 都遮掉', async () => {
    const failing = {
      getProtocolEra: () => 'legacy',
      getInstructions: () => undefined,
      onclose: undefined,
      listTools: () => Promise.reject(new Error(`list refused for ${SECRET}`)),
    } as unknown as Client;
    const thrown = (await caught(
      connectGeneration(() => Promise.resolve(failing), httpConfig, false, redactor),
    )) as Error;
    expect(thrown.message).toContain('Failed to load tools');
    expect(thrown.message).toContain('[redacted]');
    expect(thrown.message).not.toContain(SECRET);
    expect((thrown.cause as Error).message).not.toContain(SECRET);
  });

  it('tools/list 失敗、沒有憑證：cause 是原來那個 error', async () => {
    const original = new Error('list refused');
    const failing = {
      getProtocolEra: () => 'legacy',
      getInstructions: () => undefined,
      listTools: () => Promise.reject(original),
    } as unknown as Client;
    const thrown = (await caught(
      connectGeneration(() => Promise.resolve(failing), httpConfig, false, NO_REDACTION),
    )) as Error;
    expect(thrown.cause).toBe(original);
  });

  it('stdio 連線失敗：訊息與 cause 都遮掉（指令路徑帶著憑證值）', async () => {
    const config = mcpConfigSchema.parse({
      serverName: 'srv',
      connection: { transport: 'stdio', command: `/no/such/${SECRET}` },
    });
    const thrown = (await caught(
      openClient(config, new Map([['TOKEN', SECRET]]), () => {}, redactor),
    )) as Error;
    expect(thrown.message).toContain('Failed to connect to stdio server');
    expect(thrown.message).toContain('[redacted]');
    expect(thrown.message).not.toContain(SECRET);
    expect((thrown.cause as Error).message).not.toContain(SECRET);
  }, 30_000);
});

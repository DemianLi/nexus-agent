/**
 * 連線之後送出的錯誤也不印網址的 query（[#2669](https://github.com/DemianLi/nexus-agent/issues/2669)）：server 會把請求行寫進錯誤回應，
 * SDK 原樣帶進 `tools/call` 與 `tools/list` 的錯誤。真 server 跑舊、新兩種協議，回顯由夾具的 `failRpcMethod(…, true)` 造。
 */

import type { Client, Tool } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { attemptsOn, connectGeneration } from './connection.js';
import type { Attempts } from './connection.js';
import { startLegacyHttp, startModernHttp } from './http-fixtures.js';
import type { HttpFixture } from './http-fixtures.js';
import { mcpConfigSchema } from './index.js';
import { createRedactor } from './redact.js';

const TOKEN = 'QSECRET9f3a';

/** 錯誤本身、`cause` 鏈、每一層的 stack 串成一份文字。 */
function everything(error: unknown): string {
  const parts: string[] = [];
  for (let current = error, depth = 0; current !== undefined && depth < 8; depth += 1) {
    if (current instanceof Error) {
      parts.push(`${current.name}: ${current.message}`, current.stack ?? '');
      current = current.cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join('\n');
}

const caught = (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => undefined,
    (error: unknown) => error,
  );

const eras = [
  ['舊協議', startLegacyHttp],
  ['新協議', startModernHttp],
] as const;

let open: { fixture: HttpFixture; attempts: Attempts }[] = [];
afterEach(async () => {
  for (const { fixture, attempts } of open) {
    await attempts.close();
    await fixture.close();
  }
  open = [];
});

async function connection(start: () => Promise<HttpFixture>) {
  const fixture = await start();
  const config = mcpConfigSchema.parse({
    serverName: 'srv',
    connection: { transport: 'http', url: `${fixture.url}?token=${TOKEN}` },
  });
  const attempts = attemptsOn(config, false, new Map());
  open.push({ fixture, attempts });
  return { fixture, attempts };
}

describe.each(eras)('%s：server 把含 query 的請求行寫進錯誤回應', (_name, start) => {
  it('tools/call 的錯誤：訊息、cause 鏈、stack 都沒有 token 與 query，路徑還在', async () => {
    const { fixture, attempts } = await connection(start);
    const generation = await attempts.first();
    const call = generation.calls.get(generation.listed.tools[0]?.name ?? '');
    fixture.failRpcMethod('tools/call', true);
    const error = await caught(
      call?.({ topic: 'x' }, { callId: 'call_1', signal: undefined } as never) ?? Promise.resolve(),
    );
    expect(error).toBeInstanceOf(Error);
    const text = everything(error);
    expect(text).toContain('Cannot POST /mcp');
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('token=');
  });

  it('tools/list 的錯誤（連線建立）：訊息、cause 鏈、stack 都沒有 token 與 query', async () => {
    const { fixture, attempts } = await connection(start);
    fixture.failRpcMethod('tools/list', true);
    const error = await caught(attempts.first());
    expect(error).toBeInstanceOf(Error);
    const text = everything(error);
    expect(text).toContain('Cannot POST /mcp');
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('token=');
  });
});

describe('rejectTaskRequired：工具名裡的憑證值', () => {
  it('server 給的工具名帶憑證值，拒絕訊息遮掉它', async () => {
    const secret = 'FAKE-credential-0123456789';
    const config = mcpConfigSchema.parse({
      serverName: 'srv',
      connection: { transport: 'stdio', command: 'unused' },
    });
    const tool = {
      name: `tool_${secret}`,
      inputSchema: { type: 'object' },
      execution: { taskSupport: 'required' },
    } as unknown as Tool;
    const client = {
      getProtocolEra: () => 'legacy',
      getInstructions: () => undefined,
      listTools: () => Promise.resolve({ tools: [tool] }),
    } as unknown as Client;
    const listed = await connectGeneration(
      () => Promise.resolve(client),
      config,
      false,
      createRedactor([secret]),
    );
    const call = listed.calls.get(tool.name);
    const error = await caught(
      call?.({}, { callId: 'call_1', signal: undefined } as never) ?? Promise.resolve(),
    );
    expect((error as Error).message).toContain('requires task-based execution');
    expect((error as Error).message).not.toContain(secret);
  });
});

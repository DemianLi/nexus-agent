/**
 * 連線之後送出的錯誤也不印網址的 query（[#2669](https://github.com/DemianLi/nexus-agent/issues/2669)）：server 會把請求行寫進錯誤回應，
 * SDK 原樣帶進 `tools/call` 與 `tools/list` 的錯誤。真 server 跑舊、新兩種協議，回顯由夾具的 `failRpcMethod(…, true)` 造。
 */

import type { Client, Tool } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import {
  attemptsOn,
  connectGeneration,
  openClient,
  redactedUrl,
  withUrlScrubbing,
} from './connection.js';
import type { Attempts } from './connection.js';
import { startLegacyHttp, startModernHttp } from './http-fixtures.js';
import type { HttpFixture } from './http-fixtures.js';
import { isConnectionLost, mcpConfigSchema } from './index.js';
import { redactorFor } from './credentials.js';
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

/** query 值：空白、`/`、`@`。網址裡放百分號編碼，回顯時比對原樣、百分號編碼（大小寫）、form 編碼（`+`）四種。 */
const VALUE = 'tok/en pass@0123456789';

/** 錯誤、cause 鏈、stack 都沒有值的任何形式。 */
function expectNoValue(error: unknown): void {
  const text = everything(error);
  const forms = [
    VALUE,
    encodeURIComponent(VALUE),
    encodeURIComponent(VALUE).toLowerCase(),
    encodeURIComponent(VALUE).replaceAll('%20', '+'),
  ];
  for (const form of forms) expect(text).not.toContain(form);
  expect(text).toContain('[redacted]');
}

async function failedCall(
  start: () => Promise<HttpFixture>,
  query: string,
  body: (request: { method: string; url: string }) => string,
): Promise<unknown> {
  const fixture = await start();
  const config = mcpConfigSchema.parse({
    serverName: 'srv',
    connection: { transport: 'http', url: `${fixture.url}?${query}` },
  });
  const attempts = attemptsOn(config, false, new Map());
  open.push({ fixture, attempts });
  const generation = await attempts.first();
  const call = generation.calls.get(generation.listed.tools[0]?.name ?? '');
  fixture.failRpcMethod('tools/call', body);
  return caught(
    call?.({ topic: 'x' }, { callId: 'call_1', signal: undefined } as never) ?? Promise.resolve(),
  );
}

describe.each(eras)('%s：query 的值各種回顯都遮', (_name, start) => {
  const encoded = encodeURIComponent(VALUE);
  it('只回顯值，沒有 `?`、沒有參數名', async () => {
    expectNoValue(await failedCall(start, `token=${encoded}`, () => `invalid token ${VALUE}`));
  });
  it('server 在前面多加參數、換了順序', async () => {
    expectNoValue(
      await failedCall(
        start,
        `a=1&token=${encoded}&b=2`,
        () => `bad request: b=2&extra=zz&token=${encoded}&a=1`,
      ),
    );
  });
  it('百分號編碼的值解碼後回顯、大小寫不同的編碼、form 編碼', async () => {
    const lower = encoded.toLowerCase();
    expectNoValue(
      await failedCall(
        start,
        `token=${encoded}`,
        () => `${VALUE} | ${lower} | ${encoded.replaceAll('%20', '+')}`,
      ),
    );
  });
  it('JSON 裡把斜線寫成 `\\/` 的回顯', async () => {
    expectNoValue(
      await failedCall(
        start,
        `token=${encoded}`,
        () => `{"error":"${VALUE.replaceAll('/', '\\/')}"}`,
      ),
    );
  });
  it('網址沒有 query：錯誤訊息逐字不變，cause 還是原來的錯誤', async () => {
    const fixture = await start();
    const config = mcpConfigSchema.parse({
      serverName: 'srv',
      connection: { transport: 'http', url: fixture.url },
    });
    const attempts = attemptsOn(config, false, new Map());
    open.push({ fixture, attempts });
    const generation = await attempts.first();
    const call = generation.calls.get(generation.listed.tools[0]?.name ?? '');
    fixture.failRpcMethod('tools/call', true);
    const error = (await caught(
      call?.({ topic: 'x' }, { callId: 'call_1', signal: undefined } as never) ?? Promise.resolve(),
    )) as Error;
    expect(error.message).toBe(
      'Error calling tool fetch_release_note: SdkHttpError: Error POSTing to endpoint: Cannot POST /mcp',
    );
    expect(String(error.cause)).toContain('Cannot POST /mcp');
    expect((error.cause as Error).stack).toBeDefined();
  });
});

describe('短的 query 值不收（`v=2`）', () => {
  const config = mcpConfigSchema.parse({
    serverName: 'srv',
    connection: { transport: 'http', url: 'http://127.0.0.1:9/mcp?v=2&token=abcdefghij' },
  });
  const redactor = withUrlScrubbing(config, redactorFor(config, new Map()));

  it('`MCP error -32000` 還在，斷線判定不壞；長的值照遮', () => {
    const text = redactor.scrubText('MCP error -32000: Connection closed (v=2? token abcdefghij)');
    expect(text).toContain('MCP error -32000: Connection closed');
    expect(text).not.toContain('abcdefghij');
    expect(isConnectionLost(new Error(text))).toBe(true);
  });
});

describe('整段 search 的比對兜底', () => {
  it('query 值太短不收，逐字回顯的 `?k=ab` 仍遮', () => {
    const config = mcpConfigSchema.parse({
      serverName: 'srv',
      connection: { transport: 'http', url: 'http://127.0.0.1:9/mcp?k=ab' },
    });
    const redactor = withUrlScrubbing(config, redactorFor(config, new Map()));
    expect(redactor.scrubText('Cannot POST /mcp?k=ab')).toBe('Cannot POST /mcp[redacted]');
  });
});

describe('遮蔽是冪等的', () => {
  it('沒有 path 的網址：連線失敗的訊息裡 host 後面只有一條斜線', async () => {
    const config = mcpConfigSchema.parse({
      serverName: 'srv',
      connection: { transport: 'http', url: 'http://127.0.0.1:1' },
    });
    const error = await caught(openClient(config, new Map()));
    const text = everything(error);
    expect(text).toContain('http://127.0.0.1:1/');
    expect(text).not.toContain('http://127.0.0.1:1//');
  });

  it.each(['http://h', 'http://h/mcp', 'http://h?x=abcdefghij'])(
    '%s：遮兩次與遮一次相同',
    (url) => {
      const config = mcpConfigSchema.parse({
        serverName: 'srv',
        connection: { transport: 'http', url },
      });
      const redactor = withUrlScrubbing(config, redactorFor(config, new Map()));
      const once = redactor.scrubText(`GET ${url} failed at ${redactedUrl(url)}`);
      expect(redactor.scrubText(once)).toBe(once);
    },
  );
});

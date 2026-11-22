/**
 * HTTP MCP server 交給宿主的那一列（`hostHttpConnection`，#2570 D2b）。共用樣本 `credentials-vectors.json` 的 `httpRow`：
 * Rust 的 `host/tests/mcp_stdio.rs` 把同一份 `ts.row` 交給 `Server::parse`，再比兩邊對同一批 `echoes` 遮出來的字（`expect` 同一個）。
 * 樣本守的是「清單與切法一致」，不是兩個實作完全等價：網址 query 的短值、成功結果與錯誤出口的差別，樣本裡的 `echoes` 都標了 `scope`。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { AUTHORIZATION_HEADER_NAMES, mcpConfigSchema, redactorFor } from '@nexus/plugin-mcp';
import { describe, expect, it } from 'vitest';

import type { ResolvedCredential } from './credentials.js';
import { InvalidCredentialError } from './api-key.js';
import { hostHttpConnection } from './mcp-host-http-row.js';
import type { McpHostHeaderValue } from './mcp-host-http-row.js';

const URL_ = 'http://127.0.0.1:1/mcp';

function fromFile(value: string): ResolvedCredential {
  return { value, source: 'file', path: '/home/FAKE/.credentials.yaml' };
}

describe('hostHttpConnection', () => {
  it('憑證引用：prefix 接上修過的憑證，credentialHeaders 標出 prefix', () => {
    const row = hostHttpConnection({
      url: URL_,
      headers: { Authorization: { credential: 'CRED', prefix: 'Bearer ' }, 'X-Tenant': 'acme' },
      credentials: new Map([['CRED', fromFile('FAKE-token-0001\n')]]),
    });
    expect(row).toEqual({
      transport: 'http',
      url: URL_,
      headers: { Authorization: 'Bearer FAKE-token-0001', 'X-Tenant': 'acme' },
      credentialHeaders: { Authorization: 'Bearer ' },
    });
  });

  it('引用的憑證沒有解析到：拋，訊息有名字', () => {
    expect(() =>
      hostHttpConnection({
        url: URL_,
        headers: { 'X-Key': { credential: 'MISSING' } },
        credentials: new Map(),
      }),
    ).toThrow('MISSING');
  });

  it('憑證值不到 8 個字元：InvalidCredentialError，訊息不含值', () => {
    let error: unknown;
    try {
      hostHttpConnection({
        url: URL_,
        headers: { 'X-Key': { credential: 'K' } },
        credentials: new Map([['K', fromFile('short')]]),
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(InvalidCredentialError);
    expect((error as Error).message).toContain('不到 8 個字元');
    expect((error as Error).message).not.toContain('short');
  });

  it('字串寫的授權 header 含 header 放不下的字元：拒絕，訊息有欄位名、不含值', () => {
    let error: unknown;
    try {
      hostHttpConnection({
        url: URL_,
        headers: { Authorization: 'Bearer FAKE-token-\u0001-0009' },
        credentials: new Map(),
      });
    } catch (caught) {
      error = caught;
    }
    expect((error as Error).message).toContain('connection.headers.Authorization');
    expect((error as Error).message).not.toContain('FAKE-token');
  });

  it('沒有 headers：headers 與 credentialHeaders 都是空的', () => {
    expect(hostHttpConnection({ url: URL_, credentials: new Map() })).toEqual({
      transport: 'http',
      url: URL_,
      headers: {},
      credentialHeaders: {},
    });
  });
});

interface Echo {
  readonly scope: 'result' | 'error';
  readonly text: string;
  readonly expect: string;
}

interface HttpRowVector {
  readonly name: string;
  readonly input: {
    readonly url: string;
    readonly headers: Readonly<Record<string, McpHostHeaderValue>>;
    readonly credentials: Readonly<Record<string, string>>;
  };
  readonly ts: { readonly row: unknown } | { readonly error: string };
  readonly echoes?: readonly Echo[];
}

const DOC = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../native/sandbox-spawner/credentials-vectors.json', import.meta.url),
    ),
    'utf8',
  ),
) as { httpRow: HttpRowVector[]; credentialHeaderNames: string[] };

describe('共用樣本 httpRow（Rust 的 mcp_stdio.rs 跑同一份，把 TS 的輸出交給 Server::parse，再比遮出來的字）', () => {
  it('授權 header 的名單與樣本一致（Rust 的 AUTHORIZATION_HEADERS 對同一行）', () => {
    expect([...AUTHORIZATION_HEADER_NAMES]).toEqual(DOC.credentialHeaderNames);
  });

  it.each(DOC.httpRow.map((v) => [v.name, v] as const))('%s', (_name, vector) => {
    const { input } = vector;
    const run = () =>
      hostHttpConnection({
        url: input.url,
        headers: input.headers,
        credentials: new Map(
          Object.entries(input.credentials).map(([name, value]) => [name, fromFile(value)]),
        ),
      });
    if ('error' in vector.ts) {
      let message = '';
      try {
        run();
      } catch (caught) {
        message = (caught as Error).message;
      }
      expect(message).toContain(vector.ts.error);
      return;
    }
    expect(run()).toEqual(vector.ts.row);
    // TS 外掛自己連線那條路：同一份設定、同一批回顯，遮出來要等於宿主那邊的 `expect`。
    const redactor = redactorFor(
      mcpConfigSchema.parse({
        serverName: 'srv',
        connection: { transport: 'http', url: input.url, headers: input.headers },
      }),
      new Map(Object.entries(input.credentials)),
    );
    for (const echo of vector.echoes ?? []) {
      const got =
        echo.scope === 'error' ? redactor.scrubText(echo.text) : redactor.redactText(echo.text);
      expect(got, `${echo.scope}：${echo.text}`).toBe(echo.expect);
    }
  });
});

/**
 * 錯誤與診斷不帶出憑證值（[#2669](https://github.com/DemianLi/nexus-agent/issues/2669)）。第一組每條斷言原文、`encodeURIComponent` 與
 * form 編碼三種形式都不在，並看得到 `[redacted]`；拿掉遮蔽，這些條都會轉紅。
 */

import { fileURLToPath } from 'node:url';
import { createHostServicesPlugin } from '@nexus/core';
import type { PluginEntry } from '@nexus/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startHttpFixture, startModernHttpEchoingCallErrors } from './http-fixtures.js';
import { redactorFor } from './credentials.js';
import { MCP_CREDENTIALS_SERVICE, mcpConfigSchema } from './index.js';
import type { McpCredentials } from './index.js';
import { loadPlugins, mcpEntry } from './load-with-adapter.js';

const ECHO_ERROR_SERVER = fileURLToPath(new URL('./echo-error-server.ts', import.meta.url));
/** 帶空白與斜線，原文、`encodeURIComponent`、form 編碼三種形式互不相同。 */
const SECRET = 'FAKE tok/en+0123456789';
const ENCODED = encodeURIComponent(SECRET);

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
  vi.unstubAllEnvs();
});

const service: McpCredentials = { resolve: (name) => (name === 'MCP_SECRET' ? SECRET : undefined) };
const host = (): PluginEntry => createHostServicesPlugin({ [MCP_CREDENTIALS_SERVICE]: service });

/** 錯誤與它整串 `cause` 的文字（訊息、名字）。 */
function everythingIn(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current !== undefined && depth < 10; depth++) {
    if (current instanceof Error) {
      parts.push(current.name, current.message);
      current = current.cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join('\n');
}

const expectNoSecret = (text: string): void => {
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain(ENCODED);
  expect(text).not.toContain(ENCODED.replaceAll('%20', '+'));
};

describe('憑證值不外漏（#2669）', () => {
  it('server 把 token 回顯在工具錯誤裡：送出的錯誤文字沒有原文與 URL 編碼', async () => {
    const loaded = await loadPlugins([
      host(),
      mcpEntry({
        serverName: 'srv',
        connection: {
          transport: 'stdio',
          command: process.execPath,
          args: ['--import', 'tsx', ECHO_ERROR_SERVER],
          env: { MCP_TOKEN: { credential: 'MCP_SECRET' } },
        },
        approval: { default: 'allow' },
      }),
    ]);
    cleanup.push(() => loaded.dispose());
    const tool = loaded.registry.tools.resolve('mcp__srv__echo_env_error')?.value;
    if (tool === undefined) throw new Error('沒有註冊 mcp__srv__echo_env_error');
    const thrown = await tool.invoke({ name: 'MCP_TOKEN' }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(thrown, '工具該以錯誤收尾').toBeInstanceOf(Error);
    const text = everythingIn(thrown);
    expect(text).toContain('auth rejected');
    expect(text).toContain('[redacted]');
    expectNoSecret(text);
  }, 30_000);

  it('連線失敗的錯誤帶出 token：伺服器回 JSON-RPC 錯誤並把收到的 Authorization 回顯', async () => {
    vi.stubEnv('NO_PROXY', '127.0.0.1');
    const http = await startHttpFixture(
      (request, response, body) => {
        // 每個請求都回 JSON-RPC 錯誤：訊息帶收到的 Authorization 原值，另加 SECRET 的 URL 編碼，模擬把 token 編碼後回顯的 server。
        const id = (body as { id?: unknown } | undefined)?.id ?? null;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            error: {
              code: -32000,
              message: `rejected ${String(request.headers.authorization)} / ${ENCODED}`,
            },
          }),
        );
        return Promise.resolve();
      },
      () => Promise.resolve(),
    );
    cleanup.push(() => http.close());
    const thrown = await loadPlugins([
      host(),
      mcpEntry({
        serverName: 'srv',
        failOnStartupError: true,
        connection: {
          transport: 'http',
          url: http.url,
          headers: { Authorization: { credential: 'MCP_SECRET', prefix: 'Bearer ' } },
        },
      }),
    ]).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(thrown, '連線失敗該拋').toBeInstanceOf(Error);
    const text = everythingIn(thrown);
    expect(text).toContain('rejected');
    expect(text).toContain('[redacted]');
    expectNoSecret(text);
  }, 30_000);

  it('工具呼叫拋錯：握手與 tools/list 成功，tools/call 的 JSON-RPC 錯誤回顯 Authorization', async () => {
    vi.stubEnv('NO_PROXY', '127.0.0.1');
    const http = await startModernHttpEchoingCallErrors(
      (request) => `rejected ${String(request.headers.authorization)} / ${ENCODED}`,
    );
    cleanup.push(() => http.close());
    const loaded = await loadPlugins([
      host(),
      mcpEntry({
        serverName: 'srv',
        approval: { default: 'allow' },
        connection: {
          transport: 'http',
          url: http.url,
          headers: { Authorization: { credential: 'MCP_SECRET', prefix: 'Bearer ' } },
        },
      }),
    ]);
    cleanup.push(() => loaded.dispose());
    const tool = loaded.registry.tools.resolve('mcp__srv__fetch_release_note')?.value;
    if (tool === undefined) throw new Error('沒有註冊 mcp__srv__fetch_release_note');
    const thrown = await tool.invoke({ topic: 'x' }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(thrown, '工具該以錯誤收尾').toBeInstanceOf(Error);
    const text = everythingIn(thrown);
    expect(text).toContain('rejected');
    expect(text).toContain('[redacted]');
    expectNoSecret(text);
  }, 30_000);

  it('header 的 prefix 帶換行：undici 拒收，錯誤訊息裡的 header 值被遮掉', async () => {
    vi.stubEnv('NO_PROXY', '127.0.0.1');
    const http = await startHttpFixture(
      (_request, response) => {
        response.writeHead(200);
        response.end();
        return Promise.resolve();
      },
      () => Promise.resolve(),
    );
    cleanup.push(() => http.close());
    const thrown = await loadPlugins([
      host(),
      mcpEntry({
        serverName: 'srv',
        failOnStartupError: true,
        connection: {
          transport: 'http',
          url: http.url,
          headers: {
            Authorization: { credential: 'MCP_SECRET', prefix: 'Bearer\nX-Injected: 1\n' },
          },
        },
      }),
    ]).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(thrown, '連線失敗該拋').toBeInstanceOf(Error);
    const text = everythingIn(thrown);
    expect(text).toContain('invalid header value');
    expect(text).toContain('[redacted]');
    expectNoSecret(text);
  }, 30_000);
});

describe('收集：header 代入後的整個值與 Authorization 的 scheme 後面那一段（同 Rust 宿主）', () => {
  const TOKEN = 'xyz-FAKE-token-0001';
  const redactorOf = (
    headers: Record<string, { credential: string; prefix?: string }>,
    value: string,
  ) =>
    redactorFor(
      mcpConfigSchema.parse({
        serverName: 'srv',
        connection: { transport: 'http', url: 'http://127.0.0.1:1/mcp', headers },
      }),
      new Map([['CRED', value]]),
    );

  it('憑證值自己寫成「Bearer xyz」、沒寫 prefix：server 只回顯 xyz 也遮得到', () => {
    const redactor = redactorOf({ Authorization: { credential: 'CRED' } }, `Bearer ${TOKEN}`);
    expect(redactor.scrubText(`echo ${TOKEN}`)).toBe('echo [redacted]');
    expect(redactor.scrubText(`echo Bearer ${TOKEN}`)).toBe('echo [redacted]');
  });

  it('prefix 加憑證：整個值連 prefix 遮成一段，只回顯憑證也遮得到', () => {
    const redactor = redactorOf(
      { Authorization: { credential: 'CRED', prefix: 'Bearer ' } },
      TOKEN,
    );
    expect(redactor.scrubText(`Authorization: Bearer ${TOKEN}`)).toBe('Authorization: [redacted]');
    expect(redactor.scrubText(`echo ${TOKEN}`)).toBe('echo [redacted]');
  });

  it('Proxy-Authorization 與大小寫不分', () => {
    const redactor = redactorOf(
      { 'proxy-AUTHORIZATION': { credential: 'CRED' } },
      `Basic ${TOKEN}`,
    );
    expect(redactor.scrubText(`echo ${TOKEN}`)).toBe('echo [redacted]');
  });

  it('別的 header 不另收 scheme 後面那一段', () => {
    const redactor = redactorOf({ 'X-Api-Key': { credential: 'CRED' } }, `Bearer ${TOKEN}`);
    expect(redactor.scrubText(`echo ${TOKEN}`)).toBe(`echo ${TOKEN}`);
    expect(redactor.scrubText(`echo Bearer ${TOKEN}`)).toBe('echo [redacted]');
  });

  it('沒有憑證引用、網址沒有 query → 沒有東西要遮', () => {
    const redactor = redactorFor(
      mcpConfigSchema.parse({
        serverName: 'srv',
        connection: {
          transport: 'http',
          url: 'http://127.0.0.1:1/mcp',
          headers: { A: 'literal-value-1' },
        },
      }),
      new Map(),
    );
    expect(redactor.empty).toBe(true);
  });
});

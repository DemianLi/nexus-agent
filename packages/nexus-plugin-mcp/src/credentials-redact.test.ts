/**
 * MCP 連線手上的憑證值不能從送回對話行程的文字裡漏出去（[#2669](https://github.com/DemianLi/nexus-agent/issues/2669)）。
 * 三種情況各一條：server 把 token 回顯在工具錯誤裡、連線失敗的錯誤帶出 token、header 的 prefix 帶換行時 undici 的錯誤。
 * 每條都斷言 token 原文與它的 URL 編碼形式都不在送出的文字裡；拿掉遮蔽三條都會轉紅。
 */

import { fileURLToPath } from 'node:url';
import { createHostServicesPlugin } from '@nexus/core';
import type { PluginEntry } from '@nexus/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startHttpFixture } from './http-fixtures.js';
import { MCP_CREDENTIALS_SERVICE } from './index.js';
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
        // 握手的請求回 JSON-RPC 錯誤，訊息回顯收到的 Authorization（原值與 URL 編碼）。
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
    expectNoSecret(text);
  }, 30_000);

  it('header 的 prefix 帶換行：undici 拒收，錯誤沒有整個 header 值', async () => {
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
    expectNoSecret(everythingIn(thrown));
  }, 30_000);
});

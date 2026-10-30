/**
 * 設定裡的憑證引用（[#1989](https://github.com/DemianLi/nexus-agent/issues/1989)）：真的起 stdio 子行程與 HTTP 夾具，量 server 那一側
 * 拿到的值。憑證服務經 `createHostServicesPlugin` 交進去，跟 harness 交的方式一樣；harness 那一側的接線在
 * `apps/harness/src/mcp-credentials-wire.test.ts`。
 */

import { fileURLToPath } from 'node:url';
import { configToJsonSchema, createHostServicesPlugin, loadPlugins } from '@nexus/core';
import type { PluginEntry, PluginRegistry } from '@nexus/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { poolKey } from './pool.js';
import { startModernHttp } from './http-fixtures.js';
import {
  createMcpPlugin,
  CREDENTIAL_REF_PATTERN,
  MCP_CREDENTIALS_SERVICE,
  MCP_POOL_SERVICE,
  McpConnectionPool,
  mcpConfigSchema,
} from './index.js';
import type { McpCredentials, McpPluginOptions } from './index.js';
import { withoutNotice } from './untrusted-fixtures.js';

const FIXTURE_SERVER = fileURLToPath(new URL('./fixture-server.ts', import.meta.url));
const SECRET = 'tok-0123456789-secret';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
  vi.unstubAllEnvs();
});

/** 一列 stdio：`MCP_TOKEN` 引用 `GITHUB_PAT`。 */
function stdioRow(overrides: Partial<McpPluginOptions> = {}): McpPluginOptions {
  return {
    serverName: 'srv',
    connection: {
      transport: 'stdio',
      command: process.execPath,
      args: ['--import', 'tsx', FIXTURE_SERVER],
      env: { MCP_TOKEN: { credential: 'GITHUB_PAT' }, PLAIN: 'plain' },
    },
    approval: { default: 'allow' },
    ...overrides,
  };
}

/** 一份記錄被問了哪些名字的憑證服務。 */
function credentials(values: Record<string, string>) {
  const asked: string[] = [];
  const service: McpCredentials = {
    resolve(name) {
      asked.push(name);
      return values[name];
    },
  };
  return { service, asked };
}

async function load(entries: PluginEntry[]) {
  const loaded = await loadPlugins(entries);
  cleanup.push(() => loaded.dispose());
  return loaded;
}

async function readEnv(registry: PluginRegistry): Promise<Record<string, string | null>> {
  const tool = registry.tools.resolve('mcp__srv__read_env')?.value;
  if (tool === undefined) throw new Error('沒有註冊 mcp__srv__read_env');
  const result = await tool.invoke({ names: ['MCP_TOKEN', 'PLAIN', 'GITHUB_PAT'] });
  return JSON.parse(withoutNotice(String(result))) as Record<string, string | null>;
}

const warned = (registry: PluginRegistry): string[] =>
  registry.logger.warnings().map(({ message }) => message);

describe('stdio 的 env 引用憑證', () => {
  it('子行程拿到代入的值；設定裡只有名字；憑證名本身不進子行程', async () => {
    const { service } = credentials({ GITHUB_PAT: SECRET });
    const { registry } = await load([
      createHostServicesPlugin({ [MCP_CREDENTIALS_SERVICE]: service }),
      createMcpPlugin(stdioRow()),
    ]);
    expect(await readEnv(registry)).toEqual({
      MCP_TOKEN: SECRET,
      PLAIN: 'plain',
      GITHUB_PAT: null,
    });
    expect(JSON.stringify(mcpConfigSchema.parse(stdioRow()))).not.toContain(SECRET);
  }, 30_000);

  it.each([
    ['服務缺席', undefined, '這個入口沒有提供憑證服務'],
    ['名字沒有值', credentials({}).service, '沒有值'],
    [
      '服務拋錯（受管檔權限不對）',
      {
        resolve: () => {
          throw new Error('受管憑證檔 /home/.credentials.yaml 權限是 0644，要 0600');
        },
      },
      '讀不到：受管憑證檔 /home/.credentials.yaml 權限是 0644',
    ],
  ] as const)('%s：這一列連不上、沒有工具，警告寫列、欄位與憑證名', async (_, service, reason) => {
    const { registry } = await load([
      ...(service === undefined
        ? []
        : [createHostServicesPlugin({ [MCP_CREDENTIALS_SERVICE]: service })]),
      createMcpPlugin(stdioRow()),
    ]);
    expect(registry.tools.resolve('mcp__srv__read_env')).toBeUndefined();
    const [warning] = warned(registry);
    expect(warning).toContain('MCP 伺服器 "srv" 套不上沙箱、連不上');
    expect(warning).toContain('connection.env.MCP_TOKEN 引用的憑證 "GITHUB_PAT"');
    expect(warning).toContain(reason);
  });

  it('寫了 failOnStartupError：解析不了就讓那一列失敗', async () => {
    await expect(
      loadPlugins([
        createHostServicesPlugin({ [MCP_CREDENTIALS_SERVICE]: credentials({}).service }),
        createMcpPlugin(stdioRow({ failOnStartupError: true })),
      ]),
    ).rejects.toThrow('引用的憑證 "GITHUB_PAT" 沒有值');
  });

  it('沒有引用的列不碰憑證服務', async () => {
    const { service, asked } = credentials({ GITHUB_PAT: SECRET });
    const { registry } = await load([
      createHostServicesPlugin({ [MCP_CREDENTIALS_SERVICE]: service }),
      createMcpPlugin(
        stdioRow({
          connection: {
            transport: 'stdio',
            command: process.execPath,
            args: ['--import', 'tsx', FIXTURE_SERVER],
            env: { PLAIN: 'plain' },
          },
        }),
      ),
    ]);
    expect((await readEnv(registry))['PLAIN']).toBe('plain');
    expect(asked).toEqual([]);
  }, 30_000);
});

describe('HTTP 的 headers 引用憑證', () => {
  it('prefix 接在代入的值前面', async () => {
    vi.stubEnv('NO_PROXY', '127.0.0.1');
    const http = await startModernHttp();
    cleanup.push(() => http.close());
    const { service } = credentials({ MCP_BEARER: SECRET });
    const { registry } = await load([
      createHostServicesPlugin({ [MCP_CREDENTIALS_SERVICE]: service }),
      createMcpPlugin({
        serverName: 'srv',
        connection: {
          transport: 'http',
          url: http.url,
          headers: { Authorization: { credential: 'MCP_BEARER', prefix: 'Bearer ' } },
        },
      }),
    ]);
    expect(warned(registry)).toEqual([]);
    expect(http.requests.length).toBeGreaterThan(0);
    for (const request of http.requests) expect(request.authorization).toBe(`Bearer ${SECRET}`);
  }, 30_000);
});

describe('池鍵與換值', () => {
  it('池鍵帶名字與指紋、不帶值；值一樣鍵就一樣，值換了鍵就換', () => {
    const config = mcpConfigSchema.parse(stdioRow());
    const key = poolKey(config, false, new Map([['GITHUB_PAT', SECRET]]));
    expect(key).toContain('GITHUB_PAT');
    expect(key).not.toContain(SECRET);
    expect(poolKey(config, false, new Map([['GITHUB_PAT', SECRET]]))).toBe(key);
    expect(poolKey(config, false, new Map([['GITHUB_PAT', `${SECRET}-2`]]))).not.toBe(key);
  });

  it('服務給的值換了：下一份組裝拿到新值，開著的那一份照舊用舊值', async () => {
    const values: Record<string, string> = { GITHUB_PAT: 'first-value' };
    const service: McpCredentials = { resolve: (name) => values[name] };
    const pool = new McpConnectionPool({ log: () => {} });
    cleanup.push(() => pool.close());
    const assemble = () =>
      load([
        createHostServicesPlugin({
          [MCP_POOL_SERVICE]: pool,
          [MCP_CREDENTIALS_SERVICE]: service,
        }),
        createMcpPlugin(stdioRow()),
      ]);
    const first = await assemble();
    values['GITHUB_PAT'] = 'second-value';
    const second = await assemble();
    expect((await readEnv(second.registry))['MCP_TOKEN']).toBe('second-value');
    expect((await readEnv(first.registry))['MCP_TOKEN']).toBe('first-value');
  }, 30_000);
});

describe('mcpConfigSchema 的 JSON Schema', () => {
  it('env 與 headers 是字串或憑證引用的聯集：connection 底下沒有不完整，憑證名的 pattern 照樣輸出', () => {
    const result = configToJsonSchema(mcpConfigSchema);
    expect(result.losses.filter((loss) => loss.path[0] === 'connection')).toEqual([]);
    expect(JSON.stringify(result.schema)).toContain(
      JSON.stringify(CREDENTIAL_REF_PATTERN.source).slice(1, -1),
    );
  });
});

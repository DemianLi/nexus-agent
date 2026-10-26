/**
 * **MCP 設定以憑證名引用受管憑證檔**（[#1989](https://github.com/DemianLi/nexus-agent/issues/1989)）的接線：值從 harness 的憑證服務來，
 * 跟模型 key 同一條規則。plugin 那一側的機制（代入、prefix、池鍵、失敗訊息）在 `packages/nexus-plugin-mcp/src/credentials.test.ts`。
 *
 * | 入口 | 量什麼 | 拿掉哪一處會紅 |
 * | --- | --- | --- |
 * | 組裝根（`createCliAgent`）＋ store 的憑證服務 | 夾具 server 的 `read_env` 讀到受管檔的值 | `assembly-root.ts` 交 `mcp:credentials` 那一格、`connection.ts` 的代入 |
 * | 同上，受管檔 0644、名字不存在 | 那一列沒有工具，警告指名憑證、不帶值 | `credentials.ts` 的權限檢查 |
 * | 同上，帶池、受管值換了 | 下一條 thread 拿到新值，開著的照舊 | `pool.ts` 鍵裡的指紋 |
 * | `runCli`（沒帶 `--live`） | 啟動環境的值到得了子行程；受管檔的值到不了（不讀它） | `cli.ts` 交憑證服務那一格 |
 * | `runCli --dump-config` | 只有憑證名 | — |
 *
 * **零憑證、零外部連線**：值是假的，server 是 stdio 子行程。
 */

import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import type { BaseMessage } from '@langchain/core/messages';
import type { PluginEntry } from '@nexus/core';
import { createMcpPlugin, McpConnectionPool } from '@nexus/plugin-mcp';
import type { McpPluginOptions } from '@nexus/plugin-mcp';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCliAgent } from './assembly-root.js';
import { runCli } from './cli.js';
import { CREDENTIALS_FILE, createCredentialService } from './credentials.js';
import { shippedPlugins, withScriptedModel } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { processLaunchEnv } from './launch-env.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import { scriptedPatchText } from './scripted-serve.js';

const FIXTURE_SERVER = fileURLToPath(
  new URL('../../../packages/nexus-plugin-mcp/src/fixture-server.ts', import.meta.url),
);

/** 兩個假值：前 6 個字元各自獨特，掃日誌時找片段。 */
const FROM_FILE = 'zq7file-managed-0123456789';
const FROM_ENV = 'zq7envr-process-0123456789';
const NAME = 'NEXUS_TEST_MCP_PAT';

const temporary: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-mcp-credentials-'));
  chmodSync(dir, 0o700);
  temporary.push(dir);
  return dir;
}

function managedFile(home: string, value: string, mode = 0o600): void {
  const file = join(home, CREDENTIALS_FILE);
  writeFileSync(file, `version: 1\nrefs:\n  ${NAME}: ${value}\n`, { mode });
  chmodSync(file, mode);
}

/** 一列 stdio MCP：`MCP_TOKEN` 引用 {@link NAME}。夾具只回資料，整台不問。 */
const ROW: McpPluginOptions = {
  serverName: 'srv',
  connection: {
    transport: 'stdio',
    command: process.execPath,
    args: ['--import', 'tsx', FIXTURE_SERVER],
    env: { MCP_TOKEN: { credential: NAME } },
  },
  approval: { default: 'allow' },
};

/** 叫一次 `read_env` 再收尾的腳本。 */
const TURNS: readonly ScriptedTurn[] = [
  { content: '', toolCalls: [{ name: 'mcp__srv__read_env', args: { names: ['MCP_TOKEN'] } }] },
  { content: '好。' },
];

/** 模型收到的最後一則工具結果（`read_env` 的 JSON）。 */
function lastToolResult(prompts: readonly (readonly BaseMessage[])[]): string | undefined {
  return prompts
    .flat()
    .filter((message) => message.getType() === 'tool')
    .map((message) => message.text)
    .at(-1);
}

/** 走組裝根跑一輪，回模型收到的工具結果與這次組裝的警告。 */
async function assembleAndRun(
  home: string,
  session: { readonly mcpPool?: McpConnectionPool } = {},
): Promise<{ result: string | undefined; warnings: string[] }> {
  const credentials = createCredentialService({
    home,
    launchEnv: processLaunchEnv({}),
    store: true,
    warn: () => {},
  });
  const plugins: PluginEntry[] = [
    ...withScriptedModel(await shippedPlugins(), TURNS),
    createMcpPlugin(ROW),
  ];
  const built = await createCliAgent(
    { live: false, credentials },
    plugins,
    home,
    session.mcpPool === undefined ? {} : { mcpPool: session.mcpPool },
  );
  try {
    await built.agent.invoke(toAgentInvocation('看一下'), {
      configurable: { thread_id: 'mcp-credentials' },
    });
    return {
      result: lastToolResult((built.model as ScriptedChatModel).prompts),
      warnings: built.warnings.map(({ message }) => message),
    };
  } finally {
    await built.dispose();
  }
}

describe('組裝根交憑證服務（serve 的規則：受管檔最優先）', () => {
  it('子行程讀到受管檔的值；啟動環境同名也輪不到它', async () => {
    const home = scratch();
    managedFile(home, FROM_FILE);
    vi.stubEnv(NAME, FROM_ENV);
    const { result } = await assembleAndRun(home);
    expect(result).toContain(`"MCP_TOKEN":"${FROM_FILE}"`);
  }, 60_000);

  it.each([
    ['受管檔 0644', 0o644, '讀不到'],
    ['名字不存在', undefined, '沒有值'],
  ] as const)(
    '%s：那一列沒有工具，警告指名憑證、不帶值',
    async (_, mode, reason) => {
      const home = scratch();
      if (mode !== undefined) managedFile(home, FROM_FILE, mode);
      const { result, warnings } = await assembleAndRun(home);
      expect(result).not.toContain(FROM_FILE);
      const warning = warnings.find((line) => line.includes('MCP 伺服器 "srv"'));
      expect(warning).toContain(`connection.env.MCP_TOKEN 引用的憑證 "${NAME}"`);
      expect(warning).toContain(reason);
      for (const line of warnings) expect(line).not.toContain(FROM_FILE.slice(0, 6));
    },
    60_000,
  );

  it('帶池、受管值換了：下一條 thread 拿到新值，開著的那一份照舊', async () => {
    const home = scratch();
    const pool = new McpConnectionPool({ log: () => {} });
    try {
      managedFile(home, FROM_FILE);
      expect((await assembleAndRun(home, { mcpPool: pool })).result).toContain(FROM_FILE);
      // 長度不同：受管檔的重讀看 stat 簽章（含大小），同一個 mtime 粒度裡寫入也看得出換了。
      managedFile(home, `${FROM_FILE}-rotated`);
      expect((await assembleAndRun(home, { mcpPool: pool })).result).toContain(
        `${FROM_FILE}-rotated`,
      );
    } finally {
      await pool.close();
    }
  }, 60_000);
});

/** 一份 patch：腳本模型、一列引用憑證的 MCP。 */
function cliPatch(dir: string): string {
  const patch = join(dir, 'patch.yml');
  const row = JSON.stringify({ ...ROW, connection: { ...ROW.connection } });
  writeFileSync(
    patch,
    scriptedPatchText(
      TURNS,
      `- insert:\n    - id: mcp-srv\n      name: '@nexus/plugin-mcp'\n      config: ${row}\n`,
    ),
  );
  return patch;
}

async function cli(argv: string[], home: string) {
  const printed: string[] = [];
  const errors: string[] = [];
  await runCli({
    argv,
    env: { [HARNESS_HOME_ENV]: home },
    cwd: home,
    input: new PassThrough(),
    output: new PassThrough(),
    printer: { log: (line) => printed.push(line), error: (line) => errors.push(line) },
  });
  return { printed, errors };
}

/** home 底下每一份會話日誌接起來。 */
function sessionLogs(home: string): string {
  const root = join(home, 'sessions');
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), 'utf8'))
    .join('\n');
}

describe('runCli（沒帶 --live）：不讀受管檔，從啟動環境解析', () => {
  it('啟動環境有值：子行程讀到它；受管檔那一份（0644 也一樣）不讀', async () => {
    const home = scratch();
    managedFile(home, FROM_FILE, 0o644);
    vi.stubEnv(NAME, FROM_ENV);
    const { errors } = await cli(['--patch', cliPatch(home), '看一下'], home);
    const logs = sessionLogs(home);
    expect(logs).toContain(`\\"MCP_TOKEN\\":\\"${FROM_ENV}\\"`);
    expect(logs).not.toContain(FROM_FILE);
    for (const line of errors) expect(line).not.toContain(FROM_ENV.slice(0, 6));
  }, 60_000);

  it('只有受管檔有值：那一列連不上，警告指名憑證、不帶值', async () => {
    const home = scratch();
    managedFile(home, FROM_FILE);
    const { errors } = await cli(['--patch', cliPatch(home), '看一下'], home);
    const warning = errors.find((line) => line.includes('MCP 伺服器 "srv"'));
    expect(warning).toContain(`引用的憑證 "${NAME}" 沒有值`);
    expect(sessionLogs(home)).not.toContain(FROM_FILE);
    for (const line of errors) expect(line).not.toContain(FROM_FILE.slice(0, 6));
  }, 60_000);

  it('--dump-config 只印憑證名', async () => {
    const home = scratch();
    managedFile(home, FROM_FILE);
    vi.stubEnv(NAME, FROM_ENV);
    const { printed } = await cli(['--dump-config', '--patch', cliPatch(home)], home);
    const dumped = printed.join('\n');
    expect(dumped).toContain(`credential: ${NAME}`);
    expect(dumped).not.toContain(FROM_FILE.slice(0, 6));
    expect(dumped).not.toContain(FROM_ENV.slice(0, 6));
  }, 60_000);
});

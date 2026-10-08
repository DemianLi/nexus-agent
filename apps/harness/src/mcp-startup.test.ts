/**
 * **MCP 連不上照 dsh 照樣起來**（[#751](https://github.com/DemianLi/nexus-agent/issues/751) 卡上第 7 項），走產品路徑：清單上
 * `insert` 一列 `@nexus/plugin-mcp`，CLI 與 serve 各起一次。
 *
 * 「連得上／連不上」用一支包裝腳本切：旗標檔不在就立刻結束（握不成手），在就啟動真的假伺服器
 * （[`mcp-fixture-server.ts`](./mcp-fixture-server.ts)）。所以同一份清單、同一個行程裡，量得到「伺服器恢復之後」。
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { runCli } from './cli.js';
import { createCliAgent } from './assembly-root.js';
import { foldTurn, serveClient } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { toAgentInvocation } from './messages.js';
import { loadDefaultPlugins } from './plugin-config.js';
import type { ScriptedChatModel } from './scripted-model.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';

const FIXTURE_SERVER = fileURLToPath(new URL('./mcp-fixture-server.ts', import.meta.url));
/** 假伺服器的工具在模型面的名字（`serverName` 是 `late`）。 */
const LATE_TOOL = 'mcp__late__fetch_changelog';

const temporary: string[] = [];
let running: RunningServe | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** 一個私有 home：覆寫檔插一列 MCP，指到那支包裝腳本。回 env 與「讓伺服器恢復」的函式。 */
function homeWithLateServer(extraConfig = ''): { env: NodeJS.ProcessEnv; recover: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'nexus-mcp-startup-'));
  temporary.push(home);
  chmodSync(home, 0o700);
  const flag = join(home, 'up');
  const wrapper = join(home, 'late-server.mjs');
  writeFileSync(
    wrapper,
    [
      "import { existsSync } from 'node:fs';",
      `if (!existsSync(${JSON.stringify(flag)})) process.exit(0);`,
      `await import(${JSON.stringify(pathToFileURL(FIXTURE_SERVER).href)});`,
      '',
    ].join('\n'),
  );
  const patch = join(home, 'cordis.patch.yml');
  writeFileSync(
    patch,
    [
      '- insert:',
      '    - id: mcp-late',
      "      name: '@nexus/plugin-mcp'",
      '      config:',
      '        serverName: late',
      extraConfig,
      '        connection:',
      '          transport: stdio',
      `          command: ${JSON.stringify(process.execPath)}`,
      `          args: ['--import', 'tsx', ${JSON.stringify(wrapper)}]`,
      '',
    ]
      .filter((line) => line !== '')
      .join('\n'),
  );
  chmodSync(patch, 0o600);
  return { env: { [HARNESS_HOME_ENV]: home }, recover: () => writeFileSync(flag, '') };
}

/** CLI 那條組裝綁到的工具：同 `runCli` 的載入、同一支 `createCliAgent`，跑一輪讀假模型記下的。 */
async function boundTools(env: NodeJS.ProcessEnv): Promise<readonly string[]> {
  const { plugins } = await loadDefaultPlugins({ env });
  const built = await createCliAgent({ live: false }, plugins);
  try {
    await built.agent.invoke(toAgentInvocation('說點什麼'), {
      configurable: { thread_id: 'mcp-startup' },
    });
    return (built.model as ScriptedChatModel).boundToolNames;
  } finally {
    await built.dispose();
  }
}

/** 起一台 serve，回伺服器日誌與「開一條對話跑一輪」的函式。 */
async function serveWithLog(env: NodeJS.ProcessEnv) {
  const lines: string[] = [];
  const server = (await runServe({
    argv: ['--port', '0'],
    log: (line) => lines.push(line),
    env,
  })) as RunningServe;
  running = server;
  const client = await serveClient(server);
  const openThread = async (thread: string): Promise<void> => {
    const events = await client.openEvents(thread);
    await client.runStart(thread, '說點什麼');
    await foldTurn(events);
    await events.return?.(undefined);
  };
  return { lines, openThread };
}

const WARNED =
  /^ {2}mcp-late（@nexus\/plugin-mcp）：MCP 伺服器 "late" 連不上、列不出工具或工具註冊不上/u;

describe('MCP 連不上、沒寫 failOnStartupError', () => {
  it('CLI 起得來、警告指名它、沒有那台的工具；對照：伺服器在就有', async () => {
    const { env, recover } = homeWithLateServer();
    const errors: string[] = [];
    await runCli({
      argv: ['說點什麼'],
      env,
      input: new PassThrough(),
      output: new PassThrough(),
      printer: { log: () => undefined, error: (line) => errors.push(line) },
    });
    expect(errors).toEqual([
      expect.stringMatching(/^警告：1 則外掛掛上時交出的話：$/u),
      expect.stringMatching(WARNED),
    ]);
    expect(await boundTools(env)).not.toContain(LATE_TOOL);

    recover();
    expect(await boundTools(env)).toContain(LATE_TOOL);
  }, 60_000);

  /**
   * 卡上的驗收：serve 起得來、啟動時那段警告指名它；**伺服器恢復之後開的下一條對話連得上**。每條對話組裝時都重連，
   * 連不上的那一條在伺服器日誌記一行，連上了就不記——那一行就是這條對話有沒有那台工具的判準（沒有警告＝工具註冊好了，
   * CLI 那條量過工具清單）。
   */
  it('serve 起得來、啟動時警告；伺服器恢復之後開的下一條對話連得上', async () => {
    const { env, recover } = homeWithLateServer();
    const { lines, openThread } = await serveWithLog(env);
    expect(lines.filter((line) => WARNED.test(line))).toHaveLength(1);

    await openThread('a');
    expect(lines.filter((line) => line.startsWith('[組裝] thread "a" 警告：'))).toHaveLength(1);

    recover();
    await openThread('b');
    expect(lines.filter((line) => line.startsWith('[組裝] thread "b"'))).toEqual([]);
  }, 60_000);
});

describe('MCP 掛上之後掉線', () => {
  /**
   * **執行期的話走產品路徑到伺服器日誌**（[#1099](https://github.com/DemianLi/nexus-agent/issues/1099)）：外掛在 `apply` 裡綁好
   * `registry.logger`，組裝之後掉線重連的進度由 serve 接 `exporter` 記成 `[外掛] thread "…"：…`，指名是哪顆外掛。
   */
  it('殺掉 MCP 子行程：伺服器日誌記下掉線與重連，指名外掛與那條對話', async () => {
    const { env, recover } = homeWithLateServer(
      '        reconnect:\n          initialDelayMs: 100\n          maxDelayMs: 200\n          maxAttempts: 5',
    );
    recover();
    const { lines, openThread } = await serveWithLog(env);
    await openThread('a');
    const home = env[HARNESS_HOME_ENV] ?? '';
    const alive = (): number[] => {
      try {
        return execFileSync('pgrep', ['-f', '--', join(home, 'late-server.mjs')])
          .toString()
          .split('\n')
          .filter(Boolean)
          .map(Number);
      } catch {
        return [];
      }
    };
    const first = alive();
    expect(first.length).toBeGreaterThan(0);
    for (const pid of first) process.kill(pid, 'SIGKILL');
    const heard = (needle: string) =>
      lines.some(
        (line) =>
          line.startsWith('[外掛] thread "a"：mcp-late（@nexus/plugin-mcp）：') &&
          line.includes(needle),
      );
    const start = Date.now();
    while (!(heard('connection lost; reconnecting') && heard('reconnected (attempt 1/5)'))) {
      if (Date.now() - start > 20_000) throw new Error(`等太久了：${lines.join('\n')}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }, 60_000);
});

describe('MCP 連不上、寫了 failOnStartupError: true', () => {
  /**
   * 那一列在啟動時那次試組掉了，照 #751 帶進每條對話：**之後的對話不再重試**，要到重啟才有——伺服器恢復了也一樣。
   *
   * **量法刻意讓伺服器一直連不上**：真的重試的話那條對話的組裝會再失敗一次、伺服器日誌記一行「這一條沒掛上」；
   * 一行都沒有，就是沒重試。伺服器先恢復再開對話的話，重試會成功而且一樣不記，量不出差別。對照是上面那條——沒寫
   * `failOnStartupError` 時每條對話都重連、連不上就記一行。
   */
  it('那一列掉了、起得來、警告指名它；之後的對話不再重試', async () => {
    const { env } = homeWithLateServer('        failOnStartupError: true');
    const { lines, openThread } = await serveWithLog(env);
    expect(lines).toContain('警告：1 列沒有掛上，其餘照樣起來：');
    expect(
      lines.filter((line) => /^ {2}mcp-late（@nexus\/plugin-mcp）掛上時失敗：/u.test(line)),
    ).toHaveLength(1);

    await openThread('a');
    expect(lines.filter((line) => line.startsWith('[組裝]'))).toEqual([]);
  }, 60_000);
});

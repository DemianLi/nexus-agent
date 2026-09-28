/**
 * 啟動時的必掛名單（#751）：哪幾列掉了要整個起不來，其餘印一段警告、照樣起來。
 *
 * 兩個入口各起一次，量的是產品路徑（`runCli`、`runServe`），不是只量 {@link auditStartupEntries}：
 * 漏接一邊不會有型別錯誤。
 */

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { loadPlugins } from '@nexus/core';
import type { PluginEntry } from '@nexus/core';
import { afterEach, describe, expect, it } from 'vitest';

import { AssemblyDropError } from './agent-factory.js';
import type { AssemblyDrop } from './agent-factory.js';
import { BROWSER_SESSION_SECRET_FILE } from './browser-session-secret.js';
import { runCli } from './cli.js';
import { foldTurn, serveClient } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { loadDefaultPlugins } from './plugin-config.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';
import {
  auditStartupEntries,
  optionalEntriesOf,
  REQUIRED_ENTRY_IDS,
  startupErrorFrom,
  StartupError,
  startupWarning,
} from './startup-audit.js';

const temporary: string[] = [];
let running: RunningServe | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** 一個私有的 harness home，覆寫檔寫進去。 */
function homeWith(patch: string): NodeJS.ProcessEnv {
  const home = mkdtempSync(join(tmpdir(), 'nexus-startup-audit-'));
  temporary.push(home);
  chmodSync(home, 0o700);
  const path = join(home, 'cordis.patch.yml');
  writeFileSync(path, patch);
  chmodSync(path, 0o600);
  return { [HARNESS_HOME_ENV]: home };
}

/** CLI 起一次：回它拋的錯，或它印到標準錯誤的每一行。 */
async function cli(env: NodeJS.ProcessEnv): Promise<{ error?: unknown; errors: string[] }> {
  const errors: string[] = [];
  try {
    await runCli({
      argv: ['說點什麼'],
      env,
      input: new PassThrough(),
      output: new PassThrough(),
      printer: { log: () => undefined, error: (line) => errors.push(line) },
    });
    return { errors };
  } catch (error) {
    return { error, errors };
  }
}

const BAD_BROWSER_SESSION = '- id: browser-session\n  config:\n    maxAgeDays: 0\n';
const BAD_TODO = "- id: todo\n  config:\n    allowParallelInProgress: '不是布林'\n";

describe('必掛的列掉了：兩個入口都起不來', () => {
  it('名單上只有 browser-session，而且比的是條目 id', () => {
    expect([...REQUIRED_ENTRY_IDS]).toEqual(['browser-session']);
  });

  /**
   * 卡上的驗收：`browser-session` 寫壞，兩個入口都起不來、訊息指名它；同時再弄壞 `todo`，訊息把 `todo` 也一起列
   * （照 dsh 的 `StartupError`）。serve 那一次還沒建瀏覽器會話密鑰。
   */
  it('browser-session 寫壞、todo 也壞：CLI 與 serve 都拋同一則，兩列都列、必掛的標出來，密鑰檔沒建', async () => {
    const env = homeWith(BAD_BROWSER_SESSION + BAD_TODO);

    const fromCli = await cli(env);
    expect(fromCli.error).toBeInstanceOf(StartupError);
    const message = (fromCli.error as Error).message;
    expect(message).toMatch(/^起不來：1 列必掛的沒有掛上。/u);
    expect(message).toMatch(
      /^ {2}browser-session（#settings\/browser-session）〔必掛〕設定驗不過：/mu,
    );
    expect(message).toMatch(/^ {2}todo（@nexus\/plugin-todo）設定驗不過：/mu);
    // 起不來的那一次不另外印警告：全部都在拋出去的那一則裡。
    expect(fromCli.errors).toEqual([]);

    await expect(runServe({ argv: ['--port', '0'], log: () => undefined, env })).rejects.toThrow(
      message,
    );
    expect(existsSync(join(env[HARNESS_HOME_ENV] ?? '', BROWSER_SESSION_SECRET_FILE))).toBe(false);
  });

  it('對照：只有 todo 壞，兩個入口都起得來', async () => {
    const env = homeWith(BAD_TODO);
    expect((await cli(env)).error).toBeUndefined();
    running = await runServe({ argv: ['--port', '0'], log: () => undefined, env });
  });
});

describe('掉了的列算沒掛', () => {
  /**
   * 卡上的驗收：`summarization` 設定寫壞，組出來的跟寫 `disabled: true` 的那份一樣。量的是載入器記下的「沒掛上」
   * ——折疊那側六處讀的就是它（`disabledEntries`），摘要因此是同名空殼、不是回到內建預設。
   */
  it('summarization 設定寫壞：跟寫 disabled: true 的那份一樣記成沒掛', async () => {
    const mountedOff = async (patch: string): Promise<readonly string[]> => {
      const { plugins } = await loadDefaultPlugins({ env: homeWith(patch) });
      const { registry, dispose } = await loadPlugins(plugins);
      await dispose();
      return registry.disabledEntries.names();
    };
    const broken = await mountedOff('- id: summarization\n  config:\n    tokens: -1\n');
    expect(broken).toContain('summarization');
    expect(broken).toEqual(await mountedOff('- id: summarization\n  disabled: true\n'));
  });
});

describe('沒有設定格式卻寫了 config：照樣掛，警告講那份設定沒有作用', () => {
  const EXTRA = '- id: observation-policy\n  config:\n    anything: 1\n';
  const LINE = '  observation-policy（@nexus/core/observation-policy）';

  it('CLI 與 serve 都起得來，同一段警告指名它；那一列照樣掛著（先讀後改照樣在）', async () => {
    const env = homeWith(EXTRA);
    const fromCli = await cli(env);
    expect(fromCli.error).toBeUndefined();
    expect(fromCli.errors).toEqual([
      '警告：1 列寫的 config 沒有作用——那顆 plugin 沒有設定格式，那一列照樣掛：',
      LINE,
    ]);

    const logged: string[] = [];
    running = await runServe({ argv: ['--port', '0'], log: (line) => logged.push(line), env });
    expect(logged).toContain(LINE);

    const { plugins } = await loadDefaultPlugins({ env });
    const { registry, dispose } = await loadPlugins(plugins);
    await dispose();
    expect(registry.disabledEntries.has('observation-policy')).toBe(false);
  });
});

describe('判定的幾支函式', () => {
  const drop = (id: string) =>
    ({ id, module: `#settings/${id}`, stage: 'config', message: `${id} 壞了` }) as const;
  const entry = (name: string): PluginEntry => ({ plugin: { name, apply: () => undefined } });

  it('沒有要講的：空陣列', () => {
    expect(startupWarning({ dropped: [], ignoredConfig: [] }, [])).toEqual([]);
  });

  it('live-model 掉了：沒帶 --live 只是警告，帶了就起不來', () => {
    const loaded = { dropped: [drop('live-model')], ignoredConfig: [] };
    expect(() => auditStartupEntries(loaded, { live: false })).not.toThrow();
    expect(startupWarning(loaded, [])[0]).toBe('警告：1 列沒有掛上，其餘照樣起來：');
    expect(() => auditStartupEntries(loaded, { live: true })).toThrow(StartupError);
  });

  /** 只有清單交出來的列照名單判：必掛的不在，組裝點的外掛本來就不在 `rows` 裡。 */
  it('可少掛的條目：清單上不在必掛名單的列；帶 --live 時 live-model 也不在', () => {
    const [todo, browser, live] = [entry('todo'), entry('browser-session'), entry('live-model')];
    const rows = new Map([
      [todo, { id: 'todo', module: '@nexus/plugin-todo' }],
      [browser, { id: 'browser-session', module: '#settings/browser-session' }],
      [live, { id: 'live-model', module: '#settings/live-model' }],
    ]);
    expect([...optionalEntriesOf({ rows }, { live: false })]).toEqual([todo, live]);
    expect([...optionalEntriesOf({ rows }, { live: true })]).toEqual([todo]);
  });

  /** 組裝時不能少掛的掉了：兩次掉的一起列，不能少掛的標出來，組裝點的外掛沒有模組名、寫「組裝點」。 */
  it('組裝的錯換成 StartupError：兩次掉的一起列，組裝點的外掛標必掛', () => {
    const [todo, host] = [entry('todo'), entry('host-services')];
    const dropped: AssemblyDrop[] = [
      {
        entry: host,
        drop: {
          origin: { id: 'host-services', name: 'host-services' },
          stage: 'apply',
          message: 'host 壞了',
          cause: undefined,
        },
      },
      {
        entry: todo,
        drop: {
          origin: { id: 'todo', name: 'todo' },
          stage: 'requires',
          message: 'todo 缺件',
          cause: undefined,
        },
      },
    ];
    const error = startupErrorFrom(
      {
        dropped: [drop('summarization')],
        rows: new Map([[todo, { id: 'todo', module: '@nexus/plugin-todo' }]]),
      },
      new AssemblyDropError(dropped, new Set([host])),
      { live: false },
    );
    expect(error.message.split('\n')).toEqual([
      '起不來：1 列必掛的沒有掛上。這一次掉了的全部：',
      '  summarization（#settings/summarization）設定驗不過：summarization 壞了',
      '  host-services（組裝點）〔必掛〕掛上時失敗：host 壞了',
      '  todo（@nexus/plugin-todo）要用的服務沒人提供：todo 缺件',
    ]);
    expect(error.dropped).toHaveLength(3);
  });
});

/**
 * **serve 試組時掉了的列帶進每條對話**（卡上第 6 項）：啟動時判一次，之後每條對話組裝時那幾列直接算沒掛——不再重試、
 * 不再每條各印一次。量的是那一列的 `apply` 真的跑了幾次：模組每跑一次 `apply` 就往見證檔寫一行。
 */
describe('serve：組裝時掉了的列', () => {
  /** home 裡一顆 `insert` 進來的模組：每次 `apply` 記一行，第 `failFrom` 次起拋錯。 */
  function homeWithCountingModule(failFrom: number): { env: NodeJS.ProcessEnv; witness: string } {
    const env = homeWith('');
    const home = env[HARNESS_HOME_ENV] ?? '';
    const witness = join(home, 'applied');
    const module = join(home, 'counted.ts');
    writeFileSync(
      module,
      [
        "import { appendFileSync, existsSync, readFileSync } from 'node:fs';",
        `const witness = ${JSON.stringify(witness)};`,
        'export default {',
        "  name: 'counted',",
        '  apply() {',
        "    const seen = existsSync(witness) ? readFileSync(witness, 'utf8').length : 0;",
        "    appendFileSync(witness, 'x');",
        `    if (seen + 1 >= ${String(failFrom)}) throw new Error('故意在 apply 裡壞掉');`,
        '  },',
        '};',
        '',
      ].join('\n'),
    );
    chmodSync(module, 0o600);
    const patch = join(home, 'cordis.patch.yml');
    writeFileSync(patch, "- insert:\n    - id: counted\n      name: './counted.ts'\n");
    chmodSync(patch, 0o600);
    return { env, witness };
  }

  /** 起一台 serve、開兩條對話各跑一輪，回伺服器日誌。 */
  async function serveTwoThreads(env: NodeJS.ProcessEnv): Promise<string[]> {
    const lines: string[] = [];
    const server = (await runServe({
      argv: ['--port', '0'],
      log: (line) => lines.push(line),
      env,
    })) as RunningServe;
    running = server;
    const client = await serveClient(server);
    for (const thread of ['a', 'b']) {
      const events = await client.openEvents(thread);
      await client.runStart(thread, '說點什麼');
      await foldTurn(events);
      await events.return?.(undefined);
    }
    return lines;
  }

  const COUNTED = /^ {2}counted（file:[^）]+\/counted\.ts）掛上時失敗：.*故意在 apply 裡壞掉/u;

  it('試組時 `apply` 拋錯：起得來、警告只印一次，之後兩條對話都不再跑它的 `apply`', async () => {
    const { env, witness } = homeWithCountingModule(1);
    const lines = await serveTwoThreads(env);
    expect(lines.filter((line) => COUNTED.test(line))).toHaveLength(1);
    expect(lines).toContain('警告：1 列沒有掛上，其餘照樣起來：');
    expect(lines.filter((line) => line.startsWith('[組裝]'))).toEqual([]);
    expect(readFileSync(witness, 'utf8')).toBe('x');
    const listed = lines.find((line) => line.startsWith('plugin：'));
    expect(listed).not.toMatch(/[：、]counted(、|$)/u);
  });

  /**
   * **啟動時沒掉、某一條對話組裝時才掉的列**：同一套規則只作用在那一條——那條對話照樣建得起來、伺服器日誌記一筆。
   * 對照組是上一條：試組就掉的列，對話組裝時一筆都不記。
   */
  it('試組時沒掉、對話組裝時才掉：那一條照樣建得起來，伺服器日誌逐條記一筆', async () => {
    const { env, witness } = homeWithCountingModule(2);
    const lines = await serveTwoThreads(env);
    expect(lines.filter((line) => line.startsWith('警告：'))).toEqual([]);
    const perThread = lines.filter((line) => line.startsWith('[組裝]'));
    expect(perThread).toHaveLength(2);
    expect(perThread[0]).toMatch(
      /^\[組裝\] thread "a" 這一條沒掛上：counted（file:[^）]+\/counted\.ts）掛上時失敗：/u,
    );
    expect(readFileSync(witness, 'utf8')).toBe('xxx');
  });
});

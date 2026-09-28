/**
 * 啟動時的必掛名單（#751）：哪幾列掉了要整個起不來，其餘印一段警告、照樣起來。
 *
 * 兩個入口各起一次，量的是產品路徑（`runCli`、`runServe`），不是只量 {@link auditStartupEntries}：
 * 漏接一邊不會有型別錯誤。
 */

import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { loadPlugins } from '@nexus/core';
import { afterEach, describe, expect, it } from 'vitest';

import { BROWSER_SESSION_SECRET_FILE } from './browser-session-secret.js';
import { runCli } from './cli.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { loadDefaultPlugins } from './plugin-config.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';
import { auditStartupEntries, REQUIRED_ENTRY_IDS, StartupError } from './startup-audit.js';

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

describe('auditStartupEntries', () => {
  const drop = (id: string) =>
    ({ id, module: `#settings/${id}`, stage: 'config', message: `${id} 壞了` }) as const;

  it('沒有要講的：空陣列', () => {
    expect(auditStartupEntries({ dropped: [], ignoredConfig: [] }, { live: false })).toEqual([]);
  });

  it('live-model 掉了：沒帶 --live 只是警告，帶了就起不來', () => {
    const loaded = { dropped: [drop('live-model')], ignoredConfig: [] };
    expect(auditStartupEntries(loaded, { live: false })[0]).toBe(
      '警告：1 列沒有掛上，其餘照樣起來：',
    );
    expect(() => auditStartupEntries(loaded, { live: true })).toThrow(StartupError);
  });
});

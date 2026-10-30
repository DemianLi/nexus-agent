/**
 * 主機端寫入口的命令列（[#1412](https://github.com/DemianLi/nexus-agent/issues/1412)）：加 4–7，驗收表 D 的非零結束；
 * [#1414](https://github.com/DemianLi/nexus-agent/issues/1414) 的驗收 A（告訴人記了哪一筆）與 B。
 */

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { HARNESS_HOME_ENV } from './harness-home.js';
import { journalPathOf, seedHomePatch } from './plugin-journal.fixture.js';
import { readJournal } from './plugin-journal.js';
import { runPluginCli } from './plugin-cli.js';

const temporary: string[] = [];

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function home(): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-plugin-cli-'));
  chmodSync(dir, 0o700);
  temporary.push(dir);
  return { dir, env: { [HARNESS_HOME_ENV]: dir, SUDO_USER: 'alice' } };
}

async function run(
  argv: string[],
  env: NodeJS.ProcessEnv,
  stdin?: string,
): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runPluginCli({
    argv,
    env,
    ...(stdin !== undefined && { stdin: () => stdin }),
    printer: { log: (line) => out.push(line), error: (line) => err.push(line) },
  });
  return { code, out, err };
}

describe('輸出', () => {
  it('停用：印紀錄檔的完整路徑、序號、操作者（sudo 前的標自報）、改了哪些欄位、什麼時候生效', async () => {
    const { dir, env } = home();
    const { code, out } = await run(['disable', 'todo'], env);
    expect(code).toBe(0);
    const text = out.join('\n');
    expect(text).toContain(journalPathOf(dir));
    expect(text).toContain('第 1 筆');
    expect(text).toContain('disable');
    expect(text).toContain('sudo 前自報為 alice');
    expect(text).toContain('不是身分認證');
    expect(text).toContain('改了：disabled');
    expect(text).toContain('新對話生效');
  });

  it('起動期讀的列：回報待重啟', async () => {
    const { env } = home();
    const secret = 'secret-9f3a1c';
    const { code, out, err } = await run(
      ['config', 'set', 'thread-title', '--file', '-'],
      env,
      `maxWords: 3\nmaxBytes: 40\n`,
    );
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('待重啟');
    expect(out.join('\n')).toContain('改了：maxTitleBytes、maxWords');
    expect([...out, ...err].join('\n')).not.toContain(secret);
  });

  it('沒有 plugin-snapshot.json：警告但不擋，結束碼 0', async () => {
    const { env } = home();
    const { code, err } = await run(['enable', 'todo'], env);
    expect(code).toBe(0);
    expect(err.join('\n')).toContain('plugin-snapshot.json');
  });
});

describe('命令參數不收設定值（加 6）', () => {
  it('多給的位置參數：拒絕、不寫、用法錯的結束碼 2', async () => {
    const { dir, env } = home();
    const { code, err } = await run(['config', 'set', 'todo', '{"a":1}'], env);
    expect(code).toBe(2);
    expect(err.join('\n')).toContain('不收');
    expect(() => readFileSync(journalPathOf(dir))).toThrow();
  });

  it('--config／--value 這種把值放在命令列上的旗標：不認得', async () => {
    const { env } = home();
    for (const flag of ['--config', '--value', '--set']) {
      const { code, err } = await run(['config', 'set', 'todo', flag, '{"a":1}'], env);
      expect(code).toBe(2);
      expect(err.join('\n')).toContain('命令參數不收設定值');
    }
  });

  it('config set 沒給 --file：拒絕', async () => {
    const { env } = home();
    const { code } = await run(['config', 'set', 'todo'], env);
    expect(code).toBe(2);
  });

  it('--file 給檔案路徑：照樣讀得到；不是一張表的拒絕', async () => {
    const { dir, env } = home();
    const file = join(dir, 'new-config.yml');
    writeFileSync(file, '{"allowParallelInProgress": false}\n');
    expect((await run(['config', 'set', 'todo', '--file', file], env)).code).toBe(0);
    expect((await run(['config', 'set', 'todo', '--file', '-'], env, '- 1\n- 2\n')).code).toBe(2);
    expect((await run(['config', 'set', 'todo', '--file', join(dir, 'nope.yml')], env)).code).toBe(
      2,
    );
  });
});

describe('輸出與紀錄日誌不印設定值（加 7）', () => {
  it('成功與拒絕的輸出都沒有那份設定的值，只有欄位名', async () => {
    const { env } = home();
    const secret = 'sk-live-0123456789abcdef';
    const set = await run(
      ['config', 'set', 'live-model', '--file', '-'],
      env,
      `baseUrl: https://${secret}.example.invalid/v1\n`,
    );
    expect(set.code).toBe(0);
    expect([...set.out, ...set.err].join('\n')).not.toContain(secret);
    expect(set.out.join('\n')).toContain('baseUrl');

    const bad = await run(
      ['config', 'set', 'todo', '--file', '-'],
      env,
      `allowParallelInProgress: ${secret}\n`,
    );
    expect(bad.code).toBe(1);
    expect([...bad.out, ...bad.err].join('\n')).not.toContain(secret);
  });
});

describe('--workspace（#2073）', () => {
  it('帶到寫入前的試掛：要它才起得來的列，沒帶拒收、帶了照收；空字串是用法錯', async () => {
    const { dir, env } = home();
    writeFileSync(
      join(dir, 'ws-probe.ts'),
      "export default { name: 'ws-probe', apply(registry) { if (registry.services.get('workspaceRoot') === undefined) throw new Error('要 --workspace'); } };\n",
      { mode: 0o600 },
    );
    seedHomePatch(
      dir,
      "- insert:\n    - id: ws-probe\n      name: './ws-probe.ts'\n      config:\n        n: 1\n",
    );
    const config = JSON.stringify({ n: 2 });
    const without = await run(['config', 'set', 'ws-probe', '--file', '-'], env, config);
    expect(without.code).not.toBe(0);
    expect(without.err.join('\n')).toContain('要 --workspace');

    const workspace = mkdtempSync(join(tmpdir(), 'nexus-plugin-cli-ws-'));
    temporary.push(workspace);
    const withFlag = await run(
      ['config', 'set', 'ws-probe', '--file', '-', '--workspace', workspace],
      env,
      config,
    );
    expect(withFlag.code).toBe(0);

    expect((await run(['disable', 'todo', '--workspace', ''], env)).code).toBe(2);
  });
});

describe('驗不過', () => {
  it('不存在的 id、必掛的列：非零結束、訊息指名原因，告訴人紀錄多了哪一筆 rejected（#1414）', async () => {
    const { dir, env } = home();
    await run(['disable', 'skills'], env);
    const ids = ['no-such-row', 'browser-session', 'approval-gate'];
    for (const [index, id] of ids.entries()) {
      const { code, err } = await run(['disable', id], env);
      expect(code).toBe(1);
      const text = err.join('\n');
      expect(text).toContain('拒絕');
      expect(text).toContain(`第 ${String(index + 2)} 筆 rejected`);
      expect(text).not.toContain('紀錄沒有動');
    }
    const records = readJournal(journalPathOf(dir))?.records ?? [];
    expect(records.map((entry) => entry.op)).toEqual([
      'disable',
      'rejected',
      'rejected',
      'rejected',
    ]);
  });

  it('還沒形成一筆變更的錯（參數、--file 讀不到、不是一張表）與沒有改變任何東西：紀錄逐位元組不變（#1414 驗收 B）', async () => {
    const { dir, env } = home();
    await run(['disable', 'skills'], env);
    const before = readFileSync(journalPathOf(dir));
    expect((await run(['disable'], env)).code).toBe(2);
    expect((await run(['frobnicate'], env)).code).toBe(2);
    expect((await run(['config', 'set', 'todo'], env)).code).toBe(2);
    expect((await run(['config', 'set', 'todo', '--file', join(dir, 'nope.yml')], env)).code).toBe(
      2,
    );
    expect((await run(['config', 'set', 'todo', '--file', '-'], env, '- 1\n- 2\n')).code).toBe(2);
    const noop = await run(['disable', 'skills'], env);
    expect(noop.code).toBe(0);
    expect(noop.out.join('\n')).toContain('沒有寫入');
    expect(readFileSync(journalPathOf(dir)).equals(before)).toBe(true);
  });

  it('--help 與不認得的命令', async () => {
    const { env } = home();
    expect((await run(['--help'], env)).code).toBe(0);
    expect((await run(['frobnicate'], env)).code).toBe(2);
  });
});

describe('--patch 與工作區（#2162）', () => {
  it('在工作區裡：不寫紀錄，也不試掛', async () => {
    const { dir, env } = home();
    const workspace = mkdtempSync(join(tmpdir(), 'nexus-2162-ws-'));
    temporary.push(workspace);
    const patch = join(workspace, 'p.yml');
    writeFileSync(patch, '[]\n');
    const { code, err } = await run(
      ['disable', 'todo', '--workspace', workspace, '--patch', patch],
      env,
    );
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('不能在 --workspace 底下');
    expect(existsSync(join(dir, 'plugin-journal.jsonl'))).toBe(false);
  });
});

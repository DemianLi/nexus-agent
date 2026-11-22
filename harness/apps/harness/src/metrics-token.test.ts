/**
 * 指標 token 檔（[#1535](https://github.com/DemianLi/nexus-agent/issues/1535) 驗收 5）：沒有就建（目錄 `0700`、檔 `0600`、內容是裸 token 加換行），
 * 權限過寬或內容認不得就拒絕、不覆寫，兩個行程同時第一次建立拿到同一個。
 */

import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadOrCreateMetricsToken, METRICS_TOKEN_FILE } from './metrics-token.js';

const dirs: string[] = [];

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'nexus-metrics-token-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('loadOrCreateMetricsToken', () => {
  it('沒有就建：上層目錄 0700、檔 0600、內容是 43 字元的 base64url 加一個換行（監控那一側原樣讀得了）', async () => {
    const base = await scratch();
    const file = join(base, 'home', METRICS_TOKEN_FILE);
    const token = await loadOrCreateMetricsToken(file);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(await readFile(file, 'utf8')).toBe(`${token}\n`);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(base, 'home'))).mode & 0o777).toBe(0o700);
    // 目錄裡沒有留下暫存檔。
    expect(await readdir(join(base, 'home'))).toEqual([METRICS_TOKEN_FILE]);
  });

  it('已經有就讀它，不重建；兩次拿到同一個', async () => {
    const base = await scratch();
    const file = join(base, METRICS_TOKEN_FILE);
    const first = await loadOrCreateMetricsToken(file);
    expect(await loadOrCreateMetricsToken(file)).toBe(first);
  });

  it('手寫的檔：前後空白可有，格式對就收', async () => {
    const base = await scratch();
    const file = join(base, METRICS_TOKEN_FILE);
    const token = 'a'.repeat(43);
    await writeFile(file, `  ${token}\r\n`, { mode: 0o600 });
    expect(await loadOrCreateMetricsToken(file)).toBe(token);
  });

  it('權限是 0644 → 拒絕，訊息指名檔案與 chmod 600，檔案原封不動', async () => {
    const base = await scratch();
    const file = join(base, METRICS_TOKEN_FILE);
    const token = 'b'.repeat(43);
    await writeFile(file, `${token}\n`);
    await chmod(file, 0o644);
    const failure = await loadOrCreateMetricsToken(file).then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    expect(failure?.message).toContain(file);
    expect(failure?.message).toContain('chmod 600');
    expect(await readFile(file, 'utf8')).toBe(`${token}\n`);
  });

  it('只要 group 或 other 有任何一個位元（0640、0604）都拒絕', async () => {
    const base = await scratch();
    for (const mode of [0o640, 0o604, 0o660]) {
      const file = join(base, `t-${mode.toString(8)}`);
      await writeFile(file, `${'c'.repeat(43)}\n`);
      await chmod(file, mode);
      await expect(loadOrCreateMetricsToken(file)).rejects.toThrow(/其他使用者讀得到/u);
    }
  });

  it('內容認不得（空檔、長度不對、JSON）→ 拒絕、不覆寫', async () => {
    const base = await scratch();
    for (const [name, content] of [
      ['empty', ''],
      ['short', 'abc\n'],
      ['json', '{"version":1,"secret":"x"}\n'],
      ['bad-char', `${'d'.repeat(42)}!\n`],
    ] as const) {
      const file = join(base, name);
      await writeFile(file, content, { mode: 0o600 });
      await expect(loadOrCreateMetricsToken(file)).rejects.toThrow(/不合格/u);
      expect(await readFile(file, 'utf8')).toBe(content);
    }
  });

  it('同時第一次建立：先寫的贏，每個呼叫拿到同一個', async () => {
    const base = await scratch();
    await mkdir(join(base, 'home'), { mode: 0o700 });
    const file = join(base, 'home', METRICS_TOKEN_FILE);
    const tokens = await Promise.all(
      Array.from({ length: 8 }, () => loadOrCreateMetricsToken(file)),
    );
    expect(new Set(tokens).size).toBe(1);
    expect(await readFile(file, 'utf8')).toBe(`${tokens[0]!}\n`);
  });
});

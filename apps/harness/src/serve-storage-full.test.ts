/**
 * 磁碟滿的探針，**從 `runServe` 起量**（[#2195](https://github.com/DemianLi/nexus-agent/issues/2195)）。
 *
 * `storage-probe.test.ts` 與 `ops-endpoints.test.ts` 量零件；這一檔量接線：`serve.ts` 列了哪些路徑、
 * 探針有沒有接上 `/readyz` 與 `/metrics`。測試機的磁碟滿不了，所以只換 `statfs`。
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { bodyLog } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { METRICS_TOKEN_FILE } from './metrics-token.js';
import { resolveThreadRootsBase } from './thread-roots.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';

const fullPath = vi.hoisted(() => ({ value: undefined as string | undefined }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    statfs: async (path: string) => ({
      blocks: 100,
      bavail: path === fullPath.value ? 0 : 50,
      files: 100,
      ffree: 50,
    }),
  };
});

const temporary: string[] = [];
let running: RunningServe | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
  fullPath.value = undefined;
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 起一台 serve；`full` 從 home 與測試的暫存目錄指出哪條路徑滿了。 */
async function start(
  full: (where: { home: string; base: string }) => string | undefined = () => undefined,
  extraArgs: (base: string) => string[] = () => [],
) {
  const base = mkdtempSync(join(tmpdir(), 'nexus-storage-'));
  chmodSync(base, 0o700);
  temporary.push(base);
  const home = join(base, 'home');
  const cwd = join(base, 'project');
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(cwd);
  const patch = join(base, 'patch.yml');
  writeFileSync(
    patch,
    ['- id: ops-endpoints', '  config:', '    metrics:', '      enabled: true', ''].join('\n'),
  );
  fullPath.value = full({ home, base });
  running = (await runServe({
    argv: ['--port', '0', '--patch', patch, ...extraArgs(base)],
    log: bodyLog([]),
    env: { [HARNESS_HOME_ENV]: home },
    cwd,
  })) as RunningServe;
  const token = (await readFile(join(home, METRICS_TOKEN_FILE), 'utf8')).trim();
  return { server: running, token };
}

async function fullGauges(server: RunningServe, token: string): Promise<Record<string, number>> {
  const response = await fetch(`${server.url}/metrics`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const gauges: Record<string, number> = {};
  for (const line of (await response.text()).split('\n')) {
    const match = /^nexus_storage_full\{area="([^"]+)"\} (\d+)$/.exec(line);
    if (match !== null) gauges[match[1] as string] = Number(match[2]);
  }
  return gauges;
}

describe('serve 的磁碟滿探針（#2195）', () => {
  it('空間夠：/readyz 200，兩區的指標都是 0', async () => {
    const { server, token } = await start();
    expect((await fetch(`${server.url}/readyz`)).status).toBe(200);
    expect(await fullGauges(server, token)).toEqual({ home: 0, 'thread-roots': 0 });
  });

  it('home 滿了：抓指標自己會查，/readyz 回 503 storage-full', async () => {
    const { server, token } = await start(({ home }) => home);
    expect(await fullGauges(server, token)).toEqual({ home: 1, 'thread-roots': 0 });
    const response = await fetch(`${server.url}/readyz`);
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('storage-full');
  });

  it('--session-log 在 home 外面也算 home 這一區', async () => {
    const { server, token } = await start(
      ({ base }) => join(base, 'logs'),
      (base) => {
        mkdirSync(join(base, 'logs'), { mode: 0o700 });
        return ['--session-log', join(base, 'logs')];
      },
    );
    expect(await fullGauges(server, token)).toEqual({ home: 1, 'thread-roots': 0 });
  });

  it('--workspace 是唯讀共用區，滿了也不算：/readyz 200、指標 0', async () => {
    const { server, token } = await start(
      ({ base }) => join(base, 'shared'),
      (base) => {
        mkdirSync(join(base, 'shared'));
        return ['--workspace', join(base, 'shared')];
      },
    );
    expect(await fullGauges(server, token)).toEqual({ home: 0, 'thread-roots': 0 });
    expect((await fetch(`${server.url}/readyz`)).status).toBe(200);
  });

  it('thread 根滿了：只有這一區是 1，/readyz 一樣 503', async () => {
    const { server, token } = await start(({ home }) =>
      resolveThreadRootsBase({ [HARNESS_HOME_ENV]: home }),
    );
    expect(await fullGauges(server, token)).toEqual({ home: 0, 'thread-roots': 1 });
    expect((await fetch(`${server.url}/readyz`)).status).toBe(503);
  });
});

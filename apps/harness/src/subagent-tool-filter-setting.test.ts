/**
 * `background-subagents` 那一列的 `toolFilter` 真的接到組裝點（[#707](https://github.com/DemianLi/nexus-agent/issues/707)）：
 * 攔在 `createNexusAgent` 上看 `createCliAgent` 交給它的 `subagentToolFilter`。
 *
 * 兩條產品路徑都要量：`serve` 與 `runCli`（這一格與背景續行無關，REPL 與一次性模式也要遮）。
 */

import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const seen = vi.hoisted(() => ({ filters: [] as unknown[] }));

vi.mock('./agent-factory.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./agent-factory.js')>();
  return {
    ...original,
    createNexusAgent: (...args: Parameters<typeof original.createNexusAgent>) => {
      seen.filters.push((args[0] as { subagentToolFilter?: unknown }).subagentToolFilter);
      return original.createNexusAgent(...args);
    },
  };
});

import { runCli } from './cli.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';

let running: RunningServe | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
  seen.filters.length = 0;
});

const DENY = 'src/settings/tool-filter-deny.patch.yml';
const UNKNOWN = 'src/settings/tool-filter-unknown.patch.yml';
const EMPTY = 'src/settings/tool-filter-empty.patch.yml';

async function cliOnce(patches: readonly string[]): Promise<void> {
  await runCli({
    argv: [...patches.flatMap((patch) => ['--patch', patch]), '嗨'],
    input: new PassThrough(),
    output: new PassThrough(),
    printer: { log: () => undefined, error: () => undefined },
  });
}

describe('runCli 讀 toolFilter', () => {
  it('出貨預設不填：組裝點沒收到這一格', async () => {
    await cliOnce([]);
    expect(seen.filters.length).toBeGreaterThan(0);
    expect(seen.filters.every((each) => each === undefined)).toBe(true);
  });

  it('patch 填了：組裝點收到那份（CLI 沒有背景續行，照樣收到）', async () => {
    await cliOnce([DENY]);
    expect(seen.filters.at(-1)).toEqual({ deny: ['write_file'] });
  });

  it('列了不存在的工具名：組裝期拋，指名並列出已知名單', async () => {
    await expect(cliOnce([UNKNOWN])).rejects.toThrow(/"writte_file"[\s\S]*write_file/);
  });

  it('allow、deny 都沒給：起不來（這一列是必掛的，寫壞不能退成「沒有過濾」）', async () => {
    await expect(cliOnce([EMPTY])).rejects.toThrow(/background-subagents[\s\S]*toolFilter/);
  });
});

describe('serve 讀 toolFilter', () => {
  const start = (patch: string) =>
    runServe({
      argv: ['--port', '0', '--patch', patch],
      log: () => undefined,
      env: {},
    });

  it('patch 填了：試裝配與每條 thread 的組裝都收到', async () => {
    running = await start(DENY);
    expect(seen.filters.length).toBeGreaterThan(0);
    expect(seen.filters.every((each) => JSON.stringify(each) === '{"deny":["write_file"]}')).toBe(
      true,
    );
  });

  it('寫錯名字：server 起不來（起動時的試裝配就拋，不等第一條 thread）', async () => {
    await expect(start(UNKNOWN)).rejects.toThrow(/"writte_file"/);
  });
});

/**
 * serve 與 CLI 的 Cordis 根（#1401）：相容層的生命週期與樹上的啟動結算。
 *
 * - **驗收 D**：經服務組出的 agent 沒人手動收，卸載根就收掉它，活資源回到啟動前。量的是一顆真的開了 TCP server 的外掛，
 *   卸載之前先確認量得到它（不然「回到啟動前」可能只是什麼都沒量到）。突變（量過）：相容層拿掉 `ctx.effect` 那一行、
 *   `dispose` 直接交 `built.dispose` → 第一條紅（卸載根之後 `TCPServerWrap` 還多一個）。
 *   serve 那一條量產品路徑：起一台、跑一條 thread、關掉，活資源回到啟動前。
 * - **驗收 E**：相容層那一列起不來，CLI 與 serve 都拋 `StartupError`（`main()` 換成退出碼 1），訊息指名那一列與原因，
 *   入口那一列列出等不到的服務；serve 沒綁 port。
 */

import { createServer } from 'node:net';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import type { PluginEntry } from '@nexus/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runCli } from './cli.js';
import { compatLayer, createCordisRoot } from './cordis-root.js';
import { foldTurn, serveClient, shippedPlugins } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { runServe } from './serve.js';
import { StartupError } from './startup-audit.js';

const temporary: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function home(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-cordis-root-'));
  chmodSync(dir, 0o700);
  temporary.push(dir);
  return { [HARNESS_HOME_ENV]: dir };
}

/** 行程的活資源，按類型計數。 */
function resources(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const type of process.getActiveResourcesInfo()) counts[type] = (counts[type] ?? 0) + 1;
  return counts;
}

/** 兩份計數的差，只列有差的類型。 */
function delta(after: Record<string, number>, before: Record<string, number>) {
  const out: Record<string, number> = {};
  for (const type of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const diff = (after[type] ?? 0) - (before[type] ?? 0);
    if (diff !== 0) out[type] = diff;
  }
  return out;
}

/** 讓剛關掉的 socket 與計時器離場。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 20));
}

/** 掛上時開一個 TCP server、收尾時關掉的外掛。 */
const SOCKET: PluginEntry = {
  plugin: {
    name: 'cordis-root-socket',
    apply(registry) {
      const server = createServer().listen(0, '127.0.0.1');
      registry.lifecycle.onDispose(
        () => new Promise<void>((resolve) => server.close(() => resolve())),
      );
    },
  },
};

describe('相容層的生命週期（驗收 D）', () => {
  it('經服務組出、沒人手動收的 agent，卸載根就收掉：活資源回到啟動前', async () => {
    const plugins = [...(await shippedPlugins()), SOCKET];
    await settle();
    const before = resources();
    const root = createCordisRoot();
    const assembly = await root.boot('cli', { plugins });
    await assembly.create({ live: false });
    await settle();
    // 前提：量得到那顆外掛開的 server。
    expect(delta(resources(), before)).toMatchObject({ TCPServerWrap: 1 });
    await root.dispose();
    await settle();
    expect(delta(resources(), before)).toEqual({});
  });

  it('serve：起一台、跑一條 thread、關掉，活資源回到啟動前', async () => {
    const env = home();
    await settle();
    const before = resources();
    const running = await runServe({ argv: ['--port', '0'], log: () => undefined, env });
    if (running === undefined) throw new Error('serve 沒起來');
    const client = await serveClient(running);
    const events = await client.openEvents('cordis-root');
    await client.runStart('cordis-root', '說點什麼');
    await foldTurn(events);
    await events.return?.(undefined);
    await running.close();
    await settle();
    expect(delta(resources(), before)).toEqual({});
  }, 60000);
});

describe('相容層那一列起不來（驗收 E）', () => {
  const broken = () =>
    vi.spyOn(compatLayer, 'apply').mockImplementation(() => {
      throw new Error('相容層壞了');
    });

  function expectNamed(error: unknown, surface: string): void {
    expect(error).toBeInstanceOf(StartupError);
    const message = (error as Error).message;
    expect(message).toMatch(/^起不來：/u);
    expect(message).toMatch(
      /^ {2}nexus-compat（cordis:nexus-compat）〔必掛〕掛上時失敗：相容層壞了$/mu,
    );
    expect(message).toContain(
      `  ${surface}（cordis:${surface}）〔必掛〕要用的服務沒人提供：等不到 assembly`,
    );
  }

  it('CLI 拋 StartupError，指名那一列與原因', async () => {
    broken();
    const error = await runCli({
      argv: ['說點什麼'],
      env: home(),
      input: new PassThrough(),
      output: new PassThrough(),
      printer: { log: () => undefined, error: () => undefined },
    }).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expectNamed(error, 'cli');
  });

  it('serve 拋 StartupError，指名那一列與原因，沒綁 port', async () => {
    broken();
    await settle();
    const before = resources();
    const error = await runServe({ argv: ['--port', '0'], log: () => undefined, env: home() }).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expectNamed(error, 'serve');
    await settle();
    expect(delta(resources(), before)).toEqual({});
  });
});

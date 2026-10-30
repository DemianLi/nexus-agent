/**
 * 過渡版監控（#1946 S3 第 2 條）：用假的一代釘住退避、舊的關了才起新的、partial 只印一次。真執行檔在
 * `sandbox-spawner.integration.test.ts`。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SpawnerSupervisor } from './sandbox-spawner-client.js';
import type { GenerationHooks, SpawnerGeneration } from './sandbox-spawner-client.js';
import type { ToolProcess, ToolRequest } from './tool-process.js';

const REQUEST: ToolRequest = {
  executable: '/rg',
  args: [],
  cwd: '/w',
  mode: 'read-only',
  readable: [],
  writable: [],
  env: {},
};
const PROCESS = { pid: 1 } as ToolProcess;
const BACKOFF = { initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 3 };

function harness() {
  const generations: { hooks: GenerationHooks; close: () => void }[] = [];
  const log: string[] = [];
  const live: SpawnerGeneration = {
    landlockAbi: 5,
    spawn: () => Promise.resolve(PROCESS),
    stop: () => {},
  };
  const supervisor = new SpawnerSupervisor({
    binary: '/spawner',
    log: (line) => log.push(line),
    backoff: BACKOFF,
    start: (_, hooks) =>
      new Promise((resolve) => {
        generations.push({ hooks, close: () => hooks.onClosed() });
        resolve(live);
      }),
  });
  return { supervisor, generations, log };
}

describe('SpawnerSupervisor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('第一次工具呼叫才起 spawner，之後共用同一代', async () => {
    const { supervisor, generations } = harness();
    expect(generations).toHaveLength(0);
    expect(await supervisor.launch(REQUEST)).toBe(PROCESS);
    expect(await supervisor.launch(REQUEST)).toBe(PROCESS);
    expect(generations).toHaveLength(1);
  });

  it('掛了之後舊的關閉才排重起，退避 500ms 起加倍；退避中的要求直接回 sandbox-unavailable', async () => {
    const { supervisor, generations, log } = harness();
    await supervisor.launch(REQUEST);
    generations[0]?.close();
    expect(await supervisor.launch(REQUEST)).toBe('sandbox-unavailable');
    await vi.advanceTimersByTimeAsync(499);
    expect(generations).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(generations).toHaveLength(2);
    expect(await supervisor.launch(REQUEST)).toBe(PROCESS);
    generations[1]?.close();
    await vi.advanceTimersByTimeAsync(999);
    expect(generations).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(generations).toHaveLength(3);
    expect(log.join('\n')).toContain('1000ms');
  });

  it('撐過最長的退避間隔才算過了這次故障，次數歸零', async () => {
    const { supervisor, generations, log } = harness();
    await supervisor.launch(REQUEST);
    generations[0]?.close();
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(30_000);
    generations[1]?.close();
    expect(log.at(-1)).toContain('500ms');
    expect(log.at(-1)).toContain('第 1/3 次');
  });

  it('預算用完就停；下一次工具呼叫開新的預算', async () => {
    const { supervisor, generations, log } = harness();
    await supervisor.launch(REQUEST);
    for (const delay of [500, 1000, 2000]) {
      generations.at(-1)?.close();
      await vi.advanceTimersByTimeAsync(delay);
    }
    expect(generations).toHaveLength(4);
    generations.at(-1)?.close();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(generations).toHaveLength(4);
    expect(log.at(-1)).toContain('停止重啟');
    expect(await supervisor.launch(REQUEST)).toBe(PROCESS);
    expect(generations).toHaveLength(5);
    generations.at(-1)?.close();
    await vi.advanceTimersByTimeAsync(500);
    expect(generations).toHaveLength(6);
  });

  it('起不來的一代回 sandbox-unavailable，不是丟例外', async () => {
    const failing = new SpawnerSupervisor({
      binary: '/spawner',
      log: () => {},
      backoff: BACKOFF,
      start: () => Promise.reject(new Error('boom')),
    });
    expect(await failing.launch(REQUEST)).toBe('sandbox-unavailable');
  });

  it('partial 通知同一個 serve 只印一次，跨代也是', async () => {
    const { supervisor, generations, log } = harness();
    await supervisor.launch(REQUEST);
    generations[0]?.hooks.onPartial();
    generations[0]?.hooks.onPartial();
    generations[0]?.close();
    await vi.advanceTimersByTimeAsync(500);
    await supervisor.launch(REQUEST);
    generations[1]?.hooks.onPartial();
    await vi.advanceTimersByTimeAsync(0);
    expect(log.filter((line) => line.includes('部分強制'))).toHaveLength(1);
    expect(log.join('\n')).toContain('ABI 是 5');
  });
});

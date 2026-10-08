/**
 * **`/permission` 切換之後，線上真的推了一顆新的 `permissions` 投影，重新整理與冷啟動之後讀回同一個值**——
 * [#437](https://github.com/DemianLi/nexus-agent/issues/437) 的驗收。
 *
 * web 刻意**不在本機先改值**，等的就是下行上的這一顆；`permission-presets.test.ts` 拿投影單元把日誌折一遍，只證明「從歷史推得出來」，
 * 沒證明線上推了。這一份走產品組裝：真的 `runServe`（帶 `--workspace`，權限組合那一列才會掛）、真的 handler、真的 client。
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Event, WireClient } from '@nexus/wire';
import { emptyConversation, PERMISSIONS_PROJECTION_KEY, PROJECTION, reduceAll } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';

import { serveClient } from './fixtures.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';

const settle = () => new Promise((resolve) => setImmediate(resolve));

let running: RunningServe | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function start(root: string, workspace: string): Promise<RunningServe> {
  const server = (await runServe({
    argv: ['--port', '0', '--session-log', root, '--workspace', workspace],
    log: () => {},
    env: {},
  })) as RunningServe;
  running = server;
  return server;
}

/** `permissions` 這一格投影的 `currentValue` 序列，照收到的先後。 */
const pushed = (frames: readonly Event[]): string[] =>
  frames
    .filter((frame) => frame.method === 'custom')
    .map((frame) => frame.params.data as { name: string; payload: { key: string; view: unknown } })
    .filter((data) => data.name === PROJECTION && data.payload.key === PERMISSIONS_PROJECTION_KEY)
    .map((data) => (data.payload.view as { currentValue: string }).currentValue);

/** 歷史最新一頁折出的 `permissions` 投影。 */
async function refreshed(client: WireClient, threadId: string): Promise<string | undefined> {
  const outcome = await client.threadHistory(threadId);
  if (outcome.kind !== 'ok') throw new Error(`歷史沒拿到：${JSON.stringify(outcome)}`);
  const view = reduceAll(emptyConversation(), outcome.result.events).projections[
    PERMISSIONS_PROJECTION_KEY
  ]?.view as { currentValue: string } | undefined;
  return view?.currentValue;
}

async function follow(client: WireClient, threadId: string): Promise<Event[]> {
  const frames: Event[] = [];
  const events = await client.openEvents(threadId);
  void (async () => {
    try {
      for await (const frame of events) frames.push(frame);
    } catch {
      // server 收掉時下行會斷，不是測試要量的事。
    }
  })();
  return frames;
}

async function until(done: () => boolean): Promise<void> {
  for (let tries = 0; tries < 400 && !done(); tries += 1) await settle();
}

describe('權限組合的投影，線上與歷史一致', () => {
  it('切到全開：下行推出 currentValue=danger-full-access；重新整理與冷啟動都讀回同一個值', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-permission-wire-'));
    const workspace = await mkdtemp(join(tmpdir(), 'nexus-permission-wire-ws-'));
    const first = await start(root, workspace);
    const client = await serveClient(first);
    const live = await follow(client, 't');

    // 前提：切之前歷史已經帶了起始組合（新會話釘進日誌的那一組），下行還沒推過任何一顆。
    expect(await refreshed(client, 't')).toBe('workspace-write');
    expect(pushed(live)).toEqual([]);

    const ran = await client.slashRun('t', '/permission danger-full-access');
    expect(ran.kind).not.toBe('error');
    await until(() => pushed(live).at(-1) === 'danger-full-access');

    // 下行上真的收到了：最後一顆就是全開（中間可以先經過別的值，兩顆旋鈕是依序動的）。
    expect(pushed(live).at(-1)).toBe('danger-full-access');
    // 即時折出來的與重新整理（歷史）折出來的是同一份。
    expect(await refreshed(client, 't')).toBe('danger-full-access');

    // 冷啟動：server 重開，第一次開歷史（還沒有任何即時 frame）就是全開。
    await first.close();
    running = undefined;
    const second = await start(root, workspace);
    expect(await refreshed(await serveClient(second), 't')).toBe('danger-full-access');
  });
});

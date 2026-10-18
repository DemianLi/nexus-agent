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

import { FULL_ACCESS_PATCH, serveClient } from './fixtures.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';

const settle = () => new Promise((resolve) => setImmediate(resolve));

let running: RunningServe | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function start(
  root: string,
  workspace: string,
  extra: readonly string[] = [],
): Promise<RunningServe> {
  const server = (await runServe({
    argv: ['--port', '0', '--session-log', root, '--workspace', workspace, ...extra],
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

/** 部署方加回全開那一組（#1621：出廠表只有兩組）。 */
const WITH_FULL_ACCESS = ['--patch', FULL_ACCESS_PATCH] as const;

/** 歷史最新一頁的事件數。 */
async function historyLength(client: WireClient, threadId: string): Promise<number> {
  const outcome = await client.threadHistory(threadId);
  if (outcome.kind !== 'ok') throw new Error(`歷史沒拿到：${JSON.stringify(outcome)}`);
  return outcome.result.events.length;
}

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
  it('部署方加回全開之後切過去：下行推出 currentValue=danger-full-access；重新整理與冷啟動都讀回同一個值', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-permission-wire-'));
    const workspace = await mkdtemp(join(tmpdir(), 'nexus-permission-wire-ws-'));
    const first = await start(root, workspace, WITH_FULL_ACCESS);
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
    const second = await start(root, workspace, WITH_FULL_ACCESS);
    expect(await refreshed(await serveClient(second), 't')).toBe('danger-full-access');
  });
});

describe('出廠表沒有全開（#1621）', () => {
  it('`/permission danger-full-access` 回 error、日誌沒有新事件、目錄只有兩組', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-permission-wire-'));
    const workspace = await mkdtemp(join(tmpdir(), 'nexus-permission-wire-ws-'));
    const client = await serveClient(await start(root, workspace));

    const catalog = await client.permissionCatalog('t');
    expect(catalog.kind).toBe('ok');
    if (catalog.kind !== 'ok') return;
    expect(catalog.result.value.catalog.options.map((option) => option.value)).toEqual([
      'read-only',
      'workspace-write',
    ]);

    const before = await historyLength(client, 't');
    const ran = await client.slashRun('t', '/permission danger-full-access');
    expect(ran).toMatchObject({ kind: 'error' });
    // 今天那句「認不得」，列出的只有兩組。
    expect(ran.kind === 'error' && ran.text).toBe(
      '/permission 認不得 "danger-full-access"。認得的是 read-only、workspace-write。',
    );
    expect(await historyLength(client, 't')).toBe(before);
    expect(await refreshed(client, 't')).toBe('workspace-write');
  });

  it('`--sandbox danger-full-access` 起 serve：起動當下失敗，訊息指出要在表裡補上那一組', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-permission-wire-'));
    const workspace = await mkdtemp(join(tmpdir(), 'nexus-permission-wire-ws-'));
    await expect(start(root, workspace, ['--sandbox', 'danger-full-access'])).rejects.toThrow(
      '要嘛在表裡補上那一組',
    );
  });

  it('升級前切到全開的會話，升級後沒加回：serve 照樣起得來，續接保留日誌裡的值、顯示 custom，切不回全開', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-permission-wire-'));
    const workspace = await mkdtemp(join(tmpdir(), 'nexus-permission-wire-ws-'));
    const before = await serveClient(await start(root, workspace, WITH_FULL_ACCESS));
    expect(await before.slashRun('t', '/permission danger-full-access')).toMatchObject({
      kind: 'success',
    });
    expect(await refreshed(before, 't')).toBe('danger-full-access');
    await running?.close();
    running = undefined;

    const after = await serveClient(await start(root, workspace));
    expect(await refreshed(after, 't')).toBe('custom');
    expect(await after.slashRun('t', '/permission danger-full-access')).toMatchObject({
      kind: 'error',
    });
  });

  it('加回之後 `--sandbox danger-full-access` 照樣起得來，起始組合就是全開', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-permission-wire-'));
    const workspace = await mkdtemp(join(tmpdir(), 'nexus-permission-wire-ws-'));
    const server = await start(root, workspace, [
      ...WITH_FULL_ACCESS,
      '--sandbox',
      'danger-full-access',
    ]);
    expect(await refreshed(await serveClient(server), 't')).toBe('danger-full-access');
  });
});

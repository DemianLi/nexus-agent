/**
 * 刪除、復原與已刪除清單的 wire 往返（[#2957](https://github.com/DemianLi/nexus-agent/issues/2957)）。
 *
 * 走真的 `createWireClient`：刪除 → `GET /threads` 看不到、`GET /threads/deleted` 看得到 → 復原 → `GET /threads` 又看得到。
 * 會話日誌是真的磁碟上的 jsonl，搬移與寬限期都是真的 `ThreadDeletions`；沒有 thread 組起來（沒有執行中的 agent）。
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SESSION_LOG_FORMAT_VERSION, sessionDirectoryName } from '@nexus/core';
import type { SessionEvent } from '@nexus/core';
import { THREAD_DELETED, WireRejectedError, commandPath, createWireClient } from '@nexus/wire';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { emptyCommandPoint, loopbackRequest, TEST_BROWSER_AUTH } from './fixtures.js';
import { openJsonlSessionStore, projectKey } from './jsonl-session-store.js';
import type { PumpAgent } from './thread-pump.js';
import { ThreadDeletions, threadDeletionPortFor } from './thread-deletion.js';
import { createWireHandler } from './wire-handler.js';

const CWD = '/work/wire-delete';
const PROJECT = projectKey(CWD);
const DAY = 86_400_000;
const OWNER = { kind: 'owner' } as const;

let root: string;
let home: string;
let sessionsRoot: string;
let projectDir: string;
let deletedRoot: string;
let handler: ReturnType<typeof createWireHandler> | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nexus-thread-deletion-wire-'));
  home = join(root, 'home');
  sessionsRoot = join(home, 'sessions');
  projectDir = join(sessionsRoot, PROJECT);
  deletedRoot = join(home, 'sessions-deleted');
});

afterEach(async () => {
  await handler?.close();
  handler = undefined;
  rmSync(root, { recursive: true, force: true });
});

async function seed(id: string): Promise<void> {
  const stored = openJsonlSessionStore({ directory: projectDir }).create({
    version: SESSION_LOG_FORMAT_VERSION,
    id,
    createdAt: 1,
    cwd: CWD,
  });
  await stored.append([{ type: 'model/usage', seq: 0, time: 1, data: {} } as SessionEvent]);
  await stored.close();
}

/** 列表照磁碟列：目錄還在的才算存在（刪掉就不見，復原就回來）。 */
function listedOnDisk(titles: Record<string, string>) {
  return async () => ({
    items: Object.keys(titles)
      .filter((id) => existsSync(join(projectDir, sessionDirectoryName(id))))
      .map((id) => ({ threadId: id, updatedAt: 1, blank: false, title: titles[id] })),
    unreadable: 0,
  });
}

function setup(
  options: { graceMs?: number; withDeletion?: boolean; releaseIdleWaitMs?: number } = {},
) {
  const titles = { 't-live': '還在的', 't-gone': '要刪的' };
  const clock = { now: 1_000_000 };
  const holder: { wire?: ReturnType<typeof createWireHandler> } = {};
  const deletions = new ThreadDeletions({
    home,
    sessionsRoot,
    deletedRoot,
    graceMs: options.graceMs ?? 30 * DAY,
    now: () => clock.now,
    releaseWriter: (id) => holder.wire!.releaseWriter(id),
  });
  holder.wire = createWireHandler({
    auth: TEST_BROWSER_AUTH,
    ...(options.releaseIdleWaitMs === undefined
      ? {}
      : { releaseIdleWaitMs: options.releaseIdleWaitMs }),
    listThreads: listedOnDisk(titles),
    deletionGate:
      options.withDeletion === false
        ? undefined
        : {
            hiddenReason: async (id) => deletions.hiddenReason(PROJECT, id),
            hiddenIds: async () => deletions.hiddenThreadIds(PROJECT),
          },
    threadDeletion:
      options.withDeletion === false
        ? undefined
        : // 同 `serve-run.ts` 用的那一份：綁專案格與「只列這格」都在它裡面。
          threadDeletionPortFor(deletions, PROJECT),
    createAgent: async () => ({
      agent: {} as PumpAgent,
      commands: emptyCommandPoint(),
      dispose: async () => {},
      attachSessions: () => ({ detach: async () => {} }),
    }),
  });
  handler = holder.wire;
  const fetch = async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) =>
    holder.wire!.handle(loopbackRequest(input as string, init));
  const client = createWireClient({ baseUrl: 'http://delete.test', fetch });
  return { client, clock, wire: holder.wire };
}

function ids(outcome: Awaited<ReturnType<ReturnType<typeof setup>['client']['listThreads']>>) {
  if (outcome.kind !== 'ok') throw new Error(`列表被拒：${outcome.kind}`);
  return outcome.result.items.map((item) => item.threadId).sort();
}

describe('刪除、復原與已刪除清單：真的 wire 往返', () => {
  it('刪除 → 列表看不到、已刪除清單看得到 → 復原 → 列表看得到', async () => {
    await seed('t-live');
    await seed('t-gone');
    const { client, clock } = setup();

    expect(ids(await client.listThreads())).toEqual(['t-gone', 't-live']);

    expect(await client.threadDelete('t-gone')).toEqual({
      kind: 'ok',
      result: {
        ok: true,
        value: { threadId: 't-gone', deletedAt: clock.now, expiresAt: clock.now + 30 * DAY },
      },
    });
    expect(ids(await client.listThreads())).toEqual(['t-live']);
    expect(await client.deletedThreads()).toEqual({
      kind: 'ok',
      result: {
        items: [
          {
            threadId: 't-gone',
            title: '要刪的',
            deletedAt: clock.now,
            expiresAt: clock.now + 30 * DAY,
          },
        ],
      },
    });

    expect(await client.threadRestore('t-gone')).toEqual({
      kind: 'ok',
      result: { ok: true, value: { threadId: 't-gone' } },
    });
    expect(ids(await client.listThreads())).toEqual(['t-gone', 't-live']);
    expect(await client.deletedThreads()).toEqual({ kind: 'ok', result: { items: [] } });
  }, 30_000);

  it('重複刪、沒有的復原，業務失敗在 result 裡；原處有同 id 是 restore_conflict，寬限期過了是 restore_expired', async () => {
    await seed('t-gone');
    const { client, clock } = setup({ graceMs: 2 * DAY });

    await client.threadDelete('t-gone');
    expect(await client.threadDelete('t-gone')).toEqual({
      kind: 'ok',
      result: { ok: false, error: { code: 'thread_deleted' } },
    });
    expect(await client.threadDelete('t-nope')).toEqual({
      kind: 'ok',
      result: { ok: false, error: { code: 'thread_not_found' } },
    });

    // 原處重新長出同 id：復原拒絕，檔案留在已刪除存放區，不覆寫，清單上還看得到。
    await seed('t-gone');
    expect(await client.threadRestore('t-gone')).toEqual({
      kind: 'ok',
      result: { ok: false, error: { code: 'restore_conflict' } },
    });
    const stillTrashed = await client.deletedThreads();
    expect(stillTrashed.kind === 'ok' && stillTrashed.result.items.map((i) => i.threadId)).toEqual([
      't-gone',
    ]);

    // 寬限期過了：復原拒絕，檔案還在。
    clock.now += 3 * DAY;
    expect(await client.threadRestore('t-gone')).toEqual({
      kind: 'ok',
      result: { ok: false, error: { code: 'restore_expired' } },
    });
    expect(await client.threadRestore('t-never')).toEqual({
      kind: 'ok',
      result: { ok: false, error: { code: 'thread_not_deleted' } },
    });
  }, 30_000);

  it('刪掉一條已經載入記憶體的：經 HTTP 刪除不會等到自己這個請求（#2957）', async () => {
    await seed('t-live');
    await seed('t-gone');
    // 等不到閒置就在 1 秒後拋：刪除請求自己算進那條 thread 的在途請求數時，這條紅。
    const { client, wire } = setup({ releaseIdleWaitMs: 1_000 });
    await wire.open('t-gone');
    expect(wire.idleState('t-gone')).toMatchObject({ idle: true });

    const deleted = await client.threadDelete('t-gone');
    expect(deleted).toMatchObject({ kind: 'ok' });
    expect(ids(await client.listThreads())).toEqual(['t-live']);
    expect(wire.idleState('t-gone')).toBeUndefined();
  });

  it('有人開著這條的下行（看著它）：刪除不等看的人，刪完那條下行正常結束', async () => {
    await seed('t-live');
    await seed('t-gone');
    const { client } = setup({ releaseIdleWaitMs: 1_000 });
    // 開下行就會建起這條 thread；看的人只讀，等它關掉就等不完（頁籤一直開著）。
    const events = await client.openEvents('t-gone');

    const deleted = await client.threadDelete('t-gone');
    expect(deleted).toMatchObject({ kind: 'ok' });
    expect(ids(await client.listThreads())).toEqual(['t-live']);
    const rest: unknown[] = [];
    for await (const event of events) rest.push(event);
    expect(rest).toEqual([]);
  });

  it('刪掉之後再開這條（重連、送話）：回專用碼 thread_deleted，客戶端分得出是刪了、不是暫時連不上', async () => {
    await seed('t-live');
    await seed('t-gone');
    const { client } = setup();
    await client.threadDelete('t-gone');

    const refused = await client.openEvents('t-gone').then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(WireRejectedError);
    expect((refused as WireRejectedError).code).toBe(THREAD_DELETED);
    expect(await client.runStart('t-gone', '還在嗎')).toMatchObject({
      type: 'error',
      error: THREAD_DELETED,
    });
  });

  it('同一條 thread 還有別的在途請求（run.start 的本文還沒讀完）：刪除照樣等它，等不到就什麼都不搬', async () => {
    await seed('t-live');
    await seed('t-gone');
    const { client, wire } = setup({ releaseIdleWaitMs: 300 });
    await wire.open('t-gone');
    // 本文一直不送完：這個請求停在讀本文那一步，算在這條 thread 的在途請求數裡。
    const stalled = new ReadableStream<Uint8Array>({ start: () => undefined });
    const pending = wire.handle(
      loopbackRequest(`http://delete.test${commandPath('t-gone', 'run.start')}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: stalled,
        duplex: 'half',
      } as RequestInit),
    );
    void pending.catch(() => undefined);

    const deleted = await client.threadDelete('t-gone');
    expect(deleted.kind).not.toBe('ok');
    expect(existsSync(join(projectDir, sessionDirectoryName('t-gone')))).toBe(true);
    expect(existsSync(join(deletedRoot, PROJECT, sessionDirectoryName('t-gone')))).toBe(false);
    expect(ids(await client.listThreads())).toEqual(['t-gone', 't-live']);
  });

  it('已刪除清單只列這個專案格的：別的專案格刪掉的不列', async () => {
    await seed('t-live');
    await seed('t-gone');
    const { client, wire } = setup();
    // 別的專案格的一條：直接用同一份存放區刪它（綁的是別的 projectKey），清單上不能出現。
    const otherCwd = '/work/other-cell';
    const otherDir = join(sessionsRoot, projectKey(otherCwd));
    const stored = openJsonlSessionStore({ directory: otherDir }).create({
      version: SESSION_LOG_FORMAT_VERSION,
      id: 't-other',
      createdAt: 1,
      cwd: otherCwd,
    });
    await stored.append([{ type: 'model/usage', seq: 0, time: 1, data: {} } as SessionEvent]);
    await stored.close();
    const other = new ThreadDeletions({
      home,
      sessionsRoot,
      deletedRoot,
      graceMs: 30 * DAY,
      now: () => 1_000_000,
      releaseWriter: (id) => wire.releaseWriter(id),
    });
    await other.delete({ threadId: 't-other', projectKey: projectKey(otherCwd), actor: OWNER });
    await client.threadDelete('t-gone');
    const trash = await client.deletedThreads();
    expect(trash.kind === 'ok' && trash.result.items.map((i) => i.threadId)).toEqual(['t-gone']);
  }, 30_000);

  it('沒接已刪除存放區：thread.delete 與 GET /threads/deleted 回 not_supported，列表不動', async () => {
    await seed('t-live');
    const { client } = setup({ withDeletion: false });
    expect(await client.threadDelete('t-live')).toEqual({
      kind: 'rejected',
      code: 'not_supported',
      message: expect.any(String),
    });
    expect(await client.deletedThreads()).toEqual({
      kind: 'rejected',
      code: 'not_supported',
      message: expect.any(String),
    });
    expect(ids(await client.listThreads())).toEqual(['t-live']);
  });
});

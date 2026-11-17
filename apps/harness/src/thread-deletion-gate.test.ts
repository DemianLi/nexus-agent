/**
 * 刪除會話的 wire 閘門與寫入方放手（[#2957](https://github.com/DemianLi/nexus-agent/issues/2957)，single 模式）。
 *
 * 用的是閒置逐出的測試台（真的 wire handler、真的最小 agent），會話日誌是真的磁碟上的 jsonl，寫租約也是真的。
 */

import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SESSION_LOG_FORMAT_VERSION } from '@nexus/core';
import type { SessionEvent } from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openJsonlSessionStore, projectKey, sessionPathsIn } from './jsonl-session-store.js';
import { BASE, JSON_HEADERS, rig, startHeldRun, touch } from './idle-eviction.fixture.js';
import { loopbackRequest } from './fixtures.js';
import type { Rig } from './idle-eviction.fixture.js';
import { ThreadDeletions, THREAD_DELETIONS_FILE } from './thread-deletion.js';

const CWD = '/work/gate';
const PROJECT = projectKey(CWD);
const OWNER = { kind: 'owner' } as const;

let root: string;
let home: string;
let sessionsRoot: string;
let deletedRoot: string;
let projectDir: string;
let open: Rig[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'thread-deletion-gate-'));
  home = join(root, 'home');
  sessionsRoot = join(home, 'sessions');
  deletedRoot = join(home, 'sessions-deleted');
  projectDir = join(sessionsRoot, PROJECT);
});

afterEach(async () => {
  for (const r of open) {
    r.probe.hold.open();
    r.probe.slash.open();
    await r.handler.close();
  }
  open = [];
  rmSync(root, { recursive: true, force: true });
});

function track(r: Rig): Rig {
  open.push(r);
  return r;
}

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

/** 讀歷史：經 `threadFor`，會組起這條 thread（沒有組起來就不會進 `created`）。 */
async function wake(r: Rig, id: string): Promise<void> {
  await touch(r, id);
}

describe('閘門：刪除中或已刪除的會話不再組起來', () => {
  it('組裝之前查閘門，擋下的不建任何 agent', async () => {
    const r = track(
      rig({
        deletionGate: {
          hiddenReason: async (id) => (id === 't-del' ? 'deleted' : undefined),
        },
      }),
    );
    await wake(r, 't-del');
    expect(r.created).not.toContain('t-del');
  });

  it('收尾之後的重建也擋：撤完再來一次請求，閘門已經翻成已刪除就不重建', async () => {
    const hidden: { value: 'deleting' | 'deleted' | undefined } = { value: undefined };
    const r = track(rig({ deletionGate: { hiddenReason: async () => hidden.value } }));
    await wake(r, 't-x');
    expect(r.created).toEqual(['t-x']);
    hidden.value = 'deleted';
    await r.handler.releaseWriter('t-x');
    expect(r.evicted).toContain('t-x');
    await wake(r, 't-x');
    expect(r.created).toEqual(['t-x']);
  });
});

describe('releaseWriter：停、等閒置、撤出，回來時收尾已兌現', () => {
  it('還在跑的一輪被停下來，撤出之後 dispose 完成', async () => {
    const r = track(rig());
    await startHeldRun(r, 't-run');
    // 測試用的工具不看中止訊號，要等它放手一輪才會落定（真的工具會在中止時回來）。
    const released = r.handler.releaseWriter('t-run');
    r.probe.hold.open();
    await released;
    expect(r.disposed).toContain('t-run');
    expect(r.evicted).toContain('t-run');
  }, 60_000);

  it('寫租約在 releaseWriter 回來時已經放掉：另一個 store 拿得到寫租約', async () => {
    await seed('t-lease');
    const store = openJsonlSessionStore({ directory: projectDir });
    const r = track(rig({}));
    const state = { closed: false };
    const leases: Promise<Awaited<ReturnType<typeof store.resume>>>[] = [];
    r.extras.set('t-lease', {
      attachPersistence: () => {
        const pending = store.resume('t-lease');
        pending.catch(() => undefined);
        leases.push(pending);
        return {
          flush: async () => undefined,
          dispose: async () => {
            const resumed = await pending;
            await resumed.stored.close();
            state.closed = true;
          },
        };
      },
    });
    await wake(r, 't-lease');
    expect(r.created).toEqual(['t-lease']);
    // 租約要先真的拿到（resume 是非同步的），再問另一個後端：它應該拿不到。
    await leases[0];
    await expect(
      openJsonlSessionStore({ directory: projectDir }).resume('t-lease'),
    ).rejects.toThrow();
    await r.handler.releaseWriter('t-lease');
    // 收尾兌現的當下，落盤的 dispose（含關檔、放租約）已經做完，不是之後才做。
    expect(state.closed).toBe(true);
    const again = await openJsonlSessionStore({ directory: projectDir }).resume('t-lease');
    await again.stored.close();
  });
});

describe('刪除一條還在跑的會話', () => {
  it('停穩之後存放區的日誌位元組不再變，之後喚醒它的請求都被拒', async () => {
    await seed('t-busy');
    const logPath = sessionPathsIn(projectDir, 't-busy').log;
    const holder: { deletions?: ThreadDeletions } = {};
    const r = track(
      rig({
        deletionGate: {
          hiddenReason: (id) => holder.deletions!.hiddenReason(PROJECT, id),
        },
      }),
    );
    holder.deletions = new ThreadDeletions({
      home,
      sessionsRoot,
      deletedRoot,
      graceMs: 86_400_000,
      now: () => Date.now(),
      releaseWriter: (id) => r.handler.releaseWriter(id),
    });
    await startHeldRun(r, 't-busy');
    const deleting = holder.deletions.delete({
      threadId: 't-busy',
      projectKey: PROJECT,
      actor: OWNER,
    });
    r.probe.hold.open();
    await deleting;

    const moved = sessionPathsIn(join(deletedRoot, PROJECT), 't-busy').log;
    const sizeA = statSync(moved).size;
    const bytesA = readFileSync(moved);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(statSync(moved).size).toBe(sizeA);
    expect(readFileSync(moved).equals(bytesA)).toBe(true);
    expect(existsOriginal(logPath)).toBe(false);

    await wake(r, 't-busy');
    expect(r.created.filter((id) => id === 't-busy')).toHaveLength(1);
    expect(readFileSync(join(home, THREAD_DELETIONS_FILE), 'utf8')).toContain('"t-busy"');
  }, 60_000);
});

function existsOriginal(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

describe('列表與搜尋藏起刪除中與已刪除的會話', () => {
  it('GET /threads 不列刪除中與已刪除的那幾條', async () => {
    const hidden = new Set(['t-gone']);
    const r = track(
      rig({
        listThreads: async () => ({
          items: [
            { threadId: 't-live', updatedAt: 1, blank: false },
            { threadId: 't-gone', updatedAt: 2, blank: false },
          ],
          unreadable: 0,
        }),
        deletionGate: {
          hiddenReason: async () => undefined,
          hiddenIds: async () => hidden,
        },
      }),
    );
    const response = await r.handler.handle(
      loopbackRequest(`${BASE}/threads`, { method: 'GET', headers: JSON_HEADERS }),
    );
    const body = (await response.json()) as { result: { items: { threadId: string }[] } };
    expect(body.result.items.map((item) => item.threadId)).toEqual(['t-live']);
  });
});

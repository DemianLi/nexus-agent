/**
 * 真租約：一份子代理收尾失敗，撤掉之後同一個行程再開同一條 thread 不會撞自己的寫租約
 * （[#1511](https://github.com/DemianLi/nexus-agent/issues/1511) 驗收 5）。
 *
 * **真的 `JsonlSessionStore` 放在暫存目錄**，root 走續接（`resumedRoot`）拿真的 flock 租約；子代理那一份用一層包裝讓 `flush` 拒絕。
 * 以前 `persistence.dispose()` 逐一 await、倒著收，子代理（排在 root 後面）先收並拋錯，root 的協調器根本沒收——它的 `close()` 不跑，
 * 租約留在這個行程手上，使用者再開這條 thread 時續接 root 就丟 `SessionAlreadyOwnedError`
 * （「多半是另一個行程還開著它」，其實握著的是 serve 自己）。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SESSION_LOG_FORMAT_VERSION, attachSessionPersistence, SessionRegistry } from '@nexus/core';
import type { SessionEvent, SessionStore, StoredSession, StoredSessionHeader } from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openJsonlSessionStore } from './jsonl-session-store.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexus-flush-aggregate-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function header(id: string): StoredSessionHeader {
  return { version: SESSION_LOG_FORMAT_VERSION, id, createdAt: 1, cwd: '/tmp' };
}

function event(seq: number): SessionEvent {
  return { type: 'model/usage', seq, time: 1, data: {} } as unknown as SessionEvent;
}

/** 讓 `flush` 拒絕的包裝；`close` 照走真的（放租約、關檔）。 */
function failingFlush(inner: StoredSession): StoredSession {
  return {
    append: (events) => inner.append(events),
    flush: () => Promise.reject(new Error('磁碟滿了')),
    close: () => inner.close(),
  };
}

describe('子代理收尾失敗，root 的寫租約照樣放掉（#1511）', () => {
  it('dispose 拒絕成 AggregateError 之後，同一個行程再 resume 同一份 root 要成功', async () => {
    // 先寫一份一筆的 root，關掉——後面要續接的那一份。
    const first = openJsonlSessionStore({ directory: dir }).create(header('root'));
    await first.append([event(0)]);
    await first.close();

    const real = openJsonlSessionStore({ directory: dir });
    const resumed = await real.resume('root');
    const store: SessionStore = {
      ...real,
      list: () => real.list(),
      open: (id, mode) => real.open(id, mode),
      resume: (id) => real.resume(id),
      create: (created) => failingFlush(real.create(created)),
    };
    const sessions = new SessionRegistry('root', { rootSeed: resumed.events });
    const persistence = attachSessionPersistence(sessions, store, {
      resumedRoot: { stored: resumed.stored, storedCount: resumed.events.length },
      warn: () => {},
    });
    // 排在 root 後面的子代理；倒著收，它先收、先拋錯。
    sessions.open({ kind: 'subagent', runId: 'a' });

    const error = await persistence.dispose().then(
      () => undefined,
      (caught: unknown) => caught as AggregateError,
    );
    expect(error).toBeInstanceOf(AggregateError);
    expect(error?.message).toContain('root/a');
    expect(error?.message).toContain('磁碟滿了');

    // 租約放掉了：同一個行程再續接同一份不會撞自己。
    const again = await openJsonlSessionStore({ directory: dir }).resume('root');
    expect(again.events.length).toBeGreaterThan(0);
    await again.stored.close();
  });
});

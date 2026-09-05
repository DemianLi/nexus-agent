/**
 * 持久化協調器：批次窗口、補送、**圍堵翻面**、暫停與重試、註冊表接線。
 *
 * 對應 [#172](https://github.com/DemianLi/nexus-agent/issues/172) 的驗收句。最要緊的是
 * 「圍堵翻面」那一組——它擋的是把
 * {@link ./session-telemetry-coordinator.ts | 遙測協調器} 照抄一份、於是耐久失敗變成
 * 一行沒有人聽得見的 warn（[#170](https://github.com/DemianLi/nexus-agent/issues/170) 的形狀）。
 */

import { describe, expect, it, vi } from 'vitest';

import { SessionLog } from './session-log.js';
import { SessionRegistry } from './session-registry.js';
import { attachSessionPersistence, SessionPersistenceCoordinator } from './session-persistence.js';
import { SESSION_LOG_FORMAT_VERSION } from './session-store.js';
import type { SessionEvent } from './session-log.js';
import type { SessionStore, StoredSession, StoredSessionHeader } from './session-store.js';

/** 記下每一次呼叫的假把手，`fail` 打開之後每一次 `append` 都拒絕。 */
function fakeStored(): StoredSession & {
  readonly written: SessionEvent[];
  readonly batches: number[];
  flushes: number;
  closes: number;
  fail: Error | undefined;
} {
  const written: SessionEvent[] = [];
  const batches: number[] = [];
  return {
    written,
    batches,
    flushes: 0,
    closes: 0,
    fail: undefined as Error | undefined,
    append(events: readonly SessionEvent[]): Promise<void> {
      if (this.fail !== undefined) return Promise.reject(this.fail);
      batches.push(events.length);
      written.push(...events);
      return Promise.resolve();
    },
    // **`fail` 只影響 `append`，不影響這裡**，而且是刻意的：這樣「flush 響亮地拒絕」
    // 那幾條就只有一條路徑到得了——排空失敗。後端自己的 flush 也拒的話，那些斷言會
    // 因為錯的理由變綠（實測：把排空的失敗吞掉，它們照樣過）。
    flush(): Promise<void> {
      this.flushes += 1;
      return Promise.resolve();
    },
    close(): Promise<void> {
      this.closes += 1;
      return Promise.resolve();
    },
  };
}

/** 記一筆 `turn/start`。內容不重要，這裡驗的是搬運不是投影。 */
function turn(log: SessionLog): SessionEvent {
  return log.append('turn/start', { kind: 'message', text: 'p' });
}

describe('批次窗口', () => {
  it('flush 之前不必等窗口——排空到停穩再要後端寫下去', async () => {
    const log = new SessionLog('s');
    const stored = fakeStored();
    const coordinator = new SessionPersistenceCoordinator({ log, stored });
    turn(log);
    turn(log);
    expect(stored.written).toHaveLength(0);
    await coordinator.flush();
    expect(stored.written.map((event) => event.seq)).toEqual([0, 1]);
    expect(stored.flushes).toBe(1);
    // 兩顆一批：窗口是批次化的，不是逐筆寫。
    expect(stored.batches).toEqual([2]);
  });

  it('建構之前就有的事件會被補送——`subscribe` 不補發歷史', async () => {
    const log = new SessionLog('s');
    turn(log);
    turn(log);
    const stored = fakeStored();
    const coordinator = new SessionPersistenceCoordinator({ log, stored });
    turn(log);
    await coordinator.flush();
    expect(stored.written.map((event) => event.seq)).toEqual([0, 1, 2]);
  });

  it('窗口到期會自己寫，不必有人叫 flush', async () => {
    vi.useFakeTimers();
    try {
      const log = new SessionLog('s');
      const stored = fakeStored();
      new SessionPersistenceCoordinator({ log, stored, windowMs: 5 });
      turn(log);
      await vi.advanceTimersByTimeAsync(10);
      expect(stored.written).toHaveLength(1);
      // **後續事件加入但不重置截止時間**——所以第二顆在同一個窗口之後也寫得出去。
      expect(stored.flushes).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('圍堵翻面', () => {
  it('背景寫入被拒：事件保留、自動路徑暫停、一行 warn，而且 append 沒有拋到日誌那側', async () => {
    vi.useFakeTimers();
    try {
      const stored = fakeStored();
      const warn = vi.fn();
      const onListenerError = vi.fn();
      const logWithSpy = new SessionLog('s', { onListenerError });
      const coordinator = new SessionPersistenceCoordinator({
        log: logWithSpy,
        stored,
        warn,
        windowMs: 5,
      });
      stored.fail = new Error('磁碟滿了');
      turn(logWithSpy);
      await vi.advanceTimersByTimeAsync(10);

      expect(stored.written).toHaveLength(0);
      // 保留：那一筆還在佇列裡，順序不動。
      expect(coordinator.pending).toBe(1);
      expect(coordinator.paused).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('磁碟滿了');
      // **這一格是重點**：耐久失敗不能長得像「一個壞掉的觀察者」。`SessionLog` 那條
      // `Promise.resolve(returned).catch(...)` 的路徑一次都不該被走到。
      expect(onListenerError).not.toHaveBeenCalled();

      // 暫停之後不再開新窗口：又記一筆也不會再試。
      turn(logWithSpy);
      await vi.advanceTimersByTimeAsync(100);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(coordinator.pending).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('顯式 flush 響亮地拒絕——這是耐久失敗唯一的出口', async () => {
    const log = new SessionLog('s');
    const stored = fakeStored();
    const coordinator = new SessionPersistenceCoordinator({ log, stored, warn: () => {} });
    stored.fail = new Error('磁碟滿了');
    turn(log);
    await expect(coordinator.flush()).rejects.toThrow('磁碟滿了');
  });

  it('下一次 flush 會重試，而且補得回暫停期間積下來的每一筆', async () => {
    const log = new SessionLog('s');
    const stored = fakeStored();
    const coordinator = new SessionPersistenceCoordinator({ log, stored, warn: () => {} });
    stored.fail = new Error('磁碟滿了');
    turn(log);
    await expect(coordinator.flush()).rejects.toThrow('磁碟滿了');
    turn(log);
    stored.fail = undefined;
    await coordinator.flush();
    expect(stored.written.map((event) => event.seq)).toEqual([0, 1]);
    expect(coordinator.paused).toBe(false);
    expect(coordinator.pending).toBe(0);
  });

  it('dispose 也響亮——收尾時吞掉寫入失敗就是靜默的資料遺失', async () => {
    const log = new SessionLog('s');
    const stored = fakeStored();
    const coordinator = new SessionPersistenceCoordinator({ log, stored, warn: () => {} });
    stored.fail = new Error('磁碟滿了');
    turn(log);
    await expect(coordinator.dispose()).rejects.toThrow('磁碟滿了');
    // 拒絕歸拒絕，把手還是要放掉。
    expect(stored.closes).toBe(1);
  });

  it('乾淨收尾：最後一次 flush 寫掉剩下的，然後關把手', async () => {
    const log = new SessionLog('s');
    const stored = fakeStored();
    const coordinator = new SessionPersistenceCoordinator({ log, stored });
    turn(log);
    await coordinator.dispose();
    expect(stored.written).toHaveLength(1);
    expect(stored.closes).toBe(1);
    // 冪等。
    await coordinator.dispose();
    expect(stored.closes).toBe(1);
  });
});

describe('接在註冊表上', () => {
  it('root 與 subagent 各一份，subagent 的 header 帶血緣', async () => {
    const sessions = new SessionRegistry('root-1');
    const headers: StoredSessionHeader[] = [];
    const handles: ReturnType<typeof fakeStored>[] = [];
    const store: SessionStore = {
      create(header) {
        headers.push(header);
        const stored = fakeStored();
        handles.push(stored);
        return stored;
      },
    };
    const persistence = attachSessionPersistence(sessions, store, { cwd: '/w' });
    // **後來才出生的那一份也自動有**——subagent 的日誌是懶建的。
    const child = sessions.open({ kind: 'subagent', runId: 'r9' });
    child.append('todo/write', { todos: [] });
    sessions.root.append('turn/start', { kind: 'message', text: 'p' });
    await persistence.flush();

    expect(headers.map((header) => header.id)).toEqual(['root-1', 'root-1/r9']);
    expect(headers[0]?.parentSession).toBeUndefined();
    expect(headers[1]?.parentSession).toBe('root-1');
    expect(headers.every((header) => header.version === SESSION_LOG_FORMAT_VERSION)).toBe(true);
    expect(headers.every((header) => header.cwd === '/w')).toBe(true);
    expect(handles[0]?.written).toHaveLength(1);
    expect(handles[1]?.written).toHaveLength(1);

    await persistence.dispose();
    expect(handles.every((handle) => handle.closes === 1)).toBe(true);
  });
});

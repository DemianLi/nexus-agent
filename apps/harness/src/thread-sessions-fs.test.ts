/**
 * `ThreadSessions` 的 fs 那一面（[#1466](https://github.com/DemianLi/nexus-agent/issues/1466)）：一筆登記同時帶這條 thread 的
 * 會話註冊表與 fs 把手，**一起登記、一起取代、一起撤**，挑法與會話查找是同一支（core 的 `pickBoundForCall`）。
 *
 * 接進組裝與三個入口、磁碟與 fence 上的量法在 `submit-record-on-tree.test.ts`。
 */

import { SessionRegistry, createFsService } from '@nexus/core';
import { describe, expect, it } from 'vitest';

import { ThreadSessions } from './thread-sessions.js';

const at = (thread: string | undefined, ns = 'tools:c') => ({
  configurable: {
    ...(thread === undefined ? {} : { thread_id: thread }),
    checkpoint_ns: ns,
  },
});

describe('ThreadSessions.fsForCall', () => {
  it('登記前沒有：not-attached；登記後回登記的那一個把手與位址；撤除後又沒有', () => {
    const live = new ThreadSessions();
    const fs = createFsService();
    expect(live.fsForCall(at('a'))).toEqual({ kind: 'not-attached' });
    const undo = live.register(new SessionRegistry('a'), fs);
    const found = live.fsForCall(at('a'));
    expect(found.kind === 'ok' && found.fs).toBe(fs);
    expect(found.kind === 'ok' && found.address).toEqual({ kind: 'root' });
    undo();
    expect(live.fsForCall(at('a'))).toEqual({ kind: 'not-attached' });
  });

  it('多條：依 thread_id 各拿各的把手，缺 thread_id 或誰都不認得是 ambiguous（與會話查找同一個答案）', () => {
    const live = new ThreadSessions();
    const fsA = createFsService();
    const fsB = createFsService();
    live.register(new SessionRegistry('a'), fsA);
    live.register(new SessionRegistry('b'), fsB);
    const fromB = live.fsForCall(at('b'));
    expect(fromB.kind === 'ok' && fromB.fs).toBe(fsB);
    const fromA = live.fsForCall(at('a'));
    expect(fromA.kind === 'ok' && fromA.fs).toBe(fsA);
    expect(live.fsForCall(at(undefined))).toEqual({ kind: 'ambiguous', count: 2 });
    expect(live.forCall(at(undefined))).toEqual({ kind: 'ambiguous', count: 2 });
    expect(live.fsForCall(at('stranger'))).toEqual({ kind: 'ambiguous', count: 2 });
  });

  it('只剩一條：thread_id 不是它的 → ambiguous 數 1，拿不到別條的 fs 把手；沒帶 thread_id 照舊（#1482）', () => {
    const live = new ThreadSessions();
    const fsB = createFsService();
    const undoA = live.register(new SessionRegistry('a'), createFsService());
    live.register(new SessionRegistry('b'), fsB);
    undoA();
    expect(live.fsForCall(at('a'))).toEqual({ kind: 'ambiguous', count: 1 });
    const own = live.fsForCall(at('b'));
    expect(own.kind === 'ok' && own.fs).toBe(fsB);
    const without = live.fsForCall(at(undefined));
    expect(without.kind === 'ok' && without.fs).toBe(fsB);
  });

  it('子代理與背景子代理的呼叫身分（<root>/<runId>）挑到的是 root 那條 thread 的把手', () => {
    const live = new ThreadSessions();
    const fsA = createFsService();
    const fsB = createFsService();
    const sessionsA = new SessionRegistry('a');
    live.register(sessionsA, fsA);
    live.register(new SessionRegistry('b'), fsB);
    // 背景子代理的日誌 id 是 `<root>/<runId>`：先讓 a 這邊開出那份日誌，`ownsThread` 才認得它。
    sessionsA.open({ kind: 'subagent', runId: 'run-1' } as never);
    const found = live.fsForCall(at('a/run-1', 'tools:x|tools:y'));
    expect(found.kind === 'ok' && found.fs).toBe(fsA);
  });

  it('登記時沒給把手：挑中了也回 not-attached（對模型是同一句話），但會話查找照常找得到', () => {
    const live = new ThreadSessions();
    const sessions = new SessionRegistry('a');
    live.register(sessions);
    expect(live.fsForCall(at('a'))).toEqual({ kind: 'not-attached' });
    const found = live.forCall(at('a'));
    expect(found.kind === 'ok' && found.log).toBe(sessions.root);
  });

  it('算不出位址：unknown-caller（沒有 checkpoint_ns）', () => {
    const live = new ThreadSessions();
    live.register(new SessionRegistry('a'), createFsService());
    expect(live.fsForCall({ configurable: { thread_id: 'a' } })).toEqual({
      kind: 'unknown-caller',
    });
  });

  it('同一個 root id 重組：把手與會話一起被取代；舊的 undo 只撤自己', () => {
    const live = new ThreadSessions();
    const first = createFsService();
    const second = createFsService();
    const undoFirst = live.register(new SessionRegistry('same'), first);
    live.register(new SessionRegistry('same'), second);
    expect(live.size).toBe(1);
    undoFirst();
    expect(live.size).toBe(1);
    const found = live.fsForCall(at('same'));
    expect(found.kind === 'ok' && found.fs).toBe(second);
  });
});

describe('ThreadSessions.fsForThread（#1774）', () => {
  it('依 root 會話 id 精確找回登記的那一個把手；撤除後、沒登記過的 id 都是 undefined', () => {
    const live = new ThreadSessions();
    const fsA = createFsService();
    const fsB = createFsService();
    expect(live.fsForThread('a')).toBeUndefined();
    const undoA = live.register(new SessionRegistry('a'), fsA);
    live.register(new SessionRegistry('b'), fsB);
    expect(live.fsForThread('a')).toBe(fsA);
    expect(live.fsForThread('b')).toBe(fsB);
    expect(live.fsForThread('c')).toBeUndefined();
    undoA();
    expect(live.fsForThread('a')).toBeUndefined();
  });

  it('只剩一條時也不退路：不是它的 id 不拿它充數（fs 是安全邊界，#1482）；登記時沒給把手也是 undefined', () => {
    const live = new ThreadSessions();
    const fsB = createFsService();
    live.register(new SessionRegistry('b'), fsB);
    expect(live.size).toBe(1);
    expect(live.fsForThread('a')).toBeUndefined();
    expect(live.fsForThread('b')).toBe(fsB);
    live.register(new SessionRegistry('bare'));
    expect(live.fsForThread('bare')).toBeUndefined();
  });

  it('同一個 root id 重組：拿到的是取代後的把手；舊的 undo 只撤自己', () => {
    const live = new ThreadSessions();
    const first = createFsService();
    const second = createFsService();
    const undoFirst = live.register(new SessionRegistry('same'), first);
    live.register(new SessionRegistry('same'), second);
    undoFirst();
    expect(live.fsForThread('same')).toBe(second);
  });
});

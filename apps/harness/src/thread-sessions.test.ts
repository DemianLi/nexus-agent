/**
 * `ThreadSessions`：行程級的「活著的 thread」登記簿（[#1463](https://github.com/DemianLi/nexus-agent/issues/1463)）。
 *
 * 只量它自己的契約——登記、撤除、同一個 root id 重組時的取代、undo 只撤自己、查找走 core 的 `pickSessionForCall`。
 * 接進組裝與三個入口的量法在 `todo-on-tree.test.ts`。
 */

import { SessionRegistry } from '@nexus/core';
import { describe, expect, it } from 'vitest';

import { ThreadSessions } from './thread-sessions.js';

const at = (thread: string | undefined) => ({
  configurable: {
    ...(thread === undefined ? {} : { thread_id: thread }),
    checkpoint_ns: 'tools:c',
  },
});

describe('ThreadSessions', () => {
  it('登記前沒有：not-attached；登記後找得到；撤除後又沒有', () => {
    const live = new ThreadSessions();
    const a = new SessionRegistry('a');
    expect(live.forCall(at('a'))).toEqual({ kind: 'not-attached' });
    const undo = live.register(a);
    expect(live.size).toBe(1);
    const found = live.forCall(at('a'));
    expect(found.kind === 'ok' && found.log).toBe(a.root);
    undo();
    expect(live.size).toBe(0);
    expect(live.forCall(at('a'))).toEqual({ kind: 'not-attached' });
  });

  it('多條：依 thread_id 各找各的，缺 thread_id 是 ambiguous', () => {
    const live = new ThreadSessions();
    const a = new SessionRegistry('a');
    const b = new SessionRegistry('b');
    live.register(a);
    live.register(b);
    const fromB = live.forCall(at('b'));
    expect(fromB.kind === 'ok' && fromB.log).toBe(b.root);
    expect(live.forCall(at(undefined))).toEqual({ kind: 'ambiguous', count: 2 });
  });

  it('同一個 root id 重組：後登記的取代先登記的；舊的 undo 只撤自己，不誤撤新的', () => {
    const live = new ThreadSessions();
    const first = new SessionRegistry('same');
    const second = new SessionRegistry('same');
    const undoFirst = live.register(first);
    const undoSecond = live.register(second);
    expect(live.size).toBe(1);
    undoFirst();
    expect(live.size).toBe(1);
    const found = live.forCall(at('same'));
    expect(found.kind === 'ok' && found.log).toBe(second.root);
    undoSecond();
    expect(live.size).toBe(0);
  });

  it('undo 冪等：撤兩次不會撤到之後登記的同 id 那一份', () => {
    const live = new ThreadSessions();
    const first = new SessionRegistry('same');
    const undoFirst = live.register(first);
    undoFirst();
    const second = new SessionRegistry('same');
    live.register(second);
    undoFirst();
    expect(live.size).toBe(1);
  });
});

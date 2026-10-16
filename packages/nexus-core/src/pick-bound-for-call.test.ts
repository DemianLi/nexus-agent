/**
 * `pickBoundForCall`：「先挑出那一筆登記、各取所需」（[#1466](https://github.com/DemianLi/nexus-agent/issues/1466)）。
 *
 * 會話日誌（`pickSessionForCall`）與 fs 把手（宿主的 `fsForCall`）共用它，所以「多條 thread 同時活著時依 `thread_id` 認出主人」
 * 的語意只在這裡寫一次。#1418／#1463 的斷言在 `session-lookup-by-thread.test.ts`，這一檔不改它們，只量新拆出來的這一層：
 * 挑出來的是**原物**（不是複本）、不碰日誌、與 `pickSessionForCall` 對同樣的輸入給同樣的判別。
 */

import { describe, expect, it } from 'vitest';

import { pickBoundForCall, pickSessionForCall } from './registry.js';
import { SessionRegistry } from './session-registry.js';

const at = (thread: string | undefined, ns = 'tools:x') => ({
  configurable: {
    ...(thread === undefined ? {} : { thread_id: thread }),
    checkpoint_ns: ns,
  },
});

interface Entry {
  readonly label: string;
  readonly sessions: SessionRegistry;
}
const entryOf = (id: string): Entry => ({
  label: `entry-${id}`,
  sessions: new SessionRegistry(id),
});
const sessionsOf = (entry: Entry): SessionRegistry => entry.sessions;

describe('pickBoundForCall', () => {
  it('一筆都沒有：not-attached', () => {
    expect(pickBoundForCall([], sessionsOf, at('a'))).toEqual({ kind: 'not-attached' });
  });

  it('只有一筆：不看 thread_id，回原物與位址', () => {
    const only = entryOf('only');
    for (const config of [at(undefined), at('somebody-else')]) {
      const picked = pickBoundForCall([only], sessionsOf, config);
      expect(picked.kind === 'ok' && picked.bound).toBe(only);
      expect(picked.kind === 'ok' && picked.address).toEqual({ kind: 'root' });
    }
  });

  it('只有一筆、要求核對（verifySingle，#1482）：帶 thread_id 而它不屬於這一筆 → ambiguous 數 1；屬於、或沒帶 thread_id → 照舊挑它', () => {
    const only = entryOf('only');
    const verify = { verifySingle: true } as const;
    expect(pickBoundForCall([only], sessionsOf, at('somebody-else'), verify)).toEqual({
      kind: 'ambiguous',
      count: 1,
    });
    // 屬於這一筆：自己的 root id，與背景子代理的 `<root>/<runId>`（日誌先出生，`ownsThread` 才認得）。
    const own = pickBoundForCall([only], sessionsOf, at('only'), verify);
    expect(own.kind === 'ok' && own.bound).toBe(only);
    only.sessions.open({ kind: 'subagent', runId: 'run-1' } as never);
    const background = pickBoundForCall([only], sessionsOf, at('only/run-1'), verify);
    expect(background.kind === 'ok' && background.bound).toBe(only);
    // 沒帶 thread_id 的呼叫無從核對，行為不變（#1463 的相容層、沒有 thread_id 的舊呼叫）。
    const without = pickBoundForCall([only], sessionsOf, at(undefined), verify);
    expect(without.kind === 'ok' && without.bound).toBe(only);
    // 算不出位址仍是 unknown-caller，核對不改變這個判別。
    expect(pickBoundForCall([only], sessionsOf, undefined, verify)).toEqual({
      kind: 'unknown-caller',
    });
  });

  it('多筆時 verifySingle 不改任何事（它只管剩一筆的那一格）', () => {
    const a = entryOf('a');
    const b = entryOf('b');
    const verify = { verifySingle: true } as const;
    const fromB = pickBoundForCall([a, b], sessionsOf, at('b'), verify);
    expect(fromB.kind === 'ok' && fromB.bound).toBe(b);
    expect(pickBoundForCall([a, b], sessionsOf, at('stranger'), verify)).toEqual({
      kind: 'ambiguous',
      count: 2,
    });
  });

  it('多筆：依 thread_id 挑恰好擁有它的那一筆；缺、不認得是 ambiguous', () => {
    const a = entryOf('a');
    const b = entryOf('b');
    const fromB = pickBoundForCall([a, b], sessionsOf, at('b'));
    expect(fromB.kind === 'ok' && fromB.bound).toBe(b);
    expect(pickBoundForCall([a, b], sessionsOf, at(undefined))).toEqual({
      kind: 'ambiguous',
      count: 2,
    });
    expect(pickBoundForCall([a, b], sessionsOf, at('stranger'))).toEqual({
      kind: 'ambiguous',
      count: 2,
    });
  });

  it('算不出位址：unknown-caller（一筆與多筆都是）', () => {
    const a = entryOf('a');
    const b = entryOf('b');
    expect(pickBoundForCall([a], sessionsOf, undefined)).toEqual({ kind: 'unknown-caller' });
    expect(pickBoundForCall([a, b], sessionsOf, { configurable: { thread_id: 'a' } })).toEqual({
      kind: 'unknown-caller',
    });
  });

  it('只迭代一次：Map.values() 這種單趟迭代器也行', () => {
    const a = entryOf('a');
    const b = entryOf('b');
    const map = new Map([
      ['a', a],
      ['b', b],
    ]);
    const picked = pickBoundForCall(map.values(), sessionsOf, at('a'));
    expect(picked.kind === 'ok' && picked.bound).toBe(a);
  });

  it('不碰日誌：subagent 位址挑完之後那份日誌還沒出生；pickSessionForCall 才 open', () => {
    const entry = entryOf('a');
    const config = at('a', 'tools:spawn-1|tools:its-call');
    const picked = pickBoundForCall([entry], sessionsOf, config);
    expect(picked.kind).toBe('ok');
    expect(entry.sessions.list()).toHaveLength(1);
    const opened = pickSessionForCall([entry.sessions], config);
    expect(opened.kind).toBe('ok');
    expect(entry.sessions.list()).toHaveLength(2);
  });

  it('與 pickSessionForCall 對同樣的輸入給同樣的判別', () => {
    const a = new SessionRegistry('a');
    const b = new SessionRegistry('b');
    for (const config of [at('a'), at('b'), at(undefined), at('x'), undefined]) {
      const viaBound = pickBoundForCall([a, b], (s) => s, config);
      const viaSession = pickSessionForCall([a, b], config);
      expect(viaBound.kind).toBe(viaSession.kind);
    }
  });
});

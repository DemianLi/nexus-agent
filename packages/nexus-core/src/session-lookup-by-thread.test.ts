/**
 * `sessions.forCall` 依 thread 挑會話註冊表（[#1418](https://github.com/DemianLi/nexus-agent/issues/1418) 驗收 A、B）。
 *
 * 插件只套一次時，同一份 registry 會綁好幾張會話註冊表（每條 thread 一張）。以前綁了不只一張就回 `ambiguous`——
 * 那個答案在「一條 thread 一次組裝」時沒有人走到；現在要靠 `configurable.thread_id` 挑出擁有這次呼叫的那一張，
 * 挑不出來才仍然是 `ambiguous`（寧可明說也不猜：猜錯的下場是一條 thread 的工具寫進另一條 thread 的日誌）。
 *
 * `thread_id` 到得了工具與 middleware，由 `apps/harness/src/thread-id-reaches-handlers.test.ts` 在真組裝上實測過
 * （根 agent、同步子代理、背景子代理）；這一檔用同樣形狀的設定直接餵 `forCall`。
 */

import { describe, expect, it } from 'vitest';

import { createRegistry, pickSessionForCall } from './registry.js';
import { BACKGROUND_SESSION_CONFIG_KEY, callThreadId } from './session-address.js';
import { SessionRegistry } from './session-registry.js';

/** 一次工具呼叫在某條 thread 的某個圖位置：`checkpoint_ns` 最後一段是這次呼叫自己。 */
const at = (thread: string | undefined, ns: string, extra: Record<string, unknown> = {}) => ({
  configurable: {
    ...(thread === undefined ? {} : { thread_id: thread }),
    checkpoint_ns: ns,
    ...extra,
  },
});

function twoThreads() {
  const registry = createRegistry();
  const a = new SessionRegistry('thread-a');
  const b = new SessionRegistry('thread-b');
  registry.sessions.bind(a);
  registry.sessions.bind(b);
  return { registry, a, b };
}

describe('callThreadId', () => {
  it('讀 configurable.thread_id；缺、空字串、不是字串都是 undefined', () => {
    expect(callThreadId(at('t', 'tools:x'))).toBe('t');
    expect(callThreadId(at(undefined, 'tools:x'))).toBeUndefined();
    expect(callThreadId({ configurable: { thread_id: '' } })).toBeUndefined();
    expect(callThreadId({ configurable: { thread_id: 7 } })).toBeUndefined();
    expect(callThreadId(undefined)).toBeUndefined();
    expect(callThreadId({})).toBeUndefined();
  });
});

describe('forCall 綁了一張：與逐條 thread 之前相同', () => {
  it('不看 thread_id，沒有也認得（手搭的測試呼叫）', () => {
    const registry = createRegistry();
    const only = new SessionRegistry('only');
    registry.sessions.bind(only);
    const found = registry.sessions.forCall(at(undefined, 'tools:x'));
    expect(found).toMatchObject({ kind: 'ok', address: { kind: 'root' } });
    expect(found.kind === 'ok' && found.log).toBe(only.root);
    // thread_id 與它的 root 不同也照樣認：只有一張就是它。
    const other = registry.sessions.forCall(at('somebody-else', 'tools:x'));
    expect(other.kind === 'ok' && other.log).toBe(only.root);
  });
});

describe('forCall 綁了兩張：依 thread_id 挑', () => {
  it('根 agent：各自解到各自那一張的 root，不回 ambiguous', () => {
    const { registry, a, b } = twoThreads();
    const fromA = registry.sessions.forCall(at('thread-a', 'tools:call-1'));
    const fromB = registry.sessions.forCall(at('thread-b', 'tools:call-1'));
    expect(fromA.kind === 'ok' && fromA.log).toBe(a.root);
    expect(fromB.kind === 'ok' && fromB.log).toBe(b.root);
  });

  it('同步子代理：沿用父 thread 的 id，子代理那一份開在自己 thread 的註冊表裡，不開在別人那裡', () => {
    const { registry, a, b } = twoThreads();
    const found = registry.sessions.forCall(at('thread-a', 'tools:spawn-1|tools:call-1'));
    expect(found).toMatchObject({
      kind: 'ok',
      address: { kind: 'subagent', runId: 'tools:spawn-1' },
    });
    expect(found.kind === 'ok' && found.log.sessionId).toBe('thread-a/tools:spawn-1');
    expect(a.list()).toHaveLength(2);
    expect(b.list()).toHaveLength(1);
  });

  it('背景子代理：thread_id 是它自己的日誌 id（<root>/<runId>）加背景身分鍵，挑得到擁有它的那一張', () => {
    const { registry, a, b } = twoThreads();
    // 拉起背景那一方先把日誌開好（`BackgroundSubagentHost` 收件匣接受那一刻）。
    const log = a.open({ kind: 'subagent', runId: 'bg-1' });
    expect(log.sessionId).toBe('thread-a/bg-1');
    const found = registry.sessions.forCall(
      at('thread-a/bg-1', 'tools:inner', { [BACKGROUND_SESSION_CONFIG_KEY]: 'bg-1' }),
    );
    expect(found).toMatchObject({ kind: 'ok', address: { kind: 'subagent', runId: 'bg-1' } });
    expect(found.kind === 'ok' && found.log).toBe(log);
    expect(b.list()).toHaveLength(1);
  });

  it('沒帶 thread_id：仍是 ambiguous（不猜）', () => {
    const { registry } = twoThreads();
    expect(registry.sessions.forCall(at(undefined, 'tools:call-1'))).toEqual({
      kind: 'ambiguous',
      count: 2,
    });
  });

  it('thread_id 沒有任何一張認得：ambiguous', () => {
    const { registry } = twoThreads();
    expect(registry.sessions.forCall(at('thread-z', 'tools:call-1'))).toEqual({
      kind: 'ambiguous',
      count: 2,
    });
  });

  it('兩張都認得同一個 thread_id（root id 撞了）：ambiguous，不挑第一張', () => {
    const registry = createRegistry();
    registry.sessions.bind(new SessionRegistry('same'));
    registry.sessions.bind(new SessionRegistry('same'));
    expect(registry.sessions.forCall(at('same', 'tools:call-1'))).toEqual({
      kind: 'ambiguous',
      count: 2,
    });
  });

  it('挑得出張、但這次呼叫不在圖裡（沒有 checkpoint_ns）：unknown-caller，不猜成 root', () => {
    const { registry } = twoThreads();
    expect(registry.sessions.forCall({ configurable: { thread_id: 'thread-a' } })).toEqual({
      kind: 'unknown-caller',
    });
  });

  it('解綁一張之後只剩一張：回到不看 thread_id', () => {
    const registry = createRegistry();
    const a = new SessionRegistry('thread-a');
    const b = new SessionRegistry('thread-b');
    registry.sessions.bind(a);
    const unbind = registry.sessions.bind(b);
    unbind();
    const found = registry.sessions.forCall(at(undefined, 'tools:call-1'));
    expect(found.kind === 'ok' && found.log).toBe(a.root);
  });
});

describe('一份 registry 沒綁任何會話', () => {
  it('not-attached', () => {
    expect(createRegistry().sessions.forCall(at('t', 'tools:x'))).toEqual({ kind: 'not-attached' });
  });
});

/**
 * `pickSessionForCall` 是挑法的**唯一一份實作**（[#1463](https://github.com/DemianLi/nexus-agent/issues/1463)）：相容層的
 * `registry.sessions.forCall` 與樹上的會話查找服務都是它。上面那幾組走的是前者；這一組直接餵它可迭代的註冊表，
 * 證明樹上那一支（餵 `Map#values()`、只迭代一次）與相容層同一個答案。
 */
describe('pickSessionForCall：兩個呼叫者共用的那一支', () => {
  it('沒有註冊表：not-attached', () => {
    expect(pickSessionForCall([], at('t', 'tools:x'))).toEqual({ kind: 'not-attached' });
  });

  it('一張：不看 thread_id；算不出位址是 unknown-caller', () => {
    const only = new SessionRegistry('only');
    const found = pickSessionForCall([only], at('somebody-else', 'tools:x'));
    expect(found.kind === 'ok' && found.log).toBe(only.root);
    expect(pickSessionForCall([only], undefined)).toEqual({ kind: 'unknown-caller' });
  });

  it('多張：依 thread_id 挑恰好一張，其餘三種都是 ambiguous 並帶份數', () => {
    const a = new SessionRegistry('thread-a');
    const b = new SessionRegistry('thread-b');
    const live = new Map([
      ['thread-a', a],
      ['thread-b', b],
    ]);
    const fromB = pickSessionForCall(live.values(), at('thread-b', 'tools:c'));
    expect(fromB.kind === 'ok' && fromB.log).toBe(b.root);
    const fromA = pickSessionForCall(live.values(), at('thread-a', 'tools:c'));
    expect(fromA.kind === 'ok' && fromA.log).toBe(a.root);
    for (const config of [at(undefined, 'tools:c'), at('thread-z', 'tools:c')]) {
      expect(pickSessionForCall(live.values(), config)).toEqual({ kind: 'ambiguous', count: 2 });
    }
  });

  it('只迭代一次：一個只能走一遍的迭代器也行', () => {
    const a = new SessionRegistry('thread-a');
    const b = new SessionRegistry('thread-b');
    function* once() {
      yield a;
      yield b;
    }
    const found = pickSessionForCall(once(), at('thread-b', 'tools:c'));
    expect(found.kind === 'ok' && found.log).toBe(b.root);
  });

  it('與相容層的 sessions.forCall 同一個答案（同一份輸入逐格比）', () => {
    const registry = createRegistry();
    const a = new SessionRegistry('thread-a');
    const b = new SessionRegistry('thread-b');
    registry.sessions.bind(a);
    registry.sessions.bind(b);
    for (const config of [
      at('thread-a', 'tools:c'),
      at('thread-b', 'tools:s|tools:c'),
      at(undefined, 'tools:c'),
      at('thread-z', 'tools:c'),
      { configurable: { thread_id: 'thread-a' } },
    ]) {
      expect(pickSessionForCall([a, b], config)).toEqual(registry.sessions.forCall(config));
    }
  });
});

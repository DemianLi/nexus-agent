/**
 * 會話投影的折疊器與註冊點（[#1026](https://github.com/DemianLi/nexus-agent/issues/1026)）。
 *
 * 釘四件事：即時與歷史是**同一個**折疊（結構性，不是巧合一致）、seed 不發變更、單元拋錯只停用自己、
 * `stateVersion` 與 key 的註冊規則。
 */

import { describe, expect, it } from 'vitest';
import {
  childProjectionUnits,
  createProjectionFold,
  normalizeProjectionUnit,
} from './projections.js';
import type { ProjectionUnit } from './projections.js';
import type { PluginOrigin } from './plugin.js';
import { createRegistry } from './registry.js';
import { SessionLog } from './session-log.js';
import type { SessionEvent } from './session-log.js';

/** 數 `model/usage` 的單元；view 比 state 窄（只送 `calls`）。 */
function counter(
  key = 'calls',
  stateVersion = 1,
): ProjectionUnit<{ n: number; secret: string }, { calls: number }> {
  return {
    key,
    stateVersion,
    init: () => ({ n: 0, secret: 'host-only' }),
    apply: (state, event) => (event.type === 'model/usage' ? { ...state, n: state.n + 1 } : state),
    view: (state) => ({ calls: state.n }),
  };
}

/** 一串事件：兩顆相干（model/usage）夾兩顆不相干。 */
function sampleEvents(): SessionEvent[] {
  const log = new SessionLog('proj');
  log.append('turn/start', { kind: 'message', text: '嗨' });
  log.append('model/usage', { inputTokens: 1, outputTokens: 1, totalTokens: 2 });
  log.append('model/start', {});
  log.append('model/usage', { inputTokens: 1, outputTokens: 1, totalTokens: 2 });
  log.append('turn/end', {});
  return [...log.events];
}

describe('折疊器：即時與歷史是同一個', () => {
  it('逐顆 push 的最終值 = 一次 fold 的值', () => {
    const events = sampleEvents();
    const fold = createProjectionFold([counter()]);
    const live = fold.session();
    for (const event of events) live.push(event);
    expect(live.current()).toEqual(fold.fold(events));
    expect(fold.fold(events)).toEqual([{ key: 'calls', version: 1, view: { calls: 2 } }]);
  });

  it('seed 的事件不發變更；之後的 push 接著算（resume 或重啟後才接上）', () => {
    const events = sampleEvents();
    const fold = createProjectionFold([counter()]);
    const seeded = fold.session(events.slice(0, 3)); // 到第一顆 model/usage 與 model/start
    expect(seeded.current()).toEqual([{ key: 'calls', version: 1, view: { calls: 1 } }]);
    // 對照：從 init 起跳的話第一顆 push 算出來是 1，這裡必須是 2。
    const changed = seeded.push(events[3]!);
    expect(changed).toEqual([{ key: 'calls', version: 1, view: { calls: 2 } }]);
    // 等於對全部 N+1 顆做 fold。
    expect(seeded.current()).toEqual(fold.fold(events.slice(0, 4)));
  });

  it('不相干的事件不回變更；view 沒變也不回（state 窄化）', () => {
    const fold = createProjectionFold([counter()]);
    const live = fold.session();
    const [start, usage, modelStart] = sampleEvents().slice(0, 3) as [
      SessionEvent,
      SessionEvent,
      SessionEvent,
    ];
    expect(live.push(start)).toEqual([]);
    expect(live.push(usage)).toHaveLength(1);
    expect(live.push(modelStart)).toEqual([]);

    // state 的參照每次都變、但 view 的內容不變：不算變更。
    const noisy: ProjectionUnit<number, { flag: boolean }> = {
      key: 'noisy',
      stateVersion: 0,
      init: () => 0,
      apply: (n) => n + 1,
      view: () => ({ flag: true }),
    };
    const session = createProjectionFold([noisy]).session();
    expect(session.push(start)).toHaveLength(0); // seed 後的第一次 view 已記下，內容沒變
  });

  it('apply 回同一個參照就不算 view（零下游工作）', () => {
    let viewCalls = 0;
    const unit: ProjectionUnit<object, number> = {
      key: 'lazy',
      stateVersion: 0,
      init: () => ({}),
      apply: (state) => state,
      view: () => (viewCalls += 1),
    };
    const live = createProjectionFold([unit]).session();
    const afterSeed = viewCalls; // seed 之後的第一次 view
    for (const event of sampleEvents()) live.push(event);
    expect(viewCalls).toBe(afterSeed);
  });

  it('每個註冊的單元都有一筆，包括沒折到任何事件的', () => {
    const fold = createProjectionFold([counter('a'), counter('b', 3)]);
    expect(fold.fold([])).toEqual([
      { key: 'a', version: 1, view: { calls: 0 } },
      { key: 'b', version: 3, view: { calls: 0 } },
    ]);
  });

  it('值是純 JSON 的拷貝：改單元手上的物件不會回頭改已交出去的值', () => {
    const shared = { items: [1] };
    const unit: ProjectionUnit<typeof shared, typeof shared> = {
      key: 'shared',
      stateVersion: 0,
      init: () => shared,
      apply: (state) => state,
      view: (state) => state,
    };
    const [value] = createProjectionFold([unit]).fold([]);
    shared.items.push(2);
    expect(value!.view).toEqual({ items: [1] });
  });
});

describe('折疊器：單元拋錯只停用自己', () => {
  const boom = (
    key: string,
    when: 'apply' | 'view' | 'init' | 'json',
  ): ProjectionUnit<number, unknown> => ({
    key,
    stateVersion: 0,
    init: () => {
      if (when === 'init') throw new Error('init 壞了');
      return 0;
    },
    apply: (n, event) => {
      if (when === 'apply' && event.type === 'model/start') throw new Error('apply 壞了');
      return event.type === 'model/usage' ? n + 1 : n;
    },
    view: (n) => {
      if (when === 'view' && n === 1) throw new Error('view 壞了');
      if (when === 'json') return undefined;
      return n;
    },
  });

  it.each(['apply', 'view'] as const)(
    '%s 拋：該 key 變成失敗、別的單元照常，之後不再重拋',
    (when) => {
      const failures: string[] = [];
      const fold = createProjectionFold([boom('bad', when), counter()], {
        onFailure: (key) => failures.push(key),
      });
      const live = fold.session();
      const seen: string[] = [];
      for (const event of sampleEvents()) {
        for (const value of live.push(event)) seen.push(`${value.key}${value.failed ? '!' : ''}`);
      }
      expect(failures).toEqual(['bad']);
      expect(live.current()).toEqual([
        { key: 'bad', version: 0, view: null, failed: true },
        { key: 'calls', version: 1, view: { calls: 2 } },
      ]);
      // 失敗只回報一次（那一刻值變成「失敗」），之後不再出現。
      expect(seen.filter((entry) => entry === 'bad!')).toHaveLength(1);
    },
  );

  it('init 拋、view 不是純 JSON：從一開始就是失敗，歷史與即時一致', () => {
    for (const when of ['init', 'json'] as const) {
      const fold = createProjectionFold([boom('bad', when)]);
      expect(fold.fold(sampleEvents())).toEqual([
        { key: 'bad', version: 0, view: null, failed: true },
      ]);
      expect(fold.session().current()).toEqual([
        { key: 'bad', version: 0, view: null, failed: true },
      ]);
    }
  });

  it('歷史與即時對同一個壞單元結論相同', () => {
    const events = sampleEvents();
    const fold = createProjectionFold([boom('bad', 'apply'), counter()]);
    const live = fold.session();
    for (const event of events) live.push(event);
    expect(live.current()).toEqual(fold.fold(events));
  });
});

describe('註冊規則', () => {
  const origin: PluginOrigin = { id: 'x#0', name: 'x' };
  const other: PluginOrigin = { id: 'y#0', name: 'y' };

  it('key 重複拋，訊息指名兩個 plugin；undo 冪等且只撤自己', () => {
    const registry = createRegistry();
    const leave = registry.enter(origin);
    const undo = registry.projections.register(counter('dup'));
    leave();
    const leaveOther = registry.enter(other);
    expect(() => registry.projections.register(counter('dup'))).toThrow(
      /x#0 \(x\)[\s\S]*y#0 \(y\)/,
    );
    leaveOther();
    undo();
    undo();
    expect(registry.projections.list()).toEqual([]);
  });

  it('依註冊順序列出', () => {
    const registry = createRegistry();
    const leave = registry.enter(origin);
    registry.projections.register(counter('b'));
    registry.projections.register(counter('a'));
    leave();
    expect(registry.projections.list().map((unit) => unit.key)).toEqual(['b', 'a']);
  });

  it.each(['', 'Calls', '1calls', 'a_b', 'a--b', '-a', 'a-'])('不合格的 key %j 拋', (key) => {
    expect(() => normalizeProjectionUnit({ ...counter(), key })).toThrow(/不合/);
  });

  it.each([-1, 1.5, Number.NaN, '1' as unknown as number])('stateVersion %j 拋', (stateVersion) => {
    expect(() => normalizeProjectionUnit({ ...counter(), stateVersion })).toThrow(/stateVersion/);
  });

  it('stateVersion 0 合格；缺函式拋', () => {
    expect(normalizeProjectionUnit(counter('zero', 0)).stateVersion).toBe(0);
    expect(() =>
      normalizeProjectionUnit({ ...counter(), view: undefined as unknown as () => unknown }),
    ).toThrow(/view/);
  });
});

/** [#1028](https://github.com/DemianLi/nexus-agent/issues/1028)：單元可以宣告也折子代理自己的日誌。 */
describe('children：也折子代理', () => {
  it('預設只折 root：沒有這一格，childProjectionUnits 不挑它', () => {
    expect(normalizeProjectionUnit(counter()).children).toBeUndefined();
    expect(childProjectionUnits([counter()])).toEqual([]);
  });

  it('宣告 children: true 的單元被挑出來，保持註冊順序，且註冊後這一格還在', () => {
    const a = normalizeProjectionUnit({ ...counter('a'), children: true as const });
    const b = normalizeProjectionUnit(counter('b'));
    const c = normalizeProjectionUnit({ ...counter('c'), children: true as const });
    expect(a.children).toBe(true);
    expect(childProjectionUnits([a, b, c]).map((unit) => unit.key)).toEqual(['a', 'c']);

    const registry = createRegistry();
    const leave = registry.enter({ id: 'p#0', name: 'p' });
    registry.projections.register({ ...counter('d'), children: true as const });
    leave();
    expect(registry.projections.list()[0]?.children).toBe(true);
  });

  it.each([false, 1, 'yes'])('children 只收 true 或省略，%j 拋', (children) => {
    expect(() =>
      normalizeProjectionUnit({ ...counter(), children: children as unknown as true }),
    ).toThrow(/children/);
  });

  it('一份日誌一份折疊：兩份折疊器各折各的，狀態不互相滲', () => {
    const fold = createProjectionFold([counter()]);
    const root = fold.session();
    const child = fold.session();
    const events = sampleEvents();
    for (const event of events) root.push(event);
    for (const event of events.slice(0, 2)) child.push(event);
    expect(root.current()[0]?.view).toEqual({ calls: 2 });
    expect(child.current()[0]?.view).toEqual({ calls: 1 });
  });
});

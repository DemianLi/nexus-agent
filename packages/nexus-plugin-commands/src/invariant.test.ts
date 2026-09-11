/**
 * 命令生命週期的三條關係，**走真的 runner**。
 *
 * 不直接呼叫 installer：那樣驗不到 `register()` 有沒有把包名接上、也驗不到違規會不會
 * 真的從 `onViolation` 出來。這個檔案就是要證明**這個配套入口不是在掃空氣**——
 * 在它之前，九個 package 配套入口全是空 installer。
 *
 * 對應 [#118](https://github.com/DemianLi/nexus-agent/issues/118)。
 */

import { describe, expect, it } from 'vitest';
import { SessionLog, createInvariantRunner, createRegistry } from '@nexus/core';
import type { InvariantError, PluginOrigin } from '@nexus/core';
import { COMMANDS_INVARIANT_PACKAGE, createCommandsInvariantPlugin } from './invariant.js';

const origin: PluginOrigin = { id: 'commands-invariant#0', name: 'commands-invariant' };

/**
 * 一份日誌 ＋ 掛好的檢查。
 *
 * `seed` 是**安裝之前**就寫進去的事件，用來驗重播那一段——協調器晚於日誌成立是常態。
 */
function watched(seed: (log: SessionLog) => void = () => {}) {
  const log = new SessionLog('t');
  seed(log);

  const registry = createRegistry();
  const leave = registry.enter(origin);
  createCommandsInvariantPlugin().apply(registry);
  leave();

  const violations: string[] = [];
  const detach = createInvariantRunner({
    log,
    companions: registry.invariants.companions(),
    onViolation: (error: InvariantError) => violations.push(error.message),
    warn: (message) => {
      throw new Error(`檢查自己壞了：${message}`);
    },
  });
  return { log, violations, detach };
}

function run(log: SessionLog, commandId: string, name = 'plan'): void {
  log.append('command/run', { commandId, name, args: '', source: { kind: 'user' } });
}

function done(log: SessionLog, commandId: string, kind: 'success' | 'error' = 'success'): void {
  log.append('command/done', { commandId, kind });
}

describe('乾淨的日誌不誤報', () => {
  it('一對一對地來，一句話都不說', () => {
    const { log, violations } = watched();
    run(log, 'cmd-1');
    done(log, 'cmd-1');
    run(log, 'cmd-2');
    done(log, 'cmd-2');
    expect(violations).toEqual([]);
  });

  it('**turn 事件不歸這個配套入口管**——命令落在任何開著的輪之外是正常的', () => {
    const { log, violations } = watched();
    log.append('turn/start', { kind: 'message', text: '嗨' });
    log.append('turn/end', {});
    // 輪已經收了，命令在輪外面跑。
    run(log, 'cmd-1');
    done(log, 'cmd-1');
    expect(violations).toEqual([]);
  });

  it('最後一筆還沒落定不算違規——它的 done 可能還在路上', () => {
    const { log, violations } = watched();
    run(log, 'cmd-1');
    expect(violations).toEqual([]);
  });
});

describe('三條關係各自擋一種缺陷', () => {
  it('同一個 commandId 用第二次', () => {
    const { log, violations } = watched();
    run(log, 'cmd-1');
    done(log, 'cmd-1');
    run(log, 'cmd-1');
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/重複用了 commandId "cmd-1"/);
    expect(violations[0]).toContain(COMMANDS_INVARIANT_PACKAGE);
  });

  it('**上一個沒落定就來了下一個**——這一條才抓得到「漏了一顆 done」', () => {
    const { log, violations } = watched();
    run(log, 'cmd-1');
    // cmd-1 的 done 被漏掉了。
    run(log, 'cmd-2');
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/"cmd-1" 還沒落定/);
  });

  it('done 配不到任何 run', () => {
    const { log, violations } = watched();
    done(log, 'cmd-幽靈');
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/配不到任何 command\/run/);
  });

  it('同一個 id 落定兩次也是配不到——第二顆 done 之後那個 id 不再是開著的', () => {
    const { log, violations } = watched();
    run(log, 'cmd-1');
    done(log, 'cmd-1');
    done(log, 'cmd-1');
    // `seen` 記得這個 id，所以第二顆 done 不報「配不到」；報的是下一次重用會撞到的
    // 那一條。這裡明確斷言「不多報」，免得有人以為它在檢查一件它沒檢查的事。
    expect(violations).toEqual([]);
  });
});

describe('安裝之前就有的事件也檢查', () => {
  it('重播裡的違規照報', () => {
    const { violations } = watched((log) => {
      run(log, 'cmd-1');
      run(log, 'cmd-2');
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/"cmd-1" 還沒落定/);
  });

  it('重播完成後接著來的事件，狀態是接得上的', () => {
    const { log, violations } = watched((log) => {
      run(log, 'cmd-1');
    });
    expect(violations).toEqual([]);
    // 重播已經把 cmd-1 記成開著的，所以現在來第二個 run 要紅。
    run(log, 'cmd-2');
    expect(violations).toHaveLength(1);
  });
});

describe('接線', () => {
  it('退訂之後就不再看了', () => {
    const { log, violations, detach } = watched();
    detach();
    done(log, 'cmd-幽靈');
    expect(violations).toEqual([]);
  });

  it('認領的包名就是這個 package 自己', () => {
    const registry = createRegistry();
    const leave = registry.enter(origin);
    createCommandsInvariantPlugin().apply(registry);
    leave();
    expect(registry.invariants.companions().map((entry) => entry.packageName)).toEqual([
      '@nexus/plugin-commands',
    ]);
  });
});

/** 接上 commands 的配套入口，**日誌由呼叫的人給**——`watched` 開的是一份新的，接不了 seed。 */
function watchedLog(log: SessionLog): string[] {
  const registry = createRegistry();
  const leave = registry.enter(origin);
  createCommandsInvariantPlugin().apply(registry);
  leave();
  const violations: string[] = [];
  createInvariantRunner({
    log,
    companions: registry.invariants.companions(),
    onViolation: (error: InvariantError) => violations.push(error.message),
    warn: (message) => {
      throw new Error(`檢查自己壞了：${message}`);
    },
  });
  return violations;
}

/**
 * 續接：seed 結尾沒落定的那一個屬於上一個行程，它等不到自己的 `command/done` 了
 * （[#251](https://github.com/DemianLi/nexus-agent/issues/251) 的門 A）。
 */
describe('在 `session/end-seed` 重設', () => {
  it('上一個行程的命令沒落定，續接之後的第一個命令不吵', () => {
    const earlier = new SessionLog('t');
    run(earlier, 'cmd-a-1');
    const resumed = new SessionLog('t', { seed: earlier.events });
    const violations = watchedLog(resumed);
    run(resumed, 'cmd-b-1');
    done(resumed, 'cmd-b-1');
    expect(violations).toEqual([]);
  });

  /** 反例：拿掉重設的話就是這個樣子——同一串事件不經 seed。 */
  it('反例：同一串事件不經 seed，第二個命令報上一個還沒落定', () => {
    const log = new SessionLog('t');
    const violations = watchedLog(log);
    run(log, 'cmd-a-1');
    run(log, 'cmd-b-1');
    expect(violations).toEqual([expect.stringContaining('還沒落定')]);
  });

  /** `seen` 不跟著重設：`commandId` 帶執行器自己的亂數段，撞了就是真的撞了。 */
  it('續接之後重用上一個行程的 `commandId` 照樣報', () => {
    const earlier = new SessionLog('t');
    run(earlier, 'cmd-a-1');
    done(earlier, 'cmd-a-1');
    const resumed = new SessionLog('t', { seed: earlier.events });
    const violations = watchedLog(resumed);
    run(resumed, 'cmd-a-1');
    expect(violations).toEqual([expect.stringContaining('重複用了 commandId')]);
  });
});

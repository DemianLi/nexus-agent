/**
 * 不變量註冊表與 runner。
 *
 * 對應 [#101](https://github.com/DemianLi/nexus-agent/issues/101) 的驗收：包名保留、
 * 違規帶得出擁有者與 `INVARIANT` code、四條過濾器規則，以及**決定 (b) 的那一條**
 * ——違規真的看得見，而日誌與 agent loop 沒有被它拖下水。
 */

import { describe, expect, it, vi } from 'vitest';

import { createInvariantRunner, InvariantError } from './invariants.js';
import type { InvariantCompanion, InvariantInstaller } from './invariants.js';
import { createRegistry } from './registry.js';
import { SessionLog } from './session-log.js';

/** 包一個 installer 成註冊表那筆的形狀。 */
function companion(
  packageName: string,
  installer: InvariantInstaller,
  ordinal = 0,
): InvariantCompanion {
  return { packageName, installer, origin: { id: `test#${ordinal}`, name: 'test' } };
}

/** 一律報違規的 installer，用來看違規往哪裡去。 */
const alwaysFails: InvariantInstaller = (subject, fail) => {
  subject.observe((event) => {
    fail(`事件 ${event.type} 一律不合格`);
  });
};

describe('InvariantError', () => {
  it('帶得出擁有者、穩定 code 與固定前綴', () => {
    const error = new InvariantError('@nexus/core', 'turn 沒關');

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('INVARIANT');
    expect(error.packageName).toBe('@nexus/core');
    expect(error.message).toBe('invariant violated by "@nexus/core": turn 沒關');
  });
});

describe('註冊點', () => {
  it('同一個包名註冊兩次當場拋，訊息指得出兩次掛載', () => {
    const registry = createRegistry();
    const first = registry.enter({ id: 'a#0', name: 'a' });
    registry.invariants.register('@nexus/core', () => {});
    first();
    const second = registry.enter({ id: 'b#0', name: 'b' });

    expect(() => registry.invariants.register('@nexus/core', () => {})).toThrow(
      /a#0 \(a\).*b#0 \(b\)/s,
    );
    second();
  });

  it('撤銷之後那個名字是真的空出來', () => {
    const registry = createRegistry();
    const exit = registry.enter({ id: 'a#0', name: 'a' });
    const undo = registry.invariants.register('@nexus/core', () => {});
    expect(registry.invariants.companions()).toHaveLength(1);
    undo();

    expect(registry.invariants.companions()).toHaveLength(0);
    expect(() => registry.invariants.register('@nexus/core', () => {})).not.toThrow();
    exit();
  });

  it('registry 之外註冊不了——沒有 origin 就指不出是誰', () => {
    const registry = createRegistry();

    expect(() => registry.invariants.register('@nexus/core', () => {})).toThrow(/只能在 plugin/);
  });

  it('包名不能是空的或帶前後空白', () => {
    const registry = createRegistry();
    const exit = registry.enter({ id: 'a#0', name: 'a' });

    expect(() => registry.invariants.register('', () => {})).toThrow(/不能是空的/);
    expect(() => registry.invariants.register(' @nexus/core', () => {})).toThrow(/前後空白/);
    exit();
  });
});

describe('違規的去處（決定 b）', () => {
  it('違規進 onViolation，而不是日誌的 onListenerError', () => {
    const listenerErrors: string[] = [];
    const log = new SessionLog('t', {
      onListenerError: (message) => listenerErrors.push(message),
    });
    const violations: InvariantError[] = [];
    createInvariantRunner({
      log,
      companions: [companion('@nexus/core', alwaysFails)],
      onViolation: (error) => violations.push(error),
    });

    log.append('turn/start', { kind: 'resume' });

    expect(violations).toHaveLength(1);
    expect(violations[0]!.packageName).toBe('@nexus/core');
    expect(violations[0]!.message).toContain('turn/start 一律不合格');
    // 這是整條路的重點：日誌自己的圍堵沒有被觸發，違規沒有變成一行看不出來源的 warn。
    expect(listenerErrors).toEqual([]);
  });

  it('違規扳不倒 append，那一筆照樣進日誌（否決不了是 (b) 換來的代價）', () => {
    const log = new SessionLog('t');
    createInvariantRunner({
      log,
      companions: [companion('@nexus/core', alwaysFails)],
      onViolation: () => {},
    });

    expect(() => log.append('turn/start', { kind: 'resume' })).not.toThrow();
    expect(log.events).toHaveLength(1);
  });

  it('檢查自己拋（不是違規）走 warn，跟違規分得開', () => {
    const log = new SessionLog('t');
    const violations: InvariantError[] = [];
    const warnings: string[] = [];
    createInvariantRunner({
      log,
      companions: [
        companion('@nexus/broken', () => {
          throw new Error('這個 installer 裝不起來');
        }),
      ],
      onViolation: (error) => violations.push(error),
      warn: (message) => warnings.push(message),
    });

    expect(violations).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('@nexus/broken');
    expect(warnings[0]).toContain('安裝失敗');
  });

  it('觀察時拋非 InvariantError 也走 warn，並且不影響其他 package', () => {
    const log = new SessionLog('t');
    const violations: InvariantError[] = [];
    const warnings: string[] = [];
    createInvariantRunner({
      log,
      companions: [
        companion('@nexus/broken', (subject) => {
          subject.observe(() => {
            throw new TypeError('檢查自己有 bug');
          });
        }),
        companion('@nexus/core', alwaysFails, 1),
      ],
      onViolation: (error) => violations.push(error),
      warn: (message) => warnings.push(message),
    });

    log.append('turn/start', { kind: 'resume' });

    expect(warnings[0]).toContain('@nexus/broken');
    expect(warnings[0]).toContain('檢查自己拋了');
    // 壞掉的那條沒有讓後面那條失明。
    expect(violations).toHaveLength(1);
    expect(violations[0]!.packageName).toBe('@nexus/core');
  });

  it('安裝失敗的 package 一個 observer 都不留（裝到一半就整個不算）', () => {
    const log = new SessionLog('t');
    const seen: string[] = [];
    const warnings: string[] = [];
    createInvariantRunner({
      log,
      companions: [
        companion('@nexus/half', (subject) => {
          subject.observe((event) => seen.push(event.type));
          throw new Error('第二段裝不起來');
        }),
      ],
      warn: (message) => warnings.push(message),
    });

    log.append('turn/start', { kind: 'resume' });

    expect(warnings).toHaveLength(1);
    expect(seen).toEqual([]);
  });

  it('沒給 onViolation 時預設印到 console.error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = new SessionLog('t');
    createInvariantRunner({ log, companions: [companion('@nexus/core', alwaysFails)] });

    log.append('turn/start', { kind: 'resume' });

    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('invariant violated by "@nexus/core"'),
    );
    spy.mockRestore();
  });
});

describe('重播與退訂', () => {
  it('安裝當下先把日誌裡已經有的事件重播一遍', () => {
    const log = new SessionLog('t');
    log.append('turn/start', { kind: 'resume' });
    log.append('turn/end', {});
    const seen: number[] = [];
    createInvariantRunner({
      log,
      companions: [
        companion('@nexus/core', (subject) => {
          subject.observe((event) => seen.push(event.seq));
        }),
      ],
    });

    expect(seen).toEqual([0, 1]);
  });

  it('重播裡的違規照報，而且不會讓後面的事件失明', () => {
    const log = new SessionLog('t');
    log.append('turn/start', { kind: 'resume' });
    log.append('turn/start', { kind: 'resume' });
    const violations: InvariantError[] = [];
    createInvariantRunner({
      log,
      companions: [companion('@nexus/core', alwaysFails)],
      onViolation: (error) => violations.push(error),
    });

    log.append('turn/end', {});

    expect(violations).toHaveLength(3);
  });

  it('同一個 installer 呼叫多次 observe，每一個都收得到', () => {
    const log = new SessionLog('t');
    const seen: string[] = [];
    createInvariantRunner({
      log,
      companions: [
        companion('@nexus/core', (subject) => {
          subject.observe(() => seen.push('第一個'));
          subject.observe(() => seen.push('第二個'));
        }),
      ],
    });

    log.append('turn/start', { kind: 'resume' });

    expect(seen).toEqual(['第一個', '第二個']);
  });

  it('disposer 冪等，退訂之後不再收事件', () => {
    const log = new SessionLog('t');
    const seen: string[] = [];
    const dispose = createInvariantRunner({
      log,
      companions: [
        companion('@nexus/core', (subject) => {
          subject.observe((event) => seen.push(event.type));
        }),
      ],
    });

    dispose();
    dispose();
    log.append('turn/start', { kind: 'resume' });

    expect(seen).toEqual([]);
  });
});

describe('過濾器', () => {
  const installed = (
    selection: Parameters<typeof createInvariantRunner>[0]['selection'],
  ): string[] => {
    const log = new SessionLog('t');
    const seen: string[] = [];
    const make = (name: string, index: number): InvariantCompanion =>
      companion(
        name,
        (subject) => {
          subject.observe(() => seen.push(name));
        },
        index,
      );
    createInvariantRunner({
      log,
      companions: [make('@nexus/core', 0), make('@nexus/plugin-mcp', 1)],
      ...(selection !== undefined && { selection }),
    });
    log.append('turn/start', { kind: 'resume' });
    return seen;
  };

  it('沒給 selection 就全收', () => {
    expect(installed(undefined)).toEqual(['@nexus/core', '@nexus/plugin-mcp']);
  });

  it('enabled: false 一個都不裝', () => {
    expect(installed({ enabled: false })).toEqual([]);
  });

  it('allowlist 空＝全收，非空就只收命中的', () => {
    expect(installed({ packageAllowlist: [] })).toHaveLength(2);
    expect(installed({ packageAllowlist: ['^@nexus/plugin-'] })).toEqual(['@nexus/plugin-mcp']);
  });

  it('blocklist 蓋過 allowlist', () => {
    expect(
      installed({ packageAllowlist: ['^@nexus/'], packageBlocklist: ['^@nexus/plugin-mcp$'] }),
    ).toEqual(['@nexus/core']);
  });

  it('有效但沒命中任何 package 不算錯', () => {
    expect(installed({ packageAllowlist: ['^@other/'] })).toEqual([]);
  });

  it('pattern 不錨定，除非自己寫 ^ 與 $', () => {
    expect(installed({ packageAllowlist: ['mcp'] })).toEqual(['@nexus/plugin-mcp']);
  });

  it('無效、空白與重複的 pattern 讓 runner 當場拋，而不是被跳過', () => {
    const log = new SessionLog('t');
    const run = (selection: Parameters<typeof createInvariantRunner>[0]['selection']) => () =>
      createInvariantRunner({ log, companions: [], selection });

    expect(run({ packageAllowlist: ['('] })).toThrow(/無效的 regex/);
    expect(run({ packageAllowlist: [''] })).toThrow(/不能是空的/);
    expect(run({ packageAllowlist: [' @nexus/core'] })).toThrow(/前後空白/);
    expect(run({ packageAllowlist: ['a', 'a'] })).toThrow(/重複的 regex/);
    expect(run({ packageBlocklist: ['('] })).toThrow(/packageBlocklist/);
  });
});

/**
 * 不變量註冊表與 runner。
 *
 * 對應 [#101](https://github.com/DemianLi/nexus-agent/issues/101) 的驗收：包名保留、
 * 違規帶得出擁有者與 `INVARIANT` code、四條過濾器規則，以及**決定 (b) 的那一條**
 * ——違規真的看得見，而日誌與 agent loop 沒有被它拖下水。
 */

import { describe, expect, it, vi } from 'vitest';

import { assertInvariantSelection, createInvariantRunner, InvariantError } from './invariants.js';
import type { InvariantCompanion, InvariantInstaller, InvariantSubject } from './invariants.js';
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

  it('assertInvariantSelection 走的是同一份規則，只是不接線', () => {
    // 組裝點靠它把「選擇寫壞了」拉回載入期——runner 是每一份日誌才建的，不先驗
    // 就會拖到第一輪對話才炸。**規則不能有第二份**，所以這裡對著同樣的輸入斷言同樣的話。
    expect(() => assertInvariantSelection({})).not.toThrow();
    expect(() => assertInvariantSelection({ enabled: false })).not.toThrow();
    expect(() => assertInvariantSelection({ packageAllowlist: ['^@nexus/'] })).not.toThrow();
    expect(() => assertInvariantSelection({ packageAllowlist: ['('] })).toThrow(/無效的 regex/);
    expect(() => assertInvariantSelection({ packageBlocklist: [' a'] })).toThrow(
      /packageBlocklist[\s\S]*前後空白/,
    );
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

describe('配套入口拿到的日誌是唯讀視圖', () => {
  it('`append` 與 `subscribe` 不在型別上——**把 `log` 加寬回去的人會被這一條擋下來**', () => {
    // **這一條釘的是欄位，不是視圖。** 對 `SessionLogView` 斷言「上面沒有 append」擋不
    // 到任何人真的會犯的錯——沒有人會跑去那個介面上加一個 append。會發生的是有人把
    // `InvariantSubject.log` 的型別改回 `SessionLog`（例如照抄 `SessionSubject` 的形狀，
    // 那一份的 `log` 本來就該是可寫的），而那一改，下面兩行在 `typecheck` 當場紅。
    //
    // **它只能是型別層的。** 收窄只發生在型別上：接線那一層傳的仍然是同一個 `SessionLog`
    // 實例，所以 runtime 上 `subject.log.append` 真的還在。斷言
    // `typeof subject.log.append === 'undefined'` 會失敗，而那個失敗會被讀成「收窄沒生
    // 效」——它不是，它是「收窄本來就不在 runtime 上」。
    type SubjectLog = InvariantSubject['log'];
    type NoAppend = 'append' extends keyof SubjectLog ? never : true;
    type NoSubscribe = 'subscribe' extends keyof SubjectLog ? never : true;
    const noAppend: NoAppend = true;
    const noSubscribe: NoSubscribe = true;

    expect([noAppend, noSubscribe]).toEqual([true, true]);
  });

  it('該看得到的三樣還看得到，而且讀到的是活的日誌不是安裝當下的快照', () => {
    // 上面那條是否定的斷言，它只證明得了「拿不到什麼」。**收窄過頭的話它照樣綠**——
    // 視圖砍成空介面，`typecheck` 一樣過。這一條是正面的那一半，而且它真的跑：三樣都
    // 讀得到，而且 `length` 在事件進來之後會動。
    //
    // 「會動」這件事現在是白送的（傳的就是日誌本身），釘它是為了以後：哪天有人決定包
    // 一層真的物件，`length` 與 `events` 得是 getter。照抄成快照的話這一條會紅。
    const log = new SessionLog('s-view');
    log.append('turn/start', { kind: 'resume' });

    let sessionId = '';
    let lengthAtInstall = -1;
    let typesAtInstall: string[] = [];
    const lengthsWhileObserving: number[] = [];

    const detach = createInvariantRunner({
      log,
      companions: [
        companion('@nexus/probe', (subject) => {
          sessionId = subject.log.sessionId;
          lengthAtInstall = subject.log.length;
          typesAtInstall = subject.log.events.map((event) => event.type);
          subject.observe(() => {
            lengthsWhileObserving.push(subject.log.length);
          });
        }),
      ],
    });

    log.append('turn/end', {});
    detach();

    expect(sessionId).toBe('s-view');
    expect(lengthAtInstall).toBe(1);
    expect(typesAtInstall).toEqual(['turn/start']);
    // 重播那一筆看到 1，後來進來的那一筆看到 2——讀的是當下的日誌。
    expect(lengthsWhileObserving).toEqual([1, 2]);
  });
});

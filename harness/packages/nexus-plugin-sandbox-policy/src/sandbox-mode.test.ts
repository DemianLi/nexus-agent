/**
 * 那顆會被切的格子自己的驗收：**切換、切換留下的痕跡、委派的邊界**（`/permission` 這個命令在 `@nexus/plugin-permission-presets`）。
 *
 * **要跑起 agent 的那幾條不在這裡**——「一次切換搬得動 fence 與提示句兩個消費者」與
 * 「組裝起來之後有沒有 `/permission`」留在 `@nexus/harness` 的 `sandbox-mode.test.ts`，
 * 理由同 {@link ./index.test.ts}。
 *
 * ## 為什麼每一條驗收都是一對
 *
 * 「切到 read-only 會擋」單獨綠不了任何東西——一個**永遠**擋的實作也會綠。所以每一條都
 * 配一個反例：認不得的名字時模式**沒有**動、淨變化為零時日誌上**沒有**多出東西、
 * 收掉接線之後值照樣換得動。
 *
 * @module
 */

import { describe, expect, it } from 'vitest';

import { SessionLog, createSessionRunner } from '@nexus/core';
import type { SandboxDenial, SandboxGrant, SessionStore, SessionSubject } from '@nexus/core';

import { SandboxModeController, recordedSandboxMode } from './sandbox-mode.js';

/**
 * 一份日誌的觀察面，形狀與 `createSessionRunner` 給 installer 的一樣：先重播既有事件再收後續。
 * 沒有退訂把手（真的也沒有）——控制器拆線之後不受影響要靠自己守。
 */
const subjectOf = (log: SessionLog): Pick<SessionSubject, 'log' | 'observe'> => ({
  log,
  observe(listener) {
    for (const event of log.events) listener(event);
    log.subscribe(listener);
  },
});

describe('切換', () => {
  it('切換搬動 current 與 source，回 switched；淨變化為零回 unchanged', () => {
    const controller = new SandboxModeController('workspace-write');

    expect(controller.switchTo('read-only')).toEqual({
      kind: 'switched',
      from: 'workspace-write',
      to: 'read-only',
    });
    expect(controller.current).toBe('read-only');
    expect(controller.source()).toBe('read-only');
    // 反例：目標就是現在這一格，什麼都沒動。
    expect(controller.switchTo('read-only')).toEqual({ kind: 'unchanged', mode: 'read-only' });
  });

  it('切到已經生效的那一格什麼都不發生——照 dsh 的「淨變化為零不追加」', () => {
    const controller = new SandboxModeController('read-only');
    const log = new SessionLog('t');
    controller.attach(subjectOf(log));
    const afterAttach = log.events.length;

    expect(controller.switchTo('read-only').kind).toBe('unchanged');
    expect(log.events).toHaveLength(afterAttach);
  });
});

describe('切換寫進會話日誌', () => {
  it('接線當下就釘一顆起始值——一份沒人切過的日誌也答得出政策是哪一格', () => {
    const controller = new SandboxModeController('read-only');
    const log = new SessionLog('t');

    controller.attach(subjectOf(log));

    expect(log.events.map((event) => event.type)).toEqual(['sandbox/mode']);
    expect(log.events[0]?.data).toEqual({ mode: 'read-only' });
  });

  it('接的是一份已經有東西的日誌時，起始值照樣釘得進去', () => {
    const controller = new SandboxModeController('workspace-write');
    const log = new SessionLog('t');
    log.append('turn/start', { kind: 'message', text: '嗨' });

    controller.attach(subjectOf(log));

    // 釘的位置是**接線當下**，不是日誌開頭。讀日誌的人因此讀得出「這一輪之後政策才被
    // 宣告」與「這一輪之前就是這一格」的差別。
    expect(log.events.map((event) => event.type)).toEqual(['turn/start', 'sandbox/mode']);
  });

  it('每一次真的變了都多一顆，帶的是整個值不是差異', () => {
    const controller = new SandboxModeController('workspace-write');
    const log = new SessionLog('t');
    controller.attach(subjectOf(log));

    controller.switchTo('read-only');
    controller.switchTo('danger-full-access');

    expect(log.events.map((event) => (event.data as { mode: string }).mode)).toEqual([
      'workspace-write',
      'read-only',
      'danger-full-access',
    ]);
  });

  it('收掉接線之後就不再往那份日誌寫', () => {
    const controller = new SandboxModeController('workspace-write');
    const log = new SessionLog('t');
    const detach = controller.attach(subjectOf(log));

    detach();
    controller.switchTo('read-only');

    expect(log.events).toHaveLength(1);
    // 值照樣換了——收掉的是記帳，不是政策。
    expect(controller.current).toBe('read-only');
  });
});

describe('跟著 root 日誌走（#1494）', () => {
  const modesOf = (log: SessionLog) =>
    log.events.filter((event) => event.type === 'sandbox/mode').map((event) => event.data);

  it('接著的 root 日誌上出現一顆 sandbox/mode，格子與來源同步跟著——反例：沒接的日誌不算', () => {
    const controller = new SandboxModeController('workspace-write');
    const log = new SessionLog('t');
    controller.attach(subjectOf(log));

    log.append('sandbox/mode', { mode: 'read-only' });
    expect(controller.current).toBe('read-only');
    expect(controller.source()).toBe('read-only');

    new SessionLog('other').append('sandbox/mode', { mode: 'danger-full-access' });
    expect(controller.current).toBe('read-only');
  });

  it('source: delegation 那顆是子代理的快照，不是 root 的政策——略過；之後的一般事件照常跟', () => {
    const controller = new SandboxModeController('workspace-write');
    const log = new SessionLog('t');
    controller.attach(subjectOf(log));

    log.append('sandbox/mode', { mode: 'danger-full-access', source: 'delegation' });
    expect(controller.current).toBe('workspace-write');

    log.append('sandbox/mode', { mode: 'read-only' });
    expect(controller.current).toBe('read-only');
  });

  it('訂閱者只改格子不寫日誌；switchTo 寫的那一顆回到自己的訂閱是同一格，一次切換只多一顆', () => {
    const controller = new SandboxModeController('workspace-write');
    const log = new SessionLog('t');
    controller.attach(subjectOf(log));
    const before = log.events.length;

    log.append('sandbox/mode', { mode: 'read-only' });
    expect(log.events).toHaveLength(before + 1);

    controller.switchTo('danger-full-access');
    expect(log.events).toHaveLength(before + 2);
    expect(modesOf(log).at(-1)).toEqual({ mode: 'danger-full-access' });
    expect(controller.current).toBe('danger-full-access');
  });

  it('接了兩份 root 日誌：任何一份上的事件都跟，切換仍然每一份都寫', () => {
    const [a, b] = [new SessionLog('a'), new SessionLog('b')];
    const controller = new SandboxModeController('workspace-write');
    controller.attach(subjectOf(a));
    controller.attach(subjectOf(b));

    b.append('sandbox/mode', { mode: 'read-only' });
    expect(controller.current).toBe('read-only');

    const [aBefore, bBefore] = [a.events.length, b.events.length];
    controller.switchTo('workspace-write');
    expect(a.events).toHaveLength(aBefore + 1);
    expect(b.events).toHaveLength(bBefore + 1);
  });

  it('接線不被日誌裡的舊事件拉走：重播最後落在剛釘的這一格', () => {
    const log = new SessionLog('t');
    log.append('sandbox/mode', { mode: 'read-only' });
    const controller = new SandboxModeController('workspace-write');

    controller.attach(subjectOf(log));

    expect(controller.current).toBe('workspace-write');
    expect(modesOf(log)).toEqual([{ mode: 'read-only' }, { mode: 'workspace-write' }]);
  });

  it('日誌上最後一顆是被改壞的值：續接起算在那一格，接線（含重播）之後仍是那一格，與接線前一致', () => {
    const log = new SessionLog('t');
    log.append('sandbox/mode', { mode: 'workspace-write' });
    log.append('sandbox/mode', { mode: 'bogus' as never });
    const controller = new SandboxModeController(recordedSandboxMode(log.events));

    controller.attach(subjectOf(log));

    // 驗了值的話，重播會把格子拉回上一顆合法的 workspace-write（#1494 的 golden 抓到過這一格）。
    expect(controller.current).toBe('bogus');
  });

  it('收掉接線之後那份日誌的事件不再影響格子（手動拆線與會話收掉兩條路都是）', () => {
    const controller = new SandboxModeController('workspace-write');
    const log = new SessionLog('t');
    const detach = controller.attach(subjectOf(log));
    detach();
    log.append('sandbox/mode', { mode: 'read-only' });
    expect(controller.current).toBe('workspace-write');

    // 真的 runner：會話收掉（dispose）之後同樣不跟。
    const second = new SandboxModeController('workspace-write');
    const live = new SessionLog('live');
    const dispose = createSessionRunner({
      address: { kind: 'root' },
      log: live,
      rootLog: live,
      installers: [
        {
          origin: { kind: 'test' } as never,
          value: (subject) => second.attach(subject),
        },
      ],
    });
    live.append('sandbox/mode', { mode: 'read-only' });
    expect(second.current).toBe('read-only');
    dispose();
    live.append('sandbox/mode', { mode: 'danger-full-access' });
    expect(second.current).toBe('read-only');
  });
});

describe('委派（#326）', () => {
  const denialA: SandboxDenial = { target: '/w/a.txt', digest: 'a' };
  const denialB: SandboxDenial = { target: '/w/b.txt', digest: 'b' };
  const grantA: SandboxGrant = { mode: 'workspace-write', target: '/a.txt', denied: denialA };

  it('委派裡讀到拍下那一格，外面讀到 root 當下那格——跑到一半切換也一樣', async () => {
    const controller = new SandboxModeController('workspace-write');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));

    const inside = controller.delegate(async () => {
      await gate;
      return [controller.current, controller.source(), controller.delegatedMode];
    });
    controller.switchTo('read-only');
    // 反例：委派在跑的時候，外面讀到的是新那一格——快照沒有漏出去。
    expect(controller.current).toBe('read-only');
    expect(controller.delegatedMode).toBeUndefined();
    release();

    expect(await inside).toEqual(['workspace-write', 'workspace-write', 'workspace-write']);
  });

  it('子代理再委派：內層拍的是它的父代理那一格，不是 root 當下那格', () => {
    const controller = new SandboxModeController('danger-full-access');

    const inner = controller.delegate(() => {
      controller.switchTo('read-only');
      return controller.delegate(() => controller.current);
    });

    expect(inner).toBe('danger-full-access');
  });

  it('委派裡碰不到 root 的 grant 與 denial，出來之後原封不動', () => {
    const controller = new SandboxModeController('read-only');
    controller.recordDenial(denialA);
    controller.grant(grantA);

    controller.delegate(() => {
      expect(controller.peekGrant()).toBeUndefined();
      expect(controller.takeGrant(grantA)).toBe(false);
      expect(controller.lastDenial).toBeUndefined();
      controller.recordDenial(denialB);
      controller.grant({ mode: 'danger-full-access', target: '/b.txt', denied: denialB });
    });

    expect(controller.peekGrant()).toBe(grantA);
    expect(controller.lastDenial).toBe(denialA);
    expect(controller.takeGrant(grantA)).toBe(true);
  });
});

describe('用記下的那一格重新進委派（#827）', () => {
  const denial: SandboxDenial = { target: '/w/a.txt', digest: 'a' };
  const grant: SandboxGrant = { mode: 'workspace-write', target: '/a.txt', denied: denial };

  it('delegateAs 裡讀到記下的那一格，不是 root 現在那格——兩個方向都是', () => {
    const controller = new SandboxModeController('workspace-write');
    controller.switchTo('read-only');
    // root 已收緊，記下的是 workspace-write：照記下的。
    expect(controller.delegateAs('workspace-write', () => controller.current)).toBe(
      'workspace-write',
    );
    controller.switchTo('workspace-write');
    // root 已放寬，記下的是 read-only：仍擋住。
    expect(controller.delegateAs('read-only', () => controller.current)).toBe('read-only');
  });

  it('跟 delegate 一樣隔離 grant、denial 與委派標記；出來之後 root 的原封不動', () => {
    const controller = new SandboxModeController('read-only');
    controller.recordDenial(denial);
    controller.grant(grant);

    controller.delegateAs('read-only', () => {
      expect(controller.peekGrant()).toBeUndefined();
      expect(controller.takeGrant(grant)).toBe(false);
      expect(controller.lastDenial).toBeUndefined();
      expect(controller.delegatedMode).toBe('read-only');
    });

    expect(controller.delegatedMode).toBeUndefined();
    expect(controller.peekGrant()).toBe(grant);
    expect(controller.lastDenial).toBe(denial);
  });

  it('delegate 就是用 current 的 delegateAs', () => {
    const controller = new SandboxModeController('danger-full-access');
    expect(controller.delegate(() => controller.delegatedMode)).toBe('danger-full-access');
  });

  it('delegateFromLog：從子代理自己的日誌讀回委派那一格；取最後一顆', () => {
    const controller = new SandboxModeController('workspace-write');
    const log = new SessionLog('root/bg-1');
    log.append('sandbox/mode', { mode: 'workspace-write', source: 'delegation' });
    log.append('sandbox/mode', { mode: 'read-only', source: 'delegation' });
    controller.switchTo('danger-full-access');

    expect(controller.delegateFromLog(log, () => controller.current)).toBe('read-only');
    expect(controller.current).toBe('danger-full-access');
  });

  describe('讀回時的上限（#1739）', () => {
    const logWith = (mode: 'read-only' | 'workspace-write' | 'danger-full-access') => {
      const log = new SessionLog('root/bg-ceil');
      log.append('sandbox/mode', { mode, source: 'delegation' });
      return log;
    };
    const toWorkspaceWrite = (recorded: string): 'workspace-write' | 'read-only' =>
      recorded === 'danger-full-access' ? 'workspace-write' : 'read-only';

    it('這一輪實際用的是上限收窄後的那一格；日誌一顆都沒動，上限拿到的是日誌上記的那一格與日誌', () => {
      const controller = new SandboxModeController('danger-full-access');
      const seen: [string, string][] = [];
      controller.setDelegationCeiling((recorded, log) => {
        seen.push([recorded, log.sessionId]);
        return 'workspace-write';
      });
      const log = logWith('danger-full-access');
      const inside = controller.delegateFromLog(log, () => ({
        current: controller.current,
        delegated: controller.delegatedMode,
      }));
      expect(inside).toEqual({ current: 'workspace-write', delegated: 'workspace-write' });
      expect(seen).toEqual([['danger-full-access', 'root/bg-ceil']]);
      expect(log.events.map((event) => event.data)).toEqual([
        { mode: 'danger-full-access', source: 'delegation' },
      ]);
      expect(controller.current).toBe('danger-full-access'); // root 自己那一格不受影響
    });

    it('不用收的（上限原樣回傳）照舊；沒設上限、或拿掉上限，也照舊', () => {
      const controller = new SandboxModeController('workspace-write');
      expect(controller.delegateFromLog(logWith('read-only'), () => controller.current)).toBe(
        'read-only',
      );
      controller.setDelegationCeiling((recorded) => recorded);
      expect(controller.delegateFromLog(logWith('read-only'), () => controller.current)).toBe(
        'read-only',
      );
      controller.setDelegationCeiling(toWorkspaceWrite);
      expect(
        controller.delegateFromLog(logWith('danger-full-access'), () => controller.current),
      ).toBe('workspace-write');
      controller.setDelegationCeiling(undefined);
      expect(
        controller.delegateFromLog(logWith('danger-full-access'), () => controller.current),
      ).toBe('danger-full-access');
    });

    it('只管讀回：delegate（同步子代理拍的是 root 當下那一格）不過上限', () => {
      const controller = new SandboxModeController('danger-full-access');
      controller.setDelegationCeiling(() => 'read-only');
      expect(controller.delegate(() => controller.current)).toBe('danger-full-access');
    });

    it('上限拋錯就整輪不開跑（fail-closed），不退回沒收窄的那一格', () => {
      const controller = new SandboxModeController('danger-full-access');
      controller.setDelegationCeiling(() => {
        throw new Error('算不出上限');
      });
      let ran = false;
      expect(() =>
        controller.delegateFromLog(logWith('danger-full-access'), () => {
          ran = true;
        }),
      ).toThrow('算不出上限');
      expect(ran).toBe(false);
    });

    it('收窄之後仍在委派裡：子代理拿不到 root 的 grant、記不進 root 的 denial（升級仍被拒的前提）', () => {
      const controller = new SandboxModeController('danger-full-access');
      controller.setDelegationCeiling(toWorkspaceWrite);
      const grant: SandboxGrant = {
        mode: 'danger-full-access',
        target: '/a.txt',
        denied: undefined,
      };
      controller.grant(grant);
      const inside = controller.delegateFromLog(logWith('danger-full-access'), () => ({
        peek: controller.peekGrant(),
        take: controller.takeGrant(grant),
      }));
      expect(inside).toEqual({ peek: undefined, take: false });
      expect(controller.peekGrant()).toBe(grant);
    });
  });

  it('日誌上沒有 sandbox/mode 就拋，不拿 root 現在那格去猜', () => {
    const controller = new SandboxModeController('danger-full-access');
    const log = new SessionLog('root/bg-2');
    expect(() => controller.delegateFromLog(log, () => controller.current)).toThrow(
      /root\/bg-2.*沒有 sandbox\/mode/u,
    );
  });
});

describe('跨重啟：`SessionStore` 長出了讀介面', () => {
  it('成員是 `create`、`resume`、`list`、`open`——再長一個讀介面仍然響在這裡', () => {
    // **這一條原本是絆索**：它釘住「`SessionStore` 只有 `create`」，註解寫著長出讀介面的那天
    // 就是該把模式接回去的時候。[#251](https://github.com/DemianLi/nexus-agent/issues/251)
    // 開門的那天它照設計紅在 `typecheck`，模式也接回去了——行為的驗收在
    // `session-resume.test.ts`（上一次切成 `read-only`，`--resume` 回來還是 `read-only`）。
    //
    // 這裡留下的是形狀：**釘的是介面不是某個實作的鍵**，`createJsonlSessionStore` 回的物件
    // 上多一個 `directory` 這種與讀寫無關的欄位不該讓這裡響。
    //
    // [#665](https://github.com/DemianLi/nexus-agent/issues/665) 照設計響過一次：長出唯讀的 `list` 與
    // `open(id, 'read')`，`session-store.ts` 檔頭改寫成「讀回有兩條」。兩個都不拿租約、不寫，模式的續接仍然只走
    // `resume`，所以這裡只補名字。下一個（例如 `stat`）長出來時再回頭看一次那段檔頭。
    const KNOWN = ['create', 'resume', 'list', 'open'] as const;
    KNOWN satisfies readonly (keyof SessionStore)[];
    type Exhaustive = keyof SessionStore extends (typeof KNOWN)[number] ? true : never;
    const exhaustive: Exhaustive = true;

    expect(exhaustive).toBe(true);
  });
});

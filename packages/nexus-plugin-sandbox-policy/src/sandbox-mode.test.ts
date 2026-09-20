/**
 * 那顆會被切的格子自己的驗收：**`/sandbox` 這個命令、切換留下的痕跡、委派的邊界**。
 *
 * **要跑起 agent 的那幾條不在這裡**——「一次切換搬得動 fence 與提示句兩個消費者」與
 * 「組裝起來之後有沒有 `/sandbox`」留在 `@nexus/harness` 的 `sandbox-mode.test.ts`，
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

import { SessionLog } from '@nexus/core';
import type { SandboxDenial, SandboxGrant, SessionStore } from '@nexus/core';

import { executeSandboxCommand, SandboxModeController } from './sandbox-mode.js';

/** 跑一次 `/sandbox <引數>`，回它給人看的那句話。 */
function sandbox(controller: SandboxModeController, root: string, argument: string): string {
  return executeSandboxCommand(controller, root, argument).text;
}

describe('`/sandbox` 這個命令本身', () => {
  it('沒有引數就報告現況與可切的那幾格，**不動任何東西**', () => {
    const controller = new SandboxModeController('workspace-write');

    const text = sandbox(controller, '/w', '');

    expect(text).toContain('目前的檔案政策：workspace-write');
    expect(text).toContain('"/w"');
    expect(text).toContain('read-only');
    expect(text).toContain('danger-full-access');
    expect(controller.current).toBe('workspace-write');
  });

  it('認不得的名字回 error，**而且模式沒有動**', () => {
    const controller = new SandboxModeController('workspace-write');

    const result = executeSandboxCommand(controller, '/w', ' readonly');

    expect(result.kind).toBe('error');
    expect(result.text).toContain('認不得 "readonly"');
    // 承重的是這一句：一個把打錯字靜靜吞掉的實作會讓人以為自己切過了。
    expect(controller.current).toBe('workspace-write');
  });

  it('切到已經生效的那一格什麼都不發生——照 dsh 的「淨變化為零不追加」', () => {
    const controller = new SandboxModeController('read-only');
    const log = new SessionLog('t');
    controller.attach(log);
    const afterAttach = log.events.length;

    expect(sandbox(controller, '/w', ' read-only')).toContain('本來就是 read-only');
    expect(log.events).toHaveLength(afterAttach);
  });

  it('沒有日誌接在上面時，切換要說「這次沒留痕跡」', () => {
    const controller = new SandboxModeController('workspace-write');

    expect(sandbox(controller, '/w', ' read-only')).toContain('沒有記進任何會話日誌');
  });
});

describe('切換寫進會話日誌', () => {
  it('接線當下就釘一顆起始值——一份沒人切過的日誌也答得出政策是哪一格', () => {
    const controller = new SandboxModeController('read-only');
    const log = new SessionLog('t');

    controller.attach(log);

    expect(log.events.map((event) => event.type)).toEqual(['sandbox/mode']);
    expect(log.events[0]?.data).toEqual({ mode: 'read-only' });
  });

  it('接的是一份已經有東西的日誌時，起始值照樣釘得進去', () => {
    const controller = new SandboxModeController('workspace-write');
    const log = new SessionLog('t');
    log.append('turn/start', { kind: 'message', text: '嗨' });

    controller.attach(log);

    // 釘的位置是**接線當下**，不是日誌開頭。讀日誌的人因此讀得出「這一輪之後政策才被
    // 宣告」與「這一輪之前就是這一格」的差別。
    expect(log.events.map((event) => event.type)).toEqual(['turn/start', 'sandbox/mode']);
  });

  it('每一次真的變了都多一顆，帶的是整個值不是差異', () => {
    const controller = new SandboxModeController('workspace-write');
    const log = new SessionLog('t');
    controller.attach(log);

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
    const detach = controller.attach(log);

    detach();
    controller.switchTo('read-only');

    expect(log.events).toHaveLength(1);
    // 值照樣換了——收掉的是記帳，不是政策。
    expect(controller.current).toBe('read-only');
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

describe('跨重啟：`SessionStore` 長出了讀介面', () => {
  it('成員是 `create` 與 `resume`——再長一個讀介面仍然響在這裡', () => {
    // **這一條原本是絆索**：它釘住「`SessionStore` 只有 `create`」，註解寫著長出讀介面的那天
    // 就是該把模式接回去的時候。[#251](https://github.com/DemianLi/nexus-agent/issues/251)
    // 開門的那天它照設計紅在 `typecheck`，模式也接回去了——行為的驗收在
    // `session-resume.test.ts`（上一次切成 `read-only`，`--resume` 回來還是 `read-only`）。
    //
    // 這裡留下的是形狀：**釘的是介面不是某個實作的鍵**，`createJsonlSessionStore` 回的物件
    // 上多一個 `directory` 這種與讀寫無關的欄位不該讓這裡響。`stat`／`list` 真的長出來的那
    // 天才該響——那時候要回頭看 `session-store.ts` 檔頭那條「只抄續接要的那一條」。
    const KNOWN = ['create', 'resume'] as const;
    KNOWN satisfies readonly (keyof SessionStore)[];
    type Exhaustive = keyof SessionStore extends (typeof KNOWN)[number] ? true : never;
    const exhaustive: Exhaustive = true;

    expect(exhaustive).toBe(true);
  });
});

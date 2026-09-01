/**
 * `sessions` 通道：註冊、撤銷，與接線的三道防護。
 *
 * **這裡刻意驗「交出去的日誌寫得動」**——那是這個通道與 `invariants` 的唯一差別，
 * 而型別上兩者長得一樣，不寫這一條就沒有東西擋住有人哪天把它換成唯讀視圖。
 */

import { describe, expect, it, vi } from 'vitest';

import { createRegistry } from './registry.js';
import { SessionLog } from './session-log.js';
import { createSessionRunner } from './sessions.js';
import type { SessionEvent } from './session-log.js';
import type { SessionInstaller } from './sessions.js';

const ORIGIN = { id: 'p#0', name: 'p' };

function registryWith(...installers: SessionInstaller[]): ReturnType<typeof createRegistry> {
  const registry = createRegistry();
  const exit = registry.enter(ORIGIN);
  for (const installer of installers) registry.sessions.join(installer);
  exit();
  return registry;
}

describe('註冊', () => {
  it('apply 之外呼叫 join 會拋——沒有 origin 就指不出是誰', () => {
    const registry = createRegistry();
    expect(() => registry.sessions.join(() => undefined)).toThrow(/只能在 plugin 的 apply 裡/u);
  });

  it('註冊的參與者帶著是誰註冊的', () => {
    const installer: SessionInstaller = () => undefined;
    const registry = registryWith(installer);
    const entries = registry.sessions.installers();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.value).toBe(installer);
    expect(entries[0]?.origin).toEqual(ORIGIN);
  });

  it('undo 只撤銷那一次，而且冪等', () => {
    const registry = createRegistry();
    const exit = registry.enter(ORIGIN);
    const undoFirst = registry.sessions.join(() => undefined);
    registry.sessions.join(() => undefined);
    exit();
    expect(registry.sessions.installers()).toHaveLength(2);
    undoFirst();
    undoFirst();
    expect(registry.sessions.installers()).toHaveLength(1);
  });

  it('不具名——同一個 installer 掛兩次是兩位參與者，不是重名', () => {
    const installer: SessionInstaller = () => undefined;
    const registry = registryWith(installer, installer);
    expect(registry.sessions.installers()).toHaveLength(2);
  });
});

describe('接線', () => {
  it('交出去的日誌寫得動，而且寫進去的東西自己看得到', () => {
    const log = new SessionLog('s');
    const seen: SessionEvent[] = [];
    const registry = registryWith((subject) => {
      subject.observe((event) => seen.push(event));
      subject.log.append('turn/start', { kind: 'resume' });
    });
    createSessionRunner({ log, installers: registry.sessions.installers() });
    expect(log.length).toBe(1);
    // 安裝當下寫的那一筆走的是重播那條路：observe 是先暫存、裝完才重播的。
    expect(seen.map((event) => event.type)).toEqual(['turn/start']);
  });

  it('安裝當下寫進去的那一筆，寫的人自己當場就看得到', () => {
    // **這一條釘的是 `observe()` 當場生效**，不是等這一輪裝完才一起掛上。暫存的話，
    // 一個安裝期就記東西的參與者（`@nexus/plugin-goal` 的服務就是這種形狀）讀回來會
    // 看到一份沒有那一筆的折疊——而它接著會拿那份折疊去做決定。
    const log = new SessionLog('s');
    let seenDuringInstall = 0;
    const registry = registryWith((subject) => {
      subject.observe(() => {
        seenDuringInstall += 1;
      });
      subject.log.append('turn/start', { kind: 'resume' });
      expect(seenDuringInstall).toBe(1);
    });
    createSessionRunner({ log, installers: registry.sessions.installers() });
    expect(seenDuringInstall).toBe(1);
  });

  it('後裝的參與者看得到先裝的那位寫進去的東西', () => {
    const log = new SessionLog('s');
    const seen: string[] = [];
    const registry = registryWith(
      (subject) => {
        subject.log.append('turn/start', { kind: 'resume' });
      },
      (subject) => {
        subject.observe((event) => seen.push(event.type));
      },
    );
    createSessionRunner({ log, installers: registry.sessions.installers() });
    expect(seen).toEqual(['turn/start']);
  });

  it('安裝當下先重播日誌裡已經有的，之後才收後續', () => {
    const log = new SessionLog('s');
    log.append('turn/start', { kind: 'message', text: '先來的' });
    const seen: string[] = [];
    const registry = registryWith((subject) => {
      subject.observe((event) => seen.push(event.type));
    });
    createSessionRunner({ log, installers: registry.sessions.installers() });
    expect(seen).toEqual(['turn/start']);
    log.append('turn/end', {});
    expect(seen).toEqual(['turn/start', 'turn/end']);
  });

  it('裝到一半失敗就整個不算，其他參與者照裝', () => {
    const log = new SessionLog('s');
    const warn = vi.fn();
    const seen: string[] = [];
    const registry = registryWith(
      (subject) => {
        subject.observe(() => seen.push('壞掉的'));
        throw new Error('裝不起來');
      },
      (subject) => {
        subject.observe(() => seen.push('好的'));
      },
    );
    createSessionRunner({ log, installers: registry.sessions.installers(), warn });
    log.append('turn/end', {});
    expect(seen).toEqual(['好的']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/參與者安裝失敗/u);
  });

  it('安裝失敗的那位連已經收過事件的觀察者也一起拿掉', () => {
    const log = new SessionLog('s');
    log.append('turn/start', { kind: 'resume' });
    const warn = vi.fn();
    const seen: string[] = [];
    const registry = registryWith((subject) => {
      subject.observe((event) => seen.push(event.type));
      throw new Error('重播完才發現裝不起來');
    });
    createSessionRunner({ log, installers: registry.sessions.installers(), warn });
    // 重播那一筆它收到了——那是沒辦法收回的事實，所以斷言的是**之後**不再收。
    expect(seen).toEqual(['turn/start']);
    log.append('turn/end', {});
    expect(seen).toEqual(['turn/start']);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('參與者拋錯被圍堵成一行 warn，後面的照樣收得到', () => {
    const log = new SessionLog('s');
    const warn = vi.fn();
    const seen: string[] = [];
    const registry = registryWith(
      (subject) => {
        subject.observe(() => {
          throw new Error('看壞了');
        });
      },
      (subject) => {
        subject.observe(() => seen.push('好的'));
      },
    );
    createSessionRunner({ log, installers: registry.sessions.installers(), warn });
    log.append('turn/end', {});
    expect(seen).toEqual(['好的']);
    expect(warn.mock.calls[0]?.[0]).toMatch(/參與者拋了/u);
  });

  it('detach 先退訂再倒著收 disposer，而且冪等', () => {
    const log = new SessionLog('s');
    const order: string[] = [];
    const seen: string[] = [];
    const registry = registryWith(
      (subject) => {
        subject.observe(() => seen.push('先'));
        return () => order.push('先');
      },
      () => () => order.push('後'),
    );
    const detach = createSessionRunner({ log, installers: registry.sessions.installers() });
    detach();
    detach();
    expect(order).toEqual(['後', '先']);
    log.append('turn/end', {});
    expect(seen).toEqual([]);
  });

  it('一位參與者都沒有時不訂閱，detach 也是安全的', () => {
    const log = new SessionLog('s');
    const detach = createSessionRunner({ log, installers: [] });
    expect(() => detach()).not.toThrow();
    expect(() => log.append('turn/end', {})).not.toThrow();
  });
});

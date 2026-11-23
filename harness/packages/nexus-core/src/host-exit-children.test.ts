/**
 * 行程結束時強殺子行程的登記表（[#1542](https://github.com/DemianLi/nexus-agent/issues/1542)）。接到 git 的那一半、真的結束行程
 * 那一半在 `packages/nexus-plugin-workspace-changes/src/git-host-exit.test.ts`。
 */

import { afterEach, describe, expect, it } from 'vitest';

import { terminateHostExitChildren, trackHostExitChild } from './host-exit-children.js';

/** 一個假子行程：記下收到的訊號，`throws` 時 `kill` 拋；`pid` 預設有（沒有 pid 的見最後一組）。 */
function fakeChild(throws = false, ...pidArg: [] | [number | undefined]) {
  const pid = pidArg.length === 0 ? 4242 : pidArg[0];
  const signals: string[] = [];
  return {
    pid,
    signals,
    kill(signal: NodeJS.Signals): boolean {
      signals.push(signal);
      if (throws) throw new Error('kill 失敗');
      return true;
    },
  };
}

const untracks: (() => void)[] = [];
afterEach(() => {
  for (const untrack of untracks.splice(0)) untrack();
});

describe('一個行程只掛一個 exit listener', () => {
  it('登記 12 個只多 1 個 listener、排在別人前面；全部拿掉之後回到原值', () => {
    const someoneElse = () => undefined;
    process.on('exit', someoneElse); // 先有別人掛著，才看得出 prependListener 排在前面
    untracks.push(() => process.off('exit', someoneElse));
    const before = process.listenerCount('exit');
    const tracked = Array.from({ length: 12 }, () => trackHostExitChild(fakeChild()));
    untracks.push(...tracked);
    expect(process.listenerCount('exit')).toBe(before + 1);
    expect(process.listeners('exit')[0]).toBe(terminateHostExitChildren);
    for (const untrack of tracked) untrack();
    expect(process.listenerCount('exit')).toBe(before);
  });

  it('拿掉同一個兩次不出錯，也不會多拿掉別人的', () => {
    const before = process.listenerCount('exit');
    const a = fakeChild();
    const b = fakeChild();
    const untrackA = trackHostExitChild(a);
    untracks.push(untrackA, trackHostExitChild(b));
    untrackA();
    untrackA();
    expect(process.listenerCount('exit')).toBe(before + 1);
    terminateHostExitChildren();
    expect(a.signals).toEqual([]);
    expect(b.signals).toEqual(['SIGKILL']);
  });
});

describe('行程結束那一刻', () => {
  it('逐個送 SIGKILL；一個 kill 拋了，其餘照收', () => {
    const first = fakeChild();
    const broken = fakeChild(true);
    const last = fakeChild();
    untracks.push(trackHostExitChild(first), trackHostExitChild(broken), trackHostExitChild(last));
    expect(() => {
      terminateHostExitChildren();
    }).not.toThrow();
    expect(first.signals).toEqual(['SIGKILL']);
    expect(broken.signals).toEqual(['SIGKILL']);
    expect(last.signals).toEqual(['SIGKILL']);
  });

  it('已經拿掉的不殺', () => {
    const gone = fakeChild();
    trackHostExitChild(gone)();
    terminateHostExitChildren();
    expect(gone.signals).toEqual([]);
  });
});

describe('沒有 pid 的子行程不送訊號（#1742）', () => {
  // spawn 失敗、'error' 還沒送到的 ChildProcess 沒有 pid；這時 kill() 送的是 kill(0, sig)，整個行程群組。
  it('pid 是 undefined 的不殺，其餘照收；有 pid 的對照組照殺', () => {
    const noPid = fakeChild(false, undefined);
    const live = fakeChild();
    untracks.push(trackHostExitChild(noPid), trackHostExitChild(live));
    terminateHostExitChildren();
    expect(noPid.signals).toEqual([]);
    expect(live.signals).toEqual(['SIGKILL']);
  });

  it('守衛看的是送訊號當下的 pid，不是登記當下的：登記時還沒有、之後才有的照殺', () => {
    const late: { pid: number | undefined; signals: string[]; kill(s: NodeJS.Signals): boolean } = {
      pid: undefined,
      signals: [],
      kill(signal) {
        this.signals.push(signal);
        return true;
      },
    };
    untracks.push(trackHostExitChild(late));
    terminateHostExitChildren();
    expect(late.signals).toEqual([]);
    late.pid = 7;
    terminateHostExitChildren();
    expect(late.signals).toEqual(['SIGKILL']);
  });
});

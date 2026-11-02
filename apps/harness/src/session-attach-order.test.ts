/**
 * `composeAttachSessions` 收的順序：參與者那一步可能是非同步的（有背景 host 時要等它收完，
 * [#1482](https://github.com/DemianLi/nexus-agent/issues/1482)），不變量與遙測要等它**收完**才退，而且它拋錯也不能讓後面兩個漏收。
 *
 * 三個口都是手搭的替身，各記一筆「收完」的時刻；真的背景 host 收尾丟事件的量法在 `thread-release-order.test.ts`。
 */

import { SessionRegistry } from '@nexus/core';
import { describe, expect, it } from 'vitest';

import { composeAttachSessions } from './session-attach.js';

function attachers(order: string[], options: { sessionFails?: boolean } = {}) {
  return {
    attachTelemetry: () => async () => {
      order.push('telemetry');
    },
    attachInvariants: () => () => {
      order.push('invariants');
    },
    attachSession: () => async () => {
      // 背景 host 收尾要時間：睡一下才算收完。
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push('session');
      if (options.sessionFails === true) throw new Error('參與者收不掉');
    },
  };
}

describe('composeAttachSessions 的 detach 順序（#1482）', () => {
  it('參與者那一步（非同步）收完，才退不變量、再收遙測', async () => {
    const order: string[] = [];
    const attached = composeAttachSessions(attachers(order))(new SessionRegistry('t'));
    await attached.detach();
    expect(order).toEqual(['session', 'invariants', 'telemetry']);
  });

  it('參與者那一步拋錯：錯往外拋，不變量與遙測照收', async () => {
    const order: string[] = [];
    const attached = composeAttachSessions(attachers(order, { sessionFails: true }))(
      new SessionRegistry('t'),
    );
    await expect(attached.detach()).rejects.toThrow('參與者收不掉');
    expect(order).toEqual(['session', 'invariants', 'telemetry']);
  });
});

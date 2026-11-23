/**
 * 背景子代理狀態的 `custom` frame 怎麼折（[#867](https://github.com/DemianLi/nexus-agent/issues/867)）。
 *
 * 產出 frame 的那一半在 `apps/harness/src/subagent-status-wire.test.ts`；這裡只管折疊器：初值、整份取代、形狀不對不收、
 * 往前翻頁不動它。
 */

import { describe, expect, it } from 'vitest';

import { emptyConversation, prependEntries, reduceAll } from './conversation.js';
import type { Event } from './protocol.js';
import { SUBAGENT_STATUS } from './subagent-status.js';

let seq = 0;
function statusFrame(payload: unknown, name: string = SUBAGENT_STATUS): Event {
  const current = seq++;
  return {
    type: 'event',
    seq: current,
    event_id: `s:${current}`,
    method: 'custom',
    params: { namespace: [], timestamp: 0, data: { name, payload } },
  } as Event;
}

const fold = (...frames: Event[]) => reduceAll(emptyConversation(), frames);

describe('subagentStatus', () => {
  it('還沒收到過是 null（不下判斷）；收過一份空的才是「全部收線」', () => {
    expect(emptyConversation().subagentStatus).toBeNull();
    expect(fold(statusFrame({ items: [] })).subagentStatus).toEqual({});
  });

  it('整份取代：後到的沒列出的編號就不在了（＝收線）', () => {
    const state = fold(
      statusFrame({
        items: [
          { runId: 'bg-a', status: 'running' },
          { runId: 'bg-b', status: 'idle' },
        ],
      }),
      statusFrame({ items: [{ runId: 'bg-b', status: 'running' }] }),
    );
    expect(state.subagentStatus).toEqual({ 'bg-b': 'running' });
  });

  it('空的 items 是有效的現況：全部收線', () => {
    expect(
      fold(statusFrame({ items: [{ runId: 'bg-a', status: 'idle' }] }), statusFrame({ items: [] }))
        .subagentStatus,
    ).toEqual({});
  });

  it('形狀不對不收：items 不是陣列、名字不對（沒收過的仍是 null）；單項壞掉略過、好的照收', () => {
    expect(fold(statusFrame({ items: 'x' })).subagentStatus).toBeNull();
    const good = statusFrame({ items: [{ runId: 'bg-a', status: 'idle' }] });
    expect(fold(good, statusFrame({ items: 'x' })).subagentStatus).toEqual({ 'bg-a': 'idle' });
    expect(fold(good, statusFrame({})).subagentStatus).toEqual({ 'bg-a': 'idle' });
    expect(
      fold(good, statusFrame({ items: [{ runId: 'bg-z', status: 'idle' }] }, 'subagent/other'))
        .subagentStatus,
    ).toEqual({ 'bg-a': 'idle' });
    expect(
      fold(
        statusFrame({
          items: [
            { runId: '', status: 'idle' },
            { runId: 'bg-a', status: 'sleeping' },
            { runId: 7, status: 'idle' },
            null,
            { runId: 'bg-ok', status: 'running' },
          ],
        }),
      ).subagentStatus,
    ).toEqual({ 'bg-ok': 'running' });
  });

  it('往前翻頁不動它：它是現在的事', () => {
    const now = fold(statusFrame({ items: [{ runId: 'bg-a', status: 'running' }] }));
    const earlier = fold(statusFrame({ items: [{ runId: 'bg-old', status: 'idle' }] }));
    expect(prependEntries(now, earlier).subagentStatus).toEqual({ 'bg-a': 'running' });
    expect(prependEntries(fold(), earlier).subagentStatus).toBeNull();
  });
});

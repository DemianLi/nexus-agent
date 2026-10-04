/**
 * 子代理目錄的 `custom` frame 怎麼折（[#1023](https://github.com/DemianLi/nexus-agent/issues/1023)）。
 *
 * 產出 frame 的那一半（即時與歷史）在 `apps/harness/src/subagent-session-link.test.ts`；這裡只管折疊器：掛到 `callId` 那張卡上、
 * 卡之後的更新不弄丟它、卡不在或形狀不對不收。
 */

import { describe, expect, it } from 'vitest';

import { emptyConversation, reduceAll } from './conversation.js';
import type { ToolEntry } from './conversation.js';
import type { Event } from './protocol.js';
import { SUBAGENT_CATALOG } from './subagent-catalog.js';

let seq = 0;
function event(method: string, data: unknown): Event {
  const current = seq++;
  return {
    type: 'event',
    seq: current,
    event_id: `c:${current}`,
    method,
    params: { namespace: [], timestamp: 0, data },
  } as Event;
}

const started = (callId: string) =>
  event('tools', { event: 'tool-started', tool_call_id: callId, tool_name: 'task', input: '{}' });
const catalog = (payload: unknown, name: string = SUBAGENT_CATALOG) =>
  event('custom', { name, payload });

const fold = (...frames: Event[]) => reduceAll(emptyConversation(), frames);
const card = (frames: Event[], callId: string) =>
  fold(...frames).entries.find(
    (entry): entry is ToolEntry => entry.kind === 'tool' && entry.callId === callId,
  );

describe('subagent/catalog', () => {
  it('掛到 callId 那張卡上，別張卡不動；卡之後收尾也不弄丟', () => {
    const frames = [
      started('a'),
      started('b'),
      catalog({ childId: 'root/x', callId: 'a', mode: 'one-shot' }),
      event('tools', { event: 'tool-finished', tool_call_id: 'a', output: '好' }),
    ];
    expect(card(frames, 'a')).toMatchObject({
      status: 'done',
      subagentSession: { id: 'root/x', mode: 'one-shot' },
    });
    expect(card(frames, 'b')?.subagentSession).toBeUndefined();
  });

  it('卡不在：不另開一張，畫面原樣', () => {
    const before = fold(started('a'));
    const after = fold(started('a'), catalog({ childId: 'root/x', callId: 'z', mode: 'one-shot' }));
    expect(after.entries).toEqual(before.entries);
  });

  it('形狀不對不收：缺 childId、mode 不認得、名字不對', () => {
    for (const bad of [
      catalog({ callId: 'a', mode: 'one-shot' }),
      catalog({ childId: '', callId: 'a', mode: 'one-shot' }),
      catalog({ childId: 'root/x', callId: 'a', mode: 'forever' }),
      catalog({ childId: 'root/x', callId: 'a', mode: 'one-shot' }, 'subagent/other'),
    ]) {
      expect(card([started('a'), bad], 'a')?.subagentSession).toBeUndefined();
    }
  });
});

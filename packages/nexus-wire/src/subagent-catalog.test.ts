/**
 * 子代理目錄的 `custom` frame 怎麼折（[#1023](https://github.com/DemianLi/nexus-agent/issues/1023)）。
 *
 * 產出 frame 的那一半（即時與歷史）在 `apps/harness/src/subagent-session-link.test.ts`；這裡只管折疊器：掛到 `callId` 那張卡上、
 * 卡之後的更新不弄丟它、卡不在或形狀不對不收。
 */

import { describe, expect, it } from 'vitest';

import { emptyConversation, prependEntries, reduceAll } from './conversation.js';
import type { ToolEntry } from './conversation.js';
import type { Event } from './protocol.js';
import { SUBAGENT_CATALOG } from './subagent-catalog.js';

let seq = 0;
function event(method: string, data: unknown, timestamp = 0): Event {
  const current = seq++;
  return {
    type: 'event',
    seq: current,
    event_id: `c:${current}`,
    method,
    params: { namespace: [], timestamp, data },
  } as Event;
}

const started = (callId: string, timestamp = 0) =>
  event(
    'tools',
    { event: 'tool-started', tool_call_id: callId, tool_name: 'task', input: '{}' },
    timestamp,
  );
const finished = (callId: string, timestamp = 0) =>
  event('tools', { event: 'tool-finished', tool_call_id: callId, output: '好' }, timestamp);
const catalog = (payload: unknown, name: string = SUBAGENT_CATALOG, timestamp = 0) =>
  event('custom', { name, payload }, timestamp);

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

/**
 * 跟 #1041 的條目時刻並存：`ToolEntry` 同時有 `startedAt`／`settledAt` 與 `subagentSession` 兩組新欄位。目錄那顆 frame
 * 自己的時刻**不碰**卡的時刻，時刻的三條規則（0 當沒有、resume 留第一顆的 `startedAt` 並拿掉 `settledAt`、往前接頁保留）
 * 也不碰 `subagentSession`。產品路徑上的那一條在 harness 的 `subagent-session-link.test.ts`。
 */
describe('subagent/catalog 與條目時刻並存', () => {
  const ONE = { childId: 'root/x', callId: 'a', mode: 'one-shot' } as const;

  it('目錄夾在起訖之間：時刻取自工具 frame，不取目錄那顆；收尾之後兩組都在', () => {
    const frames = [started('a', 100), catalog(ONE, SUBAGENT_CATALOG, 150), finished('a', 200)];
    expect(card(frames, 'a')).toMatchObject({
      startedAt: 100,
      settledAt: 200,
      subagentSession: { id: 'root/x', mode: 'one-shot' },
    });
  });

  it('目錄在收尾之後才到：settledAt 不被改寫，startedAt 不被補', () => {
    const frames = [started('a', 100), finished('a', 200), catalog(ONE, SUBAGENT_CATALOG, 300)];
    expect(card(frames, 'a')).toMatchObject({ startedAt: 100, settledAt: 200 });
    expect(card(frames, 'a')?.subagentSession).toEqual({ id: 'root/x', mode: 'one-shot' });
  });

  it('時刻 0 當沒有：卡上沒有時刻的鍵，目錄照掛', () => {
    const got = card([started('a'), catalog(ONE), finished('a')], 'a');
    expect(got).not.toHaveProperty('startedAt');
    expect(got).not.toHaveProperty('settledAt');
    expect(got?.subagentSession).toEqual({ id: 'root/x', mode: 'one-shot' });
  });

  it('resume（同一個 callId 第二顆 tool-started）：留第一顆的 startedAt、拿掉 settledAt，目錄還在', () => {
    const frames = [
      started('a', 100),
      catalog(ONE, SUBAGENT_CATALOG, 150),
      finished('a', 200),
      started('a', 300),
    ];
    const got = card(frames, 'a');
    expect(got).toMatchObject({
      status: 'running',
      startedAt: 100,
      subagentSession: { id: 'root/x', mode: 'one-shot' },
    });
    expect(got).not.toHaveProperty('settledAt');
  });

  it('往前接一頁歷史：接上來的卡兩組欄位原樣保留', () => {
    const earlier = fold(
      started('a', 100),
      catalog(ONE, SUBAGENT_CATALOG, 150),
      finished('a', 200),
    );
    const merged = prependEntries(fold(started('b', 400)), earlier);
    const got = merged.entries.find(
      (entry): entry is ToolEntry => entry.kind === 'tool' && entry.callId === 'a',
    );
    expect(got).toMatchObject({
      startedAt: 100,
      settledAt: 200,
      subagentSession: { id: 'root/x', mode: 'one-shot' },
    });
  });
});

/**
 * 用量表的兩種 `custom` frame 怎麼折（[#528](https://github.com/DemianLi/nexus-agent/issues/528)）。
 *
 * 兩條路產出同一種 frame 的那一半在 `apps/harness/src/context-pressure.test.ts`；這裡只管折疊器自己：兩格各自
 * 更新、形狀不對整顆不收、往前翻頁不動它。
 */

import { describe, expect, it } from 'vitest';

import { CONTEXT_MEASURE, MODEL_USAGE } from './context-pressure.js';
import { emptyConversation, prependEntries, reduceAll } from './conversation.js';
import type { ConversationState } from './conversation.js';
import type { Event } from './protocol.js';

const custom = (name: string, payload: unknown): Event =>
  ({
    type: 'event',
    method: 'custom',
    params: { namespace: [], timestamp: 0, data: { name, payload } },
  }) as Event;

const measure = {
  approxTokens: 10,
  messageCount: 2,
  thresholds: [
    { type: 'tokens', value: 5 },
    { type: 'messages', value: 60 },
  ],
};

const fold = (...frames: Event[]): ConversationState['contextPressure'] =>
  reduceAll(emptyConversation(), frames).contextPressure;

describe('contextPressure', () => {
  it('一顆都沒有是 null', () => {
    expect(emptyConversation().contextPressure).toBeNull();
  });

  it('兩格各自更新，一格不蓋掉另一格，同一格後到的贏', () => {
    const usage = custom(MODEL_USAGE, { inputTokens: 7 });
    const measured = custom(CONTEXT_MEASURE, measure);
    expect(fold(usage, measured)).toEqual({ inputTokens: 7, measure });
    expect(fold(measured, usage)).toEqual({ inputTokens: 7, measure });
    expect(fold(usage, custom(MODEL_USAGE, { inputTokens: 9 }))).toEqual({ inputTokens: 9 });
    const later = { ...measure, approxTokens: 3, messageCount: 1 };
    expect(fold(measured, custom(CONTEXT_MEASURE, later))).toEqual({ measure: later });
  });

  it('只帶認得的欄位', () => {
    expect(
      fold(
        custom(CONTEXT_MEASURE, {
          ...measure,
          extra: 1,
          thresholds: [{ type: 'tokens', value: 5, extra: 1 }],
        }),
      ),
    ).toEqual({ measure: { ...measure, thresholds: [{ type: 'tokens', value: 5 }] } });
    expect(fold(custom(MODEL_USAGE, { inputTokens: 7, outputTokens: 1 }))).toEqual({
      inputTokens: 7,
    });
  });

  it('形狀不對整顆不收，不收一半', () => {
    const bad: unknown[] = [
      { ...measure, approxTokens: -1 },
      { ...measure, approxTokens: 1.5 },
      { ...measure, messageCount: '2' },
      { ...measure, thresholds: [] },
      { ...measure, thresholds: 'tokens' },
      { ...measure, thresholds: [{ type: 'fraction', value: 0.8 }] },
      { ...measure, thresholds: [{ type: 'tokens', value: 0 }] },
      { ...measure, thresholds: [{ type: 'tokens', value: Number.POSITIVE_INFINITY }] },
      { ...measure, thresholds: [{ type: 'tokens', value: 5 }, { type: 'messages' }] },
      { ...measure, thresholds: [null] },
      null,
    ];
    for (const payload of bad) expect(fold(custom(CONTEXT_MEASURE, payload))).toBeNull();
    for (const inputTokens of [-1, 1.5, '7', undefined]) {
      expect(fold(custom(MODEL_USAGE, { inputTokens }))).toBeNull();
    }
  });

  it('壞的那顆不動已經有的', () => {
    const before = custom(CONTEXT_MEASURE, measure);
    expect(fold(before, custom(CONTEXT_MEASURE, { ...measure, thresholds: [] }))).toEqual({
      measure,
    });
  });

  it('往前翻頁不動它：那是「現在」的事', () => {
    const now = reduceAll(emptyConversation(), [custom(MODEL_USAGE, { inputTokens: 9 })]);
    const earlier = reduceAll(emptyConversation(), [custom(MODEL_USAGE, { inputTokens: 1 })]);
    expect(prependEntries(now, earlier).contextPressure).toEqual({ inputTokens: 9 });
  });
});

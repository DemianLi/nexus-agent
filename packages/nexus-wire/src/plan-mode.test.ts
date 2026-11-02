/**
 * 計劃模式的 `custom` frame 怎麼折（[#895](https://github.com/DemianLi/nexus-agent/issues/895)）。
 *
 * 兩條路產出同一種 frame 的那一半在 `apps/harness/src/plan-mode-wire.test.ts`；這裡只管折疊器：整份換掉、
 * 形狀不對整顆不收、往前翻頁不動它。
 */

import { describe, expect, it } from 'vitest';

import { emptyConversation, prependEntries, reduceAll } from './conversation.js';
import { PLAN_MODE } from './plan-mode.js';
import type { Event } from './protocol.js';

const planFrame = (payload: unknown, name: string = PLAN_MODE): Event =>
  ({
    type: 'event',
    method: 'custom',
    params: { namespace: [], timestamp: 0, data: { name, payload } },
  }) as Event;

const fold = (...frames: Event[]) => reduceAll(emptyConversation(), frames).planMode;

describe('planMode', () => {
  it('一顆都沒有是 null', () => {
    expect(fold()).toBeNull();
  });

  it('後到的整份取代先到的，開關都收', () => {
    expect(fold(planFrame({ active: true }))).toEqual({ active: true });
    expect(fold(planFrame({ active: true }), planFrame({ active: false }))).toEqual({
      active: false,
    });
    expect(
      fold(planFrame({ active: true }), planFrame({ active: false }), planFrame({ active: true })),
    ).toEqual({ active: true });
  });

  it('形狀不對整顆不收，留著前一份', () => {
    for (const bad of [{}, { active: 'true' }, { active: 1 }, { active: null }]) {
      expect(fold(planFrame(bad))).toBeNull();
      expect(fold(planFrame({ active: true }), planFrame(bad))).toEqual({ active: true });
    }
  });

  it('別的名字不進來', () => {
    expect(fold(planFrame({ active: true }, 'plan/mode'))).toBeNull();
  });

  it('往前翻頁不動它', () => {
    const state = reduceAll(emptyConversation(), [planFrame({ active: true })]);
    expect(prependEntries(state, emptyConversation()).planMode).toEqual({ active: true });
  });
});

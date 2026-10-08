/**
 * 權限組合的 `custom` frame 怎麼折（[#437](https://github.com/DemianLi/nexus-agent/issues/437)）：整份換掉、形狀不對整顆不收、
 * 往前翻頁不動它。producer 還沒實作，這一格先在表上登記，折疊器先會接。
 */

import { describe, expect, it } from 'vitest';

import { emptyConversation, prependEntries, reduceAll } from './conversation.js';
import { CUSTOM_PRESET, PERMISSIONS } from './permission-presets.js';
import type { Event } from './protocol.js';

const frame = (payload: unknown, name: string = PERMISSIONS): Event =>
  ({
    type: 'event',
    method: 'custom',
    params: { namespace: [], timestamp: 0, data: { name, payload } },
  }) as Event;

const fold = (...frames: Event[]) => reduceAll(emptyConversation(), frames).permissions;

describe('permissions', () => {
  it('一顆都沒有是 null（沒收到過）', () => {
    expect(fold()).toBeNull();
  });

  it('後到的整份取代先到的，`custom` 也收（只能顯示的那個值）', () => {
    expect(fold(frame({ currentValue: 'read-only' }))).toEqual({ currentValue: 'read-only' });
    expect(
      fold(frame({ currentValue: 'read-only' }), frame({ currentValue: CUSTOM_PRESET })),
    ).toEqual({ currentValue: 'custom' });
  });

  it('形狀不對整顆不收，留著前一份', () => {
    for (const bad of [{}, { currentValue: '' }, { currentValue: 1 }, { currentValue: null }]) {
      expect(fold(frame(bad))).toBeNull();
      expect(fold(frame({ currentValue: 'workspace-write' }), frame(bad))).toEqual({
        currentValue: 'workspace-write',
      });
    }
  });

  it('往前翻頁不動它', () => {
    const state = reduceAll(emptyConversation(), [frame({ currentValue: 'workspace-write' })]);
    expect(prependEntries(state, emptyConversation()).permissions).toEqual({
      currentValue: 'workspace-write',
    });
  });
});

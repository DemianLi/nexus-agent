/**
 * 權限組合走泛用投影通道（[#437](https://github.com/DemianLi/nexus-agent/issues/437)）：不另開 `custom` frame 與折疊欄位，
 * 值落在 `ConversationState.projections.permissions`。
 */

import { describe, expect, it } from 'vitest';

import { emptyConversation, reduceAll } from './conversation.js';
import type { PermissionSelection } from './permission-presets.js';
import { CUSTOM_PRESET, PERMISSIONS_PROJECTION_KEY } from './permission-presets.js';
import { PROJECTION, PROJECTION_KEY_PATTERN } from './projection.js';
import type { Event } from './protocol.js';

const frame = (view: unknown): Event =>
  ({
    type: 'event',
    method: 'custom',
    params: {
      namespace: [],
      timestamp: 0,
      data: { name: PROJECTION, payload: { key: PERMISSIONS_PROJECTION_KEY, version: 1, view } },
    },
  }) as Event;

describe('permissions 投影', () => {
  it('key 合格，而且不是 ConversationState 上的專用欄位', () => {
    expect(PERMISSIONS_PROJECTION_KEY).toMatch(PROJECTION_KEY_PATTERN);
    expect('permissions' in emptyConversation()).toBe(false);
  });

  it('後到的整份取代先到的，`custom` 也收（只能顯示的那個值）', () => {
    const state = reduceAll(emptyConversation(), [
      frame({ currentValue: 'read-only' } satisfies PermissionSelection),
      frame({ currentValue: CUSTOM_PRESET } satisfies PermissionSelection),
    ]);
    expect(state.projections[PERMISSIONS_PROJECTION_KEY]?.view).toEqual({ currentValue: 'custom' });
  });
});

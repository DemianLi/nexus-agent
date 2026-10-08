/** `permissions` 投影的折疊：三種事件折成旋鈕，推導成 `{ currentValue }`，不相干的事件不動狀態。 */

import type { SessionEvent } from '@nexus/core';
import { describe, expect, it } from 'vitest';

import {
  applyPermissionEvent,
  createPermissionsUnit,
  EMPTY_KNOBS,
  foldPermissionKnobs,
} from './fold.js';
import { DEFAULT_PRESETS } from './presets.js';

const event = (type: string, data: unknown, seq = 0): SessionEvent =>
  ({ type, data, seq }) as unknown as SessionEvent;

describe('折疊', () => {
  it('三種事件各折自己的格子', () => {
    let state = EMPTY_KNOBS;
    state = applyPermissionEvent(state, event('sandbox/mode', { mode: 'read-only' }));
    state = applyPermissionEvent(state, event('approval/policy', { policy: 'never' }));
    state = applyPermissionEvent(state, event('permission/preset', { preset: 'read-only' }));
    expect(state).toEqual({ preset: 'read-only', sandbox: 'read-only', approval: 'never' });
  });

  it('不相干的事件與沒有變的事件回同一個參照（投影註冊表的變更閘）', () => {
    const state = foldPermissionKnobs([event('sandbox/mode', { mode: 'read-only' })]);
    expect(applyPermissionEvent(state, event('turn/start', {}))).toBe(state);
    expect(applyPermissionEvent(state, event('sandbox/mode', { mode: 'read-only' }))).toBe(state);
  });

  it('投影單元：key 是 permissions，view 只有 currentValue，日誌上沒有任何事件時是出廠假設那一組', () => {
    const unit = createPermissionsUnit(DEFAULT_PRESETS);
    expect(unit.key).toBe('permissions');
    expect(unit.view(unit.init())).toEqual({ currentValue: 'workspace-write' });
    const full = [
      event('sandbox/mode', { mode: 'danger-full-access' }),
      event('approval/policy', { policy: 'never' }),
    ].reduce(unit.apply, unit.init());
    expect(unit.view(full)).toEqual({ currentValue: 'danger-full-access' });
  });

  it('只切了一顆旋鈕：投影是 custom，不是最後記的那一組', () => {
    const unit = createPermissionsUnit(DEFAULT_PRESETS);
    const state = [
      event('permission/preset', { preset: 'danger-full-access' }),
      event('sandbox/mode', { mode: 'danger-full-access' }),
      event('approval/policy', { policy: 'never' }),
      event('approval/policy', { policy: 'ask' }),
    ].reduce(unit.apply, unit.init());
    expect(unit.view(state)).toEqual({ currentValue: 'custom' });
  });
});

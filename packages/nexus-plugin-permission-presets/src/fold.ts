/**
 * `permissions` 投影的折疊：日誌上三種事件（`permission/preset`、`sandbox/mode`、`approval/policy`）折成旋鈕狀態，
 * 再推導成 `{ currentValue }` 送給 web。
 *
 * 照 dsh：投影只推**現在的值**（整份取代），不推歷史；歷史由事件本身答。dsh 的 `permissions` 投影（`index.ts` 的
 * `applyPermissionEvent`）同一個形狀，多一格 `seeded`（建構者 seed 的邊界），我們沒有那個邊界，所以不帶。
 *
 * @module
 */

import type { ProjectionUnit, SessionEvent } from '@nexus/core';
import { PERMISSIONS_PROJECTION_KEY } from '@nexus/wire';
import type { PermissionSelection } from '@nexus/wire';
import { derivePreset } from './presets.js';
import type { PermissionKnobs, PresetTable } from './presets.js';

/** 一份還沒有任何事件的日誌：每個格子都是 `null`，推導時用出廠假設補。 */
export const EMPTY_KNOBS: PermissionKnobs = { preset: null, sandbox: null, approval: null };

/**
 * 折一顆事件。不相干的事件回**同一個參照**（投影註冊表的變更閘）。
 * @param state - 折之前的狀態。
 * @param event - 一顆已提交的事件。
 * @returns 下一個狀態。
 */
export function applyPermissionEvent(state: PermissionKnobs, event: SessionEvent): PermissionKnobs {
  switch (event.type) {
    case 'permission/preset':
      return state.preset === event.data.preset ? state : { ...state, preset: event.data.preset };
    case 'sandbox/mode':
      return state.sandbox === event.data.mode ? state : { ...state, sandbox: event.data.mode };
    case 'approval/policy':
      return state.approval === event.data.policy
        ? state
        : { ...state, approval: event.data.policy };
    default:
      return state;
  }
}

/**
 * 把一份日誌現有的事件折成旋鈕狀態。`/permission` 要知道「記著的是哪一組」時用。
 * @param events - 一份日誌的事件。
 * @returns 折完的狀態。
 */
export function foldPermissionKnobs(events: readonly SessionEvent[]): PermissionKnobs {
  return events.reduce(applyPermissionEvent, EMPTY_KNOBS);
}

/**
 * 建 `permissions` 投影單元。**表是這一次組裝的**，所以單元建在 `apply` 裡、不放模組層。
 * @param table - 這一次組裝的組合表。
 * @returns 可以交給 `registry.projections.register` 的單元。
 */
export function createPermissionsUnit(
  table: PresetTable,
): ProjectionUnit<PermissionKnobs, PermissionSelection> {
  return {
    key: PERMISSIONS_PROJECTION_KEY,
    // 折疊或 view 形狀一變就升。1：旋鈕三元組，view 是 `{ currentValue }`。
    stateVersion: 1,
    init: () => EMPTY_KNOBS,
    apply: applyPermissionEvent,
    view: (state) => ({ currentValue: derivePreset(table, state) }),
  };
}

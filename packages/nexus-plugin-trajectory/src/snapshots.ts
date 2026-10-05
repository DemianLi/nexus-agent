/**
 * 請求快照投影：把日誌上的 `request/system` 與 `request/header` 折成「最新的幾份」，給 web 的觀測分頁讀
 * （[#1027](https://github.com/DemianLi/nexus-agent/issues/1027)，#1020 的消費端）。
 *
 * 跟 `trajectory` 分成兩個單元，是因為**它們的更新節奏相反**：快照變得少、每份很大（系統提示詞可到數十 KB），
 * 軌跡每顆事件都變、很小。同一個單元的話，每顆工具事件都會把整份系統提示詞再送一次；分開之後，通道只在快照真的變了
 * 才重送這一個。軌跡裡的呼叫只存快照的 `seq`，用它在這裡找內容。
 *
 * 每種只留最新 {@link REQUEST_SNAPSHOTS_KEEP} 份。系統提示詞超過 {@link REQUEST_SYSTEM_MAX_CHARS} 字元就截斷並標 `truncated`，
 * 原文總長照記在 `chars`。
 *
 * @module
 */

import type { ProjectionUnit, SessionEvent } from '@nexus/core';
import {
  REQUEST_SNAPSHOTS_KEEP,
  REQUEST_SNAPSHOTS_PROJECTION,
  REQUEST_SNAPSHOTS_VERSION,
  REQUEST_SYSTEM_MAX_CHARS,
} from '@nexus/wire';
import type {
  RequestHeaderSnapshot,
  RequestSnapshotsView,
  RequestSystemSnapshot,
} from '@nexus/wire';

/** 狀態與 view 同形——快照本來就是要送出去的值。 */
export type RequestSnapshotsState = RequestSnapshotsView;

const keepLatest = <T>(list: readonly T[], next: T): readonly T[] =>
  [...list, next].slice(-REQUEST_SNAPSHOTS_KEEP);

/** @returns 空狀態。 */
export function initialRequestSnapshots(): RequestSnapshotsState {
  return { system: [], header: [] };
}

/**
 * 請求快照的 `apply`。
 *
 * @param state - 目前的狀態。
 * @param event - root 日誌的下一顆事件。
 * @returns 新狀態；不是快照的事件回同一個參照。
 */
export function applyRequestSnapshots(
  state: RequestSnapshotsState,
  event: SessionEvent,
): RequestSnapshotsState {
  if (event.type === 'request/system') {
    const data = event.data;
    const text = data.system;
    const truncated = text.length > REQUEST_SYSTEM_MAX_CHARS;
    const snapshot: RequestSystemSnapshot = {
      seq: event.seq,
      time: event.time,
      reason: data.reason,
      ...(data.modelCall === undefined ? {} : { modelCall: data.modelCall }),
      text: truncated ? text.slice(0, REQUEST_SYSTEM_MAX_CHARS) : text,
      chars: text.length,
      ...(truncated ? { truncated: true as const } : {}),
    };
    return { ...state, system: keepLatest(state.system, snapshot) };
  }
  if (event.type === 'request/header') {
    const data = event.data;
    const snapshot: RequestHeaderSnapshot = {
      seq: event.seq,
      time: event.time,
      reason: data.reason,
      ...(data.modelCall === undefined ? {} : { modelCall: data.modelCall }),
      header: data.header,
    };
    return { ...state, header: keepLatest(state.header, snapshot) };
  }
  return state;
}

/** 請求快照投影單元。 */
export const requestSnapshotsUnit: ProjectionUnit<RequestSnapshotsState, RequestSnapshotsView> = {
  key: REQUEST_SNAPSHOTS_PROJECTION,
  stateVersion: REQUEST_SNAPSHOTS_VERSION,
  // 子代理的軌跡（#1070）上記的 `system`／`header` 指的是子代理自己日誌的 `seq`，快照要跟著它折，否則指到 root 的快照。
  children: true,
  init: initialRequestSnapshots,
  apply: applyRequestSnapshots,
  view: (state) => state,
};

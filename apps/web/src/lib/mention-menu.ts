/*
 * `@` 選單的狀態（#653）。候選是非同步的，照 dsh 的 `menuReduce`（`ui-input-trigger/src/core/menu.ts`，`477b4f4`）
 * 收成一個純 reducer，只有一個來源（檔案與資料夾）：
 *
 * - **每一次查詢一個號**（`generation`）。回來的結果號不對就丟掉：打得快時只畫最後一次的。
 * - **查詢變了先留著舊的**：上一次的列照畫、選中的那一列不動，新的回來再整批換掉；**還沒回來時舊的列選不到**。
 *   完全沒有列時畫骨架。
 * - **回來是空的、或失敗，就收起來**。下一個字又是一次新的查詢。
 * - **伺服器說沒有工作區**（`available: false`）就記住，之後一律不開：那跟查詢無關，同一台 server 每次都一樣。
 *   **第一次回來之前也不畫**：還不知道有沒有工作區，先畫骨架的話，沒有工作區的 server 上打 `@` 會閃一下。
 */

import type { FileReferenceListOutcome } from '@nexus/wire';

import { mentionRows } from '@/lib/file-mention';
import type { MentionRow } from '@/lib/file-mention';

export interface MentionMenuState {
  readonly generation: number;
  readonly status: 'closed' | 'pending' | 'ready';
  readonly rows: readonly MentionRow[];
  readonly highlight: number | null;
  /** 伺服器回過一次有沒有工作區。 */
  readonly availability: 'unknown' | 'available' | 'unavailable';
}

export type MentionMenuEvent =
  | { readonly type: 'hit'; readonly generation: number }
  | {
      readonly type: 'settled';
      readonly generation: number;
      readonly outcome: FileReferenceListOutcome;
      readonly quoted: boolean;
    }
  | { readonly type: 'failed'; readonly generation: number }
  | { readonly type: 'close' }
  | { readonly type: 'move'; readonly dir: 1 | -1 }
  | { readonly type: 'hover'; readonly index: number };

export const MENTION_MENU_CLOSED: MentionMenuState = {
  generation: 0,
  status: 'closed',
  rows: [],
  highlight: null,
  availability: 'unknown',
};

function closed(state: MentionMenuState): MentionMenuState {
  return state.status === 'closed' && state.rows.length === 0 && state.highlight === null
    ? state
    : { ...state, status: 'closed', rows: [], highlight: null };
}

export function reduceMentionMenu(
  state: MentionMenuState,
  event: MentionMenuEvent,
): MentionMenuState {
  switch (event.type) {
    case 'hit':
      if (state.availability === 'unavailable') return state;
      return { ...state, generation: event.generation, status: 'pending' };
    case 'settled': {
      if (state.status === 'closed' || event.generation !== state.generation) return state;
      if (event.outcome.kind === 'rejected') return closed(state);
      if (!event.outcome.result.available) {
        return { ...closed(state), availability: 'unavailable' };
      }
      const rows = mentionRows(event.outcome.result.candidates, event.quoted);
      const known = { ...state, availability: 'available' as const };
      if (rows.length === 0) return closed(known);
      const highlight =
        state.highlight !== null && state.highlight < rows.length ? state.highlight : 0;
      return { ...known, status: 'ready', rows, highlight };
    }
    case 'failed':
      if (state.status === 'closed' || event.generation !== state.generation) return state;
      return closed(state);
    case 'close':
      return closed(state);
    case 'move': {
      if (state.status === 'closed' || state.rows.length === 0) return state;
      const at = state.highlight ?? -1;
      const next =
        at < 0
          ? event.dir === 1
            ? 0
            : state.rows.length - 1
          : (at + event.dir + state.rows.length) % state.rows.length;
      return next === state.highlight ? state : { ...state, highlight: next };
    }
    case 'hover':
      if (state.status !== 'ready' || event.index >= state.rows.length) return state;
      return event.index === state.highlight ? state : { ...state, highlight: event.index };
  }
}

/** 畫不畫得出來：知道有工作區，而且在查（有沒有列都畫：沒有就畫骨架）或有列可選。 */
export function mentionMenuOpen(state: MentionMenuState): boolean {
  return state.availability === 'available' && state.status !== 'closed';
}

/** 選得到嗎：結果回來了才選得到，還在查的時候留在畫面上的舊列不算。 */
export function mentionPickable(state: MentionMenuState): MentionRow | undefined {
  if (state.status !== 'ready' || state.highlight === null) return undefined;
  return state.rows[state.highlight];
}

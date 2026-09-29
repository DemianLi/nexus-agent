/*
 * `@` 選單的狀態（#653、#713）。候選是非同步的，照 dsh 的 `menuReduce`（`ui-input-trigger/src/core/menu.ts`，`477b4f4`）
 * 收成一個純 reducer。**來源有兩個**：檔案與資料夾、會話與子代理（#713 Q4：同一個選單分三段，順序是檔案、會話、子代理）。
 *
 * - **每一次查詢一個號**（`generation`）。回來的結果號不對就丟掉：打得快時只畫最後一次的。
 * - **查詢變了先留著舊的**：上一次的列照畫、選中的那一列不動，新的回來再整批換掉；**還沒回來時舊的列選不到**。
 *   完全沒有列時畫骨架。
 * - **兩個來源各回各的，先回來的先畫**：檔案不等會話（會話是跨專案冷讀，慢一點）。後回來的那一段併進去，選中的那一列
 *   **跟著它自己走**（後到的檔案插在上面時，選中的不會換成別列）。
 * - **回來是空的、或失敗，就收起來**：要兩個來源都回來了、都沒有列才收。下一個字又是一次新的查詢。
 * - **伺服器說沒有工作區／沒接落盤**（`available: false`）**按來源記住**，之後那個來源一律不問：那跟查詢無關，同一台
 *   server 每次都一樣。**兩個來源都不可用，選單才整個不開**；一個不可用不影響另一個。
 * - **第一次回來之前也不畫**：還不知道有沒有東西可列，先畫骨架的話，什麼都沒有的 server 上打 `@` 會閃一下。
 */

import type { FileReferenceListOutcome, SessionReferenceListOutcome } from '@nexus/wire';

import { mentionRows } from '@/lib/file-mention';
import type { FileMentionRow } from '@/lib/file-mention';
import { sessionRows } from '@/lib/session-mention';
import type { SessionMentionRow } from '@/lib/session-mention';

/** 選單上的一列。 */
export type MentionRow = FileMentionRow | SessionMentionRow;

export type MentionSource = 'file' | 'session';

/** 選單分三段的順序（Q4）。 */
export const MENTION_SECTIONS = ['file', 'session', 'subagent'] as const;

/** 一列的身分：cmdk 的 `value`、選中時跟著走都用它。三種來源不會撞（檔案路徑、會話 id 各有前綴）。 */
export function mentionRowKey(row: MentionRow): string {
  return row.source === 'file'
    ? `file:${row.candidate.path}`
    : `session:${row.candidate.sessionId}`;
}

type Availability = 'unknown' | 'available' | 'unavailable';

export interface MentionMenuState {
  readonly generation: number;
  readonly status: 'closed' | 'pending' | 'ready';
  readonly rows: readonly MentionRow[];
  readonly highlight: number | null;
  /** 伺服器回過一次有沒有東西可列，按來源記。 */
  readonly availability: Readonly<Record<MentionSource, Availability>>;
  /** 這一號問了哪幾個來源、各自回來的列。回來了的才有 key（失敗與空的是空陣列）。 */
  readonly asked: readonly MentionSource[];
  readonly arrived: Readonly<Partial<Record<MentionSource, readonly MentionRow[]>>>;
  /** 畫面上的列是這一號的結果（false：還是上一號留下來的）。 */
  readonly fresh: boolean;
}

export type MentionMenuEvent =
  | {
      readonly type: 'hit';
      readonly generation: number;
      /** 這一號要問的來源；省略只問檔案。已知不可用的來源會被略過。 */
      readonly sources?: readonly MentionSource[];
    }
  | {
      readonly type: 'settled';
      readonly generation: number;
      readonly source?: 'file';
      readonly outcome: FileReferenceListOutcome;
      readonly quoted: boolean;
    }
  | {
      readonly type: 'settled';
      readonly generation: number;
      readonly source: 'session';
      readonly outcome: SessionReferenceListOutcome;
    }
  | { readonly type: 'failed'; readonly generation: number; readonly source?: MentionSource }
  | { readonly type: 'close' }
  | { readonly type: 'move'; readonly dir: 1 | -1 }
  | { readonly type: 'hover'; readonly index: number };

export const MENTION_MENU_CLOSED: MentionMenuState = {
  generation: 0,
  status: 'closed',
  rows: [],
  highlight: null,
  availability: { file: 'unknown', session: 'unknown' },
  asked: [],
  arrived: {},
  fresh: false,
};

function closed(state: MentionMenuState): MentionMenuState {
  return state.status === 'closed' &&
    state.rows.length === 0 &&
    state.highlight === null &&
    state.asked.length === 0
    ? state
    : {
        ...state,
        status: 'closed',
        rows: [],
        highlight: null,
        asked: [],
        arrived: {},
        fresh: false,
      };
}

/** 這一輪還要問哪幾個來源：已知不可用的略過。 */
export function askableSources(
  state: MentionMenuState,
  wanted: readonly MentionSource[],
): readonly MentionSource[] {
  return wanted.filter((source) => state.availability[source] !== 'unavailable');
}

function sectionOf(row: MentionRow): number {
  return MENTION_SECTIONS.indexOf(row.source);
}

/** 目前回來的列併成一份：檔案、會話、子代理三段，段內照伺服器給的先後。 */
function merge(arrived: MentionMenuState['arrived']): readonly MentionRow[] {
  const rows = [...(arrived.file ?? []), ...(arrived.session ?? [])];
  return rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => sectionOf(left.row) - sectionOf(right.row) || left.index - right.index)
    .map(({ row }) => row);
}

function arrive(
  state: MentionMenuState,
  source: MentionSource,
  rows: readonly MentionRow[],
  availability: Availability,
): MentionMenuState {
  if (!state.asked.includes(source)) return state;
  const arrived = { ...state.arrived, [source]: rows };
  const known = { ...state.availability, [source]: availability };
  const done = state.asked.every((asked) => arrived[asked] !== undefined);
  const merged = merge(arrived);
  if (merged.length === 0) {
    // 還有來源沒回來：留著上一號的列（或骨架）等；都回來了還是空的，收起來。
    return done
      ? { ...closed(state), availability: known }
      : { ...state, availability: known, arrived };
  }
  const previous = state.highlight === null ? undefined : state.rows[state.highlight];
  const followed =
    state.fresh && previous !== undefined
      ? merged.findIndex((row) => mentionRowKey(row) === mentionRowKey(previous))
      : -1;
  const highlight =
    followed !== -1
      ? followed
      : state.highlight !== null && state.highlight < merged.length
        ? state.highlight
        : 0;
  return {
    ...state,
    status: 'ready',
    rows: merged,
    highlight,
    availability: known,
    arrived,
    fresh: true,
  };
}

export function reduceMentionMenu(
  state: MentionMenuState,
  event: MentionMenuEvent,
): MentionMenuState {
  switch (event.type) {
    case 'hit': {
      const asked = askableSources(state, event.sources ?? ['file']);
      if (asked.length === 0) return state;
      return {
        ...state,
        generation: event.generation,
        status: 'pending',
        asked,
        arrived: {},
        fresh: false,
      };
    }
    case 'settled': {
      if (state.status === 'closed' || event.generation !== state.generation) return state;
      if (event.source === 'session') {
        if (event.outcome.kind === 'rejected')
          return arrive(state, 'session', [], state.availability.session);
        if (!event.outcome.result.available) return arrive(state, 'session', [], 'unavailable');
        return arrive(state, 'session', sessionRows(event.outcome.result.candidates), 'available');
      }
      if (event.outcome.kind === 'rejected')
        return arrive(state, 'file', [], state.availability.file);
      if (!event.outcome.result.available) return arrive(state, 'file', [], 'unavailable');
      return arrive(
        state,
        'file',
        mentionRows(event.outcome.result.candidates, event.quoted),
        'available',
      );
    }
    case 'failed':
      if (state.status === 'closed' || event.generation !== state.generation) return state;
      return arrive(state, event.source ?? 'file', [], state.availability[event.source ?? 'file']);
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

/** 畫不畫得出來：至少有一個來源確定可用，而且在查（有沒有列都畫：沒有就畫骨架）或有列可選。 */
export function mentionMenuOpen(state: MentionMenuState): boolean {
  const known =
    state.availability.file === 'available' || state.availability.session === 'available';
  return known && state.status !== 'closed';
}

/** 選得到嗎：這一號有結果回來了才選得到，還在查的時候留在畫面上的舊列不算。 */
export function mentionPickable(state: MentionMenuState): MentionRow | undefined {
  if (state.status !== 'ready' || state.highlight === null) return undefined;
  return state.rows[state.highlight];
}

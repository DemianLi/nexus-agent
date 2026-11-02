/**
 * 會話投影：**插件宣告一個命名的、從日誌折出來的狀態，由 pump 送到 web**
 * （[#1026](https://github.com/DemianLi/nexus-agent/issues/1026)，設計見 `.docs/session-projections-design.md`）。
 *
 * 照 dsh 的 `sessionProjections`（`packages/session/session-projection/src/index.ts`，`5badb15`）：一個單元是
 * `key`／`stateVersion`／`init`／`apply`／`view` 五件，`apply` 純同步、對不相干的事件回**同一個參照**，狀態是純 JSON；
 * 值以**整份**送出，不是 diff。`tokenUsageUnit`（`token-usage.ts`）早就是同形狀。
 *
 * ## 一個折疊器，即時與歷史共用
 *
 * {@link createProjectionFold} 是**唯一**的折疊實作：歷史用 {@link ProjectionFold.fold} 一次折完整串，即時用
 * {@link ProjectionFold.session} 先 seed 已經在日誌裡的事件（不發變更）再逐顆 `push`。兩者經過同一個 `advance`
 * （`apply`＋圍堵＋變更判定），所以「同一串事件，逐顆 push 與一次 fold 的最終值相同」是結構性的，不是兩份程式碼碰巧一致。
 *
 * ## 圍堵
 *
 * 單元的 `apply` 或 `view` 拋錯、或 `view` 不是純 JSON，**只停用那一個單元**：它不再折，回報一筆 `failed: true`
 * 的值（`view: null`），別的單元與產品路徑不受影響。**不凍在最後一個好的 view**——那會把過期的值當現值顯示。
 * 即時與歷史走同一個 `advance`，所以兩邊長出同一格「失敗」。dsh 的註冊表本身沒有這層，見設計文件的偏離表。
 *
 * ## `stateVersion`
 *
 * 單元宣告的「折疊語意＋view 形狀」版本，非負整數。dsh 的用途是持久化快取的失效版本；我們沒有投影快取，所以它隨每顆 frame
 * 送出，web 的渲染器按 `(key, version)` 選、不認得的版本不渲染。之後若加快取，它就是失效鍵。
 *
 * @module
 */

import type { SessionEvent } from './session-log.js';

/**
 * 投影的 key：小寫字母開頭，其後小寫字母、數字，以連字號分段。一個註冊表內唯一，也是 web 端 `projections` 的鍵。
 */
export const PROJECTION_KEY_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

/**
 * 一個投影單元。
 *
 * @typeParam S - 折疊狀態，純 JSON。
 * @typeParam V - 給 web 的那一份，純 JSON；可以比狀態窄（host 專用的欄位不外送）。
 */
export interface ProjectionUnit<S = unknown, V = unknown> {
  /** 這個單元擁有的 key，見 {@link PROJECTION_KEY_PATTERN}。 */
  readonly key: string;
  /** 折疊語意＋view 形狀的版本，非負整數。折疊或形狀一變就升。見檔頭。 */
  readonly stateVersion: number;
  /** 初始狀態。 */
  init(): S;
  /**
   * 把一顆事件折進狀態。**純、同步**。不相干的事件回傳**同一個參照**（`Object.is` 相同就零下游工作）。
   * 狀態事件要帶完整的變更後狀態，不要只帶 delta（dsh 的承重規則）。
   */
  apply(state: S, event: SessionEvent): S;
  /** 狀態→送給 web 的值。純 JSON。 */
  view(state: S): V;
  /**
   * `true` ＝ 這個單元**也對每個子代理自己的日誌各折一份**（[#1028](https://github.com/DemianLi/nexus-agent/issues/1028)）。
   * 照 dsh：投影的格子按 session 分（`registration.cells.get(session)`，`session-projection/src/index.ts`），子會話與
   * root 各折各的、互不相見；一份日誌一份折疊，所以**單元的 `apply` 不必知道它在折誰**。省略 ＝ 只折 root（預設）：
   * 子代理的事件整個不會送到這個單元，所以既有的 root 單元（`trajectory`…）不受影響。
   *
   * 子代理的日誌**沒有 `turn/start`**（它不是對話，是一次委派），折它的單元要自己處理這一點。
   */
  readonly children?: true;
  /**
   * **按需細節**（[#1083](https://github.com/DemianLi/nexus-agent/issues/1083)）：單元的 view 只推有界的骨架，某一塊的細節由客戶端
   * 帶著錨點來要，這裡**從日誌重新折出來**——事件是來源，投影不存細節（dsh 的形狀：投影只推小而有界的整份值，細節走 seq 錨點
   * 按需分頁，`loadThrough(seq)`）。省略＝這個單元沒有按需細節。
   *
   * **純、同步、不寫日誌**。`events` 是這份日誌（root 或子代理）目前的全部事件；`query` 是客戶端送來的、單元自己定義的錨點，
   * 要自己驗。查不到或錨點不合時拋 {@link ProjectionDetailError}，其他拋出視為單元的 bug。
   * 不經 `apply`／`view` 的圍堵（那是即時折疊的），所以拋錯只影響這一次請求。
   */
  readonly detail?: (
    events: readonly SessionEvent[],
    query: Readonly<Record<string, unknown>>,
  ) => unknown;
}

/** 按需細節查不到（`not-found`）或錨點不合（`invalid-argument`）。訊息是講給人聽的中文原因，客戶端可以直接顯示。 */
export class ProjectionDetailError extends Error {
  readonly kind: 'not-found' | 'invalid-argument';

  constructor(kind: 'not-found' | 'invalid-argument', message: string) {
    super(message);
    this.name = 'ProjectionDetailError';
    this.kind = kind;
  }
}

/**
 * 要對子代理自己的日誌也折的那幾個單元（{@link ProjectionUnit.children}），保持註冊順序。
 * 即時（`thread-pump.ts`）與歷史（`conversation-history.ts`）**都用這個函式**挑單元，所以兩條路折的是同一批。
 */
export function childProjectionUnits(units: readonly ProjectionUnit[]): readonly ProjectionUnit[] {
  return units.filter((unit) => unit.children === true);
}

/** 一個單元此刻的值，也就是一顆 `projection` frame 的內容。 */
export interface ProjectionValue {
  readonly key: string;
  readonly version: number;
  /** 純 JSON 的整份值；單元停用時是 `null`。 */
  readonly view: unknown;
  /** 單元的 `apply`／`view` 拋過（或 view 不是純 JSON）。有這一格時 `view` 一律是 `null`。 */
  readonly failed?: true;
}

/**
 * 驗一個單元的中繼資料與形狀。註冊時呼叫。
 *
 * @throws key 不合 {@link PROJECTION_KEY_PATTERN}、`stateVersion` 不是非負整數、或四個函式有缺。
 * @returns 凍過的單元（同一組函式）。
 */
export function normalizeProjectionUnit<S, V>(unit: ProjectionUnit<S, V>): ProjectionUnit<S, V> {
  if (typeof unit.key !== 'string' || !PROJECTION_KEY_PATTERN.test(unit.key)) {
    throw new TypeError(
      `投影 key ${JSON.stringify(unit.key)} 不合 ${String(PROJECTION_KEY_PATTERN)}——` +
        `小寫字母開頭，其後小寫字母與數字，以連字號分段。`,
    );
  }
  const version: unknown = unit.stateVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    throw new TypeError(
      `投影 "${unit.key}" 的 stateVersion 要是非負整數，拿到 ${String(version)}。`,
    );
  }
  for (const name of ['init', 'apply', 'view'] as const) {
    if (typeof unit[name] !== 'function') {
      throw new TypeError(`投影 "${unit.key}" 的 ${name} 要是函式。`);
    }
  }
  const children: unknown = unit.children;
  if (children !== undefined && children !== true) {
    throw new TypeError(
      `投影 "${unit.key}" 的 children 要是 true 或省略，拿到 ${String(children)}。`,
    );
  }
  const detail: unknown = unit.detail;
  if (detail !== undefined && typeof detail !== 'function') {
    throw new TypeError(`投影 "${unit.key}" 的 detail 要是函式或省略。`);
  }
  return Object.freeze({
    key: unit.key,
    stateVersion: unit.stateVersion,
    init: unit.init,
    apply: unit.apply,
    view: unit.view,
    ...(children === true && { children: true as const }),
    ...(unit.detail !== undefined && { detail: unit.detail }),
  });
}

/** 一個單元在一份折疊器裡的執行期格子。 */
interface Cell {
  readonly unit: ProjectionUnit;
  state: unknown;
  /** 上一次交出去的 view 的 JSON 文字；`undefined` 表示還沒算過（seed 期間不算）。 */
  json: string | undefined;
  view: unknown;
  failed: boolean;
}

/** 折疊器的選項。 */
export interface ProjectionFoldOptions {
  /**
   * 一個單元被停用時的回報（`apply`／`view` 拋錯或 view 不是純 JSON）。**這個回呼自己拋的不接**——
   * 呼叫端要自己保證它不拋。每個單元在一份折疊器裡最多回報一次。
   */
  readonly onFailure?: (key: string, error: unknown) => void;
}

/**
 * 即時用的折疊器：已 seed 過，之後每顆事件 `push` 一次。
 *
 * 一份日誌一個；狀態不跨份。
 */
export interface ProjectionSession {
  /**
   * 折進一顆事件。
   *
   * @returns 這顆事件讓**值變了**的單元（照註冊順序）：view 變了，或單元剛被停用。沒有變就是空陣列。
   */
  push(event: SessionEvent): readonly ProjectionValue[];
  /** 每個單元此刻的值，照註冊順序，包括停用的。 */
  current(): readonly ProjectionValue[];
}

/** {@link createProjectionFold} 的產物。 */
export interface ProjectionFold {
  /**
   * 把整串事件折完。歷史路由用。
   *
   * @param events - 一份日誌的事件，照 `seq` 排。
   * @returns **每個註冊的單元**一筆（包括沒折到任何事件的、包括停用的），照註冊順序。
   */
  fold(events: Iterable<SessionEvent>): readonly ProjectionValue[];
  /**
   * 開一份即時的折疊器。
   *
   * @param seed - 已經在日誌裡的事件：先折進來、**不發任何變更**（resume 一條舊 thread、server 重啟後 pump 才接上）。
   */
  session(seed?: Iterable<SessionEvent>): ProjectionSession;
}

/** 把 view 轉成純 JSON 的文字與拷貝；不是純 JSON（`undefined`、函式、循環）會拋。 */
function toJson(view: unknown): { readonly json: string; readonly copy: unknown } {
  const json = JSON.stringify(view);
  if (typeof json !== 'string') throw new TypeError('view 要是純 JSON 值。');
  return { json, copy: JSON.parse(json) as unknown };
}

/**
 * 建立折疊器。
 *
 * @param units - 單元，照這個順序回報。**已經註冊時驗過**（{@link normalizeProjectionUnit}）。
 */
export function createProjectionFold(
  units: readonly ProjectionUnit[],
  options: ProjectionFoldOptions = {},
): ProjectionFold {
  const fail = (cell: Cell, error: unknown): void => {
    if (cell.failed) return;
    cell.failed = true;
    cell.state = undefined;
    cell.json = undefined;
    cell.view = null;
    options.onFailure?.(cell.unit.key, error);
  };

  /** 算 view 並記下。變了（或第一次）回 true。拋了就停用，也回 true（值變成了「失敗」）。 */
  const refresh = (cell: Cell): boolean => {
    try {
      const { json, copy } = toJson(cell.unit.view(cell.state));
      if (json === cell.json) return false;
      cell.json = json;
      cell.view = copy;
      return true;
    } catch (error) {
      fail(cell, error);
      return true;
    }
  };

  /** 折一顆事件進一個格子，**不算 view**（seed 與 push 共用）。回 true 表示狀態的參照變了。 */
  const advance = (cell: Cell, event: SessionEvent): boolean => {
    if (cell.failed) return false;
    try {
      const next = cell.unit.apply(cell.state, event);
      if (Object.is(next, cell.state)) return false;
      cell.state = next;
      return true;
    } catch (error) {
      fail(cell, error);
      return true;
    }
  };

  const open = (): Cell[] =>
    units.map((unit): Cell => {
      const cell: Cell = { unit, state: undefined, json: undefined, view: null, failed: false };
      try {
        cell.state = unit.init();
      } catch (error) {
        fail(cell, error);
      }
      return cell;
    });

  const valueOf = (cell: Cell): ProjectionValue =>
    cell.failed
      ? { key: cell.unit.key, version: cell.unit.stateVersion, view: null, failed: true }
      : { key: cell.unit.key, version: cell.unit.stateVersion, view: cell.view };

  const session = (seed: Iterable<SessionEvent> = []): ProjectionSession => {
    const cells = open();
    for (const event of seed) for (const cell of cells) advance(cell, event);
    // seed 之後才算第一次 view：seed 折進來的值是「已經在那裡的」，不算變更。
    for (const cell of cells) if (!cell.failed) refresh(cell);
    return {
      push(event) {
        const changed: ProjectionValue[] = [];
        for (const cell of cells) {
          const moved = advance(cell, event);
          if (cell.failed) {
            // 剛在這顆事件上被停用才回報；先前就停用的 advance 回 false。
            if (moved) changed.push(valueOf(cell));
            continue;
          }
          if (moved && refresh(cell)) changed.push(valueOf(cell));
        }
        return changed;
      },
      current: () => cells.map(valueOf),
    };
  };

  return {
    fold: (events) => session(events).current(),
    session,
  };
}

/**
 * native 的 root 以空函式取代的格：封閉清單，一條一條寫理由與決策出處。那一格的節點照留、照扣一格遞迴預算、照吐一筆（空的）
 * update，只是什麼都不做；兩個 loop 的節點序列與遞迴預算因此一致，人話超過門檻時那一筆 update 的內容不同。`langgraph` 與子代理（native 下仍是 LangGraph 子圖，
 * TODO(#2359)）照舊跑基座的實作。
 *
 * 往清單加一條要先經過決策；`native-noop-cells.test.ts` 列舉整份清單，多一條、少一條都紅。
 *
 * @module
 */

import type { LoopMiddleware } from './middleware.js';

/** 可以換成空函式的格。 */
export type NativeNoopPart = 'beforeAgent';

/** 清單上的一條。 */
export interface NativeNoopCell {
  /** middleware 的名字。 */
  readonly middleware: string;
  /** 換成空函式的那一格。 */
  readonly part: NativeNoopPart;
  /** 為什麼 native 不跑基座的實作。 */
  readonly reason: string;
  /** 決策出處。 */
  readonly decision: string;
}

/**
 * native 的 root 以空函式取代的格。
 *
 * `FilesystemMiddleware.beforeAgent`（#1827 D234）：理由見 `reason`；`/goal` 的續行輪不經宿主的入口（TODO(#2558)）。
 * 節點照留，是因為 native 的遞迴預算照 langgraph 的節點數算。TODO(#2363)：拿掉 langgraph 時，
 * 這一格連同這份清單一起拿掉。
 */
export const NATIVE_NOOP_CELLS: readonly NativeNoopCell[] = Object.freeze([
  Object.freeze({
    middleware: 'FilesystemMiddleware',
    part: 'beforeAgent',
    reason:
      '基座把超過 200,000 字的最後一則人話搬到 /conversation_history；native 改在宿主收人話的入口拒收（human-message-admission.ts），不搬',
    decision: '#1827 D234',
  }),
]);

/**
 * 這一格在不在清單上。
 * @param middleware - middleware 的名字。
 * @param part - 那一格。
 */
export function isNativeNoopCell(middleware: string, part: string): boolean {
  return NATIVE_NOOP_CELLS.some((cell) => cell.middleware === middleware && cell.part === part);
}

/** 取代清單上那一格的空函式：不改 state、不寫檔。 */
const noop = (): undefined => undefined;

/**
 * native 實際跑的那一份：名字在清單上的，清單上的格換成什麼都不做、回 `undefined` 的函式，其餘照讀原物件；不在清單上的原樣回。
 *
 * @param middleware - 組裝好的那一顆。
 * @returns native 要跑的那一份。
 * @throws {Error} 名字在清單上、卻沒有清單上的那一格：基座換了形狀，這條宣告已經不對。
 */
export function withNativeNoopCells(middleware: LoopMiddleware): LoopMiddleware {
  const parts = NATIVE_NOOP_CELLS.filter((cell) => cell.middleware === middleware.name).map(
    (cell) => cell.part,
  );
  if (parts.length === 0) return middleware;
  const view = Object.create(middleware) as Record<string, unknown>;
  for (const part of parts) {
    if (middleware[part] === undefined) {
      throw new Error(
        `middleware "${middleware.name}" 沒有 ${part}，native 以空函式取代的清單（NATIVE_NOOP_CELLS）跟它對不上`,
      );
    }
    Object.defineProperty(view, part, { value: noop, enumerable: true });
  }
  return view as unknown as LoopMiddleware;
}

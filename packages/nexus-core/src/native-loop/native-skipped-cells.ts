/**
 * native 的 root 不跑的格：封閉清單，一條一條寫理由與決策出處。`langgraph` 與子代理（native 下仍是 LangGraph 子圖，
 * TODO(#2359)）照舊跑整顆。
 *
 * 往清單加一條要先經過決策；`native-skipped-cells.test.ts` 列舉整份清單，多一條、少一條都紅。
 *
 * @module
 */

import type { LoopMiddleware } from './onion.js';

/** 可以不跑的格。 */
export type NativeSkippedPart = 'beforeAgent';

/** 清單上的一條。 */
export interface NativeSkippedCell {
  /** middleware 的名字。 */
  readonly middleware: string;
  /** 不跑的那一格。 */
  readonly part: NativeSkippedPart;
  /** 為什麼 native 不跑它。 */
  readonly reason: string;
  /** 決策出處。 */
  readonly decision: string;
}

/** native 的 root 不跑的格。 */
export const NATIVE_SKIPPED_CELLS: readonly NativeSkippedCell[] = Object.freeze([
  Object.freeze({
    middleware: 'FilesystemMiddleware',
    part: 'beforeAgent',
    reason:
      '基座把超過 200,000 字的最後一則人話搬到 /conversation_history；native 改在宿主收人話的入口拒收（human-message-admission.ts），不搬',
    decision: '#1827 D234',
  }),
]);

/**
 * native 實際跑的那一份：名字在清單上的，清單上的格讀到 `undefined`，其餘照讀原物件；不在清單上的原樣回。
 *
 * @param middleware - 組裝好的那一顆（洋蔥驅動的那一份）。
 * @returns native 要跑的那一份。
 * @throws {Error} 名字在清單上、卻沒有清單上的那一格：基座換了形狀，這條宣告已經不對。
 */
export function withoutNativeSkippedCells(middleware: LoopMiddleware): LoopMiddleware {
  const parts = NATIVE_SKIPPED_CELLS.filter((cell) => cell.middleware === middleware.name).map(
    (cell) => cell.part,
  );
  if (parts.length === 0) return middleware;
  const view = Object.create(middleware) as Record<string, unknown>;
  for (const part of parts) {
    if (middleware[part] === undefined) {
      throw new Error(
        `middleware "${middleware.name}" 沒有 ${part}，native 不跑的清單（NATIVE_SKIPPED_CELLS）跟它對不上`,
      );
    }
    Object.defineProperty(view, part, { value: undefined, enumerable: true });
  }
  return view as unknown as LoopMiddleware;
}

/**
 * `<nexus-chat>` 的宿主頁工具（#2374，設計 `.docs/host-page-tools-2374-design-2026-11-03.md`）：宿主頁設 `hostTools` 宣告工具，每一句送出時
 * 放進 `run.start` 的 `host_tools`；模型叫了其中一支，元件在元素上發 {@link HOST_TOOL_EVENT}，宿主頁執行後呼叫 `respond` 或 `fail` 交回。
 * 上限與形狀照 wire 的 `hostToolsProblem`，結果的大小由 server 驗。
 *
 * @module
 */
import type { HostToolDeclaration, HostToolResponse } from '@nexus/wire';
import { hostToolResponseProblem, hostToolsProblem } from '@nexus/wire';

/** 模型叫了一支宿主頁工具時，元素發的事件名。 */
export const HOST_TOOL_EVENT = 'nexus-host-tool';

/** 叫到的名字不在這個元件目前的宣告裡（例如重新整理後的頁面沒宣告它）時，元件自己交回的錯誤。 */
export const HOST_TOOL_MISSING_ERROR = '這個頁面沒有這支工具';

/** {@link HOST_TOOL_EVENT} 的 `detail`，就是 `nexus-chat.d.ts` 給宿主頁的那份全域型別：元件交出去的物件照它檢查，對不上就編不過。 */
export type NexusHostToolDetail = globalThis.NexusHostToolDetail;

/**
 * 宿主頁給的值 → 元件用的宣告。`null`、`undefined`、空陣列是清掉；不合 `hostToolsProblem` 的不收，規矩同 `context`：講一聲、原本的不動。
 *
 * @returns `undefined` 是清掉；`{ problem }` 是不收及原因。
 */
export function parseHostTools(
  value: unknown,
): readonly HostToolDeclaration[] | undefined | { readonly problem: string } {
  if (value === null || value === undefined) return undefined;
  const problem = hostToolsProblem(value);
  if (problem !== undefined) return { problem };
  const tools = value as readonly HostToolDeclaration[];
  return tools.length === 0 ? undefined : tools;
}

/**
 * 宿主頁交給 `respond` 的值包成 `input.respond` 的回應。不是 JSON 值（函式、`undefined`、循環參照）的改成錯誤交回：照原樣送，server 會回
 * `invalid_argument`、那顆中斷照樣掛著，模型要等到逾時才知道。
 */
export function hostToolSuccess(result: unknown): HostToolResponse {
  let problem: string | undefined;
  try {
    problem = hostToolResponseProblem({ ok: true, result });
  } catch (error) {
    problem = `宿主頁的結果不能序列化：${error instanceof Error ? error.message : String(error)}`;
  }
  return problem === undefined ? { ok: true, result } : { ok: false, error: problem };
}

/**
 * 子代理的工具允許／拒絕清單（[#707](https://github.com/DemianLi/nexus-agent/issues/707)）。
 *
 * ## 照 dsh
 *
 * dsh 的 `tool-subagent` 有一格 `toolFilter: { allow?, deny? }`，作用在那個委派工具派出的**每個**子代理；
 * 實作是 base `tools` 的 `restrict(filter)`（`packages/core/tools/src/index.ts:1097`，`477b4f4`）：
 *
 * - `allow` 只留列到的、`deny` 拿掉列到的，可並用；
 * - 空 filter 拋錯、未知名字拋錯並列出已知名單；
 * - **只遮繼承來的全域工具**，子代理自己那一層註冊的不受影響。
 *
 * 這個檔只有**純的部分**：驗 filter、判一個名字留不留、以及遮基座工具的那顆 middleware。registry 工具的扣除在
 * {@link ./fold.ts} 的 `foldSubAgents`。
 *
 * ## 基座工具為什麼要另外一顆 middleware
 *
 * 檔案系統工具不在 registry 裡，是子代理 middleware stack 裡 `createFilesystemMiddleware` 帶的
 * （`apps/harness/src/base-tools.ts`）。要「從請求消失、叫了也不執行」，只能在它的外側攔：
 * `wrapModelCall` 把名字從 `request.tools` 拿掉，`wrapToolCall` 對手寫的呼叫回一則錯誤結果、工具本體不跑。
 * 形狀同 deepagents 內部（沒有公開匯出）的 `createToolExclusionMiddleware`。
 *
 * **偏離（登記）：基座檔案工具的系統提示段落仍會描述被遮掉的工具。** dsh 的提示是從可見工具現算的，所以濾掉的
 * 工具從提示消失；基座那段檔案系統說明是固定文字，我們攔不到它的內文（不替換基座的 `createFilesystemMiddleware`，
 * 它的 backend、`permissions`、驅逐門檻、meta 與錯誤層要逐項對齊，代價遠大於收益）。模型照提示叫被遮的工具，
 * 會拿到一則說明原因的錯誤結果，不會執行。
 *
 * @module
 */

import { createMiddleware } from 'langchain';

import type { AgentMiddleware } from './base-types.js';
import { toolRefusal } from './tool-events.js';

/** middleware 的名字。名字不撞基座任何一個，所以它是 novel entry。 */
export const SUBAGENT_TOOL_FILTER_MIDDLEWARE_NAME = 'nexusSubagentToolFilter';

/**
 * 一份工具過濾：`allow` 只留列到的，`deny` 拿掉列到的，可並用。**`allow: []` 是「一個都不留」**，不是沒講
 * （dsh 的 schema 註解寫明：預設成空陣列會遮光所有工具，所以省略要保持 `undefined`）。
 */
export interface ToolFilter {
  readonly allow?: readonly string[];
  readonly deny?: readonly string[];
}

/**
 * 驗一份過濾：至少有一邊、每個名字都認得。
 *
 * 照 dsh：`allow`、`deny` 都沒給（`{}`）拋錯，那幾乎一定是設定被物化成空物件的 bug；未知名字拋錯並列出已知名單。
 * 給了空陣列不拋：`allow: []` 是遮光所有繼承來的工具。
 *
 * @param filter - 要驗的過濾。
 * @param known - 名字宇宙：**只收可被遮的繼承來的**（全域註冊的工具加基座工具名）。子代理自己那一層的名字不在裡面，
 *   照 dsh（`restrictableNames` 只含 inherited）：遮不到的東西列了就是寫錯。
 * @throws {Error} 空過濾，或有名字不在宇宙裡。
 */
export function assertToolFilter(filter: ToolFilter, known: ReadonlySet<string>): void {
  if (filter.allow === undefined && filter.deny === undefined) {
    throw new Error(
      '子代理的工具過濾不能是空的：allow 與 deny 至少要給一個（拿掉這一格，或把它填上）',
    );
  }
  const allow = filter.allow ?? [];
  const deny = filter.deny ?? [];
  const listing = [...known].sort().join('、');
  for (const [field, names] of [
    ['allow', allow],
    ['deny', deny],
  ] as const) {
    for (const name of names) {
      if (!known.has(name)) {
        throw new Error(
          `子代理的工具過濾 ${field} 列了不認得的工具 "${name}"（已知的：${listing}）`,
        );
      }
    }
  }
}

/**
 * 這個名字過了過濾嗎（留下來）。
 *
 * 給了 `allow`（含空陣列）時，沒列到的不留；`deny` 列到的不留。兩邊都列到同一個名字時 `deny` 贏。
 */
export function toolKept(filter: ToolFilter, name: string): boolean {
  if (filter.deny?.includes(name) === true) return false;
  return filter.allow === undefined || filter.allow.includes(name);
}

/** 叫到被遮掉的工具，回給模型的那一句。 */
export function filteredToolRefusal(name: string): string {
  return `工具 "${name}" 在這個子代理上被設定遮掉了，這次呼叫沒有生效。`;
}

/**
 * 建一顆把 `hidden` 裡的工具從請求拿掉、叫了也不執行的 middleware。
 *
 * 逐個子代理各建一份（`hidden` 不同的話）；本身無狀態。
 *
 * @param hidden - 要遮的工具名（基座工具，registry 工具另走 `foldSubAgents`）。
 */
export function createSubagentToolFilterMiddleware(hidden: ReadonlySet<string>): AgentMiddleware {
  return createMiddleware({
    name: SUBAGENT_TOOL_FILTER_MIDDLEWARE_NAME,
    wrapModelCall: (request, handler) =>
      handler({
        ...request,
        tools: request.tools.filter((each) => {
          const name = (each as { name?: unknown }).name;
          return typeof name !== 'string' || !hidden.has(name);
        }),
      }),
    wrapToolCall: (request, handler) => {
      const name = request.toolCall.name;
      if (!hidden.has(name)) return handler(request);
      return toolRefusal(filteredToolRefusal(name), { callId: request.toolCall.id ?? '', name });
    },
  });
}

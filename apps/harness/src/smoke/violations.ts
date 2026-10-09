/**
 * 冒煙回歸的「過程違反」清單（[#436](https://github.com/DemianLi/nexus-agent/issues/436)，量測規則 5／T7-08）。
 *
 * 外部檢查（重讀檔案）判「成功」的案例，另外拿會話日誌對這份**事先寫好的**禁止事件清單；中了就算「判成功、但過程違反」。
 * 清單在第一次真模型實跑之前就進版控，事後看了結果再補不算量測。
 *
 * dsh 沒有這個量測：它的 e2e 只有逐案斷言（`docs/testing.md:35`），沒有比例。我們做，是因為只讀終態的判準
 * 看不見「答對了但過程是歪的」（工具報錯後碰巧補救、被重試救回來、順手動了不該動的檔）。
 *
 * ## 清單
 *
 * - `tool-error`：任何一顆 `tool/result` 的 `isError`。
 * - `llm-retry`：出現 `llm/retry`——結果對，但是靠重打救回來的。
 * - `turn-failed`：出現 `turn/failed`（該案例預期的中止不算，見 {@link ViolationOptions.expectAbort}）。
 * - `approval-asked`：出現 `approval/asked`。冒煙案例都在可寫根之內，預期一次核准都不用問。
 * - `unexpected-tool`：呼叫了不在 {@link ViolationOptions.allowedTools} 裡的工具（例如跑指令、派子代理）。
 * - `over-call-cap`：`model/start` 的數量超過該案例的上限（打轉）。
 *
 * 哨兵檔被改是外部檢查的事（日誌看不到），由案例自己算進違反，見 `serve-smoke.smoke.ts`。
 *
 * @module
 */

import type { SessionEvent } from '@nexus/core';

export type ViolationKind =
  | 'tool-error'
  | 'llm-retry'
  | 'turn-failed'
  | 'approval-asked'
  | 'unexpected-tool'
  | 'over-call-cap'
  | 'sentinel-changed';

/** 一件違反：種類與指名（哪個工具、哪一顆事件），報告用。 */
export interface Violation {
  readonly kind: ViolationKind;
  readonly detail: string;
}

export interface ViolationOptions {
  /** 這個案例允許的工具名；冒煙案例只讀寫檔案。 */
  readonly allowedTools: ReadonlySet<string>;
  /** 一個案例最多幾次模型呼叫（`model/start`）。 */
  readonly maxModelCalls: number;
  /** 案例本來就要中止（取消案例）：`turn/failed` 不算違反。 */
  readonly expectAbort?: boolean;
}

/** 冒煙案例允許的工具：讀、寫、列目錄。 */
export const FILE_TOOLS: ReadonlySet<string> = new Set([
  'read_file',
  'write_file',
  'edit_file',
  'ls',
  'glob',
  'grep',
]);

/**
 * 掃一份會話日誌，列出中了清單的每一件。
 *
 * @param events - 一條 thread 的 root 日誌。
 * @param options - 該案例的允許與上限。
 * @returns 空陣列＝過程乾淨。
 */
export function findViolations(
  events: readonly SessionEvent[],
  options: ViolationOptions,
): Violation[] {
  const found: Violation[] = [];
  let modelCalls = 0;
  for (const event of events) {
    switch (event.type) {
      case 'tool/result':
        if (event.data.isError) {
          found.push({ kind: 'tool-error', detail: `callId ${event.data.callId}` });
        }
        break;
      case 'llm/retry':
        found.push({ kind: 'llm-retry', detail: `第 ${String(event.data.retry)} 次` });
        break;
      case 'turn/failed':
        if (options.expectAbort !== true)
          found.push({ kind: 'turn-failed', detail: `seq ${event.seq}` });
        break;
      case 'approval/asked':
        found.push({ kind: 'approval-asked', detail: event.data.toolName });
        break;
      case 'tool/call':
        if (!options.allowedTools.has(event.data.name)) {
          found.push({ kind: 'unexpected-tool', detail: event.data.name });
        }
        break;
      case 'model/start':
        modelCalls += 1;
        break;
      default:
        break;
    }
  }
  if (modelCalls > options.maxModelCalls) {
    found.push({
      kind: 'over-call-cap',
      detail: `${String(modelCalls)} 次，上限 ${String(options.maxModelCalls)}`,
    });
  }
  return found;
}

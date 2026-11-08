/**
 * 等人回答的服務（[#2358](https://github.com/DemianLi/nexus-agent/issues/2358)）：工具呼叫裡要停下來問人的地方，await 這裡的
 * {@link HumanInput.ask}，答覆就是它的回傳值。
 *
 * 由 agent loop 放在節點 config 的 `configurable` 上（{@link HUMAN_INPUT_CONFIG_KEY}），用 {@link humanInputOf} 讀。今天只有 native loop
 * 放（`native-loop/suspension.ts`）；`langgraph` 那條讀不到，照舊用 LangGraph 的 `interrupt()`。
 *
 * 對外的樣子同 `interrupt()`：一顆呼叫問了人、而且同一批其餘的呼叫都停著（在問人，或用 {@link HumanInput.idle} 等著要人答了才會動的
 * 東西）時，這次 run 交出 `updates` 的 `__interrupt__` 就收尾，run 留在記憶體裡等答覆。答覆經 `streamEvents(new Command({ resume }))`
 * 送回同一顆 id，這次 await 接著往下跑，不從頭重跑。
 *
 * @module
 */

import { GraphInterrupt } from '@langchain/langgraph';

/** agent loop 把服務放在 `configurable` 的這個鍵上。 */
export const HUMAN_INPUT_CONFIG_KEY = 'nexus_human_input';

/** 一顆工具呼叫拿到的等人服務。 */
export interface HumanInput {
  /**
   * 問人，等答覆。
   * @param value - 問題的酬載，原樣交給 `input.requested`，同 `interrupt(value)` 的參數。
   * @returns 人的答覆，同 `interrupt()` 的回傳值。
   * @throws {HumanInputWithdrawn} 還沒答就被收回（停止、收線）。
   */
  ask(value: unknown): Promise<unknown>;
  /**
   * 等一件要人答了才會動的事（例：排在一顆正在問人的呼叫後面）。等的期間這顆呼叫不算在跑，同一批其餘的都停著時照樣交出中斷。
   * @param waiting - 要等的那件事。
   * @returns 它的值。
   */
  idle<T>(waiting: Promise<T>): Promise<T>;
  /**
   * 這顆呼叫的提問拿到答覆時叫 `listener`，在答覆交回 {@link HumanInput.ask} 之前、同步叫。給記日誌的那一層在接回那一輪補記用。
   * @param listener - 每拿到一次答覆叫一次。
   * @returns 取消登記。
   */
  onAnswered(listener: () => void): () => void;
}

/**
 * 讀節點 config 上的等人服務。
 * @param config - 節點或工具拿到的 config。
 * @returns 服務；這個 loop 沒放就是 `undefined`。
 */
export function humanInputOf(config: unknown): HumanInput | undefined {
  const configurable = (config as { configurable?: Record<string, unknown> } | null | undefined)
    ?.configurable;
  const value = configurable?.[HUMAN_INPUT_CONFIG_KEY];
  return isHumanInput(value) ? value : undefined;
}

function isHumanInput(value: unknown): value is HumanInput {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as HumanInput).ask === 'function' &&
    typeof (value as HumanInput).idle === 'function' &&
    typeof (value as HumanInput).onAnswered === 'function'
  );
}

/**
 * 還沒答就被收回：{@link HumanInput.ask} 以它拒絕。是 `GraphInterrupt`，所以閘門、圍堵、屏障、工具節點都當成控制流往外拋，
 * 不記 `tool/result`、不套寫入；收回那一側自己寫日誌與對話（`apps/harness` 的 pump 的 `#withdraw`）。
 */
export class HumanInputWithdrawn extends GraphInterrupt {
  constructor() {
    super([]);
  }
}

/**
 * @param error - 任何值。
 * @returns 是 {@link HumanInputWithdrawn} 就是 `true`。
 */
export function isHumanInputWithdrawn(error: unknown): error is HumanInputWithdrawn {
  return error instanceof HumanInputWithdrawn;
}

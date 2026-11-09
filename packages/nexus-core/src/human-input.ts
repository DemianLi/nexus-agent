/**
 * 等人回答的服務（[#2358](https://github.com/DemianLi/nexus-agent/issues/2358)）：工具呼叫裡要停下來問人的地方，await 這裡的
 * {@link HumanInput.ask}，答覆就是它的回傳值。
 *
 * 由 agent loop 放在節點 config 的 `configurable` 上（{@link HUMAN_INPUT_CONFIG_KEY}），用 {@link humanInputOf} 讀。native loop 在每顆呼叫上都放：
 * 帶 thread 的 `streamEvents` 那一次 run 放服務（`native-loop/agent.ts` 的 `#toolStep`，服務本身在 `native-loop/suspension.ts`），前景子代理的呼叫
 * 經叫起它的那顆 `task` 呼叫的委派拿同一次 run 的服務；其餘的 run 放 {@link NO_HUMAN_INPUT}。`langgraph` 一律不放，用 LangGraph 的 `interrupt()`。
 *
 * **停在等待點**的定義：同一批起跑了的呼叫裡，沒有一顆在自己往前跑（都在 {@link HumanInput.ask}，或在 {@link HumanInput.idle} 等），
 * 而且至少一顆在問人。那一刻這一段串流交出 `updates` 的 `__interrupt__` 就收尾，run 留在記憶體裡等答覆，對外的樣子同
 * `interrupt()`。答覆經 `streamEvents(new Command({ resume }))` 送回同一顆 id，這次 await 接著往下跑，不從頭重跑。
 *
 * **都在 `idle`、沒有一顆在問人**照理不會發生：`idle` 等的是要人答了才會動的事，沒人在問就永遠不會動。它判成錯誤，這次 run 以那個錯
 * 失敗，不靜靜掛著。
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
   * @throws {HumanInputWithdrawn} 還沒答就被收回（停止、收線）；收回之後再問也當場拒絕。要原樣往外拋，不要接住：接住了正常回傳，
   *   這顆呼叫就算完成，寫入照套。
   * @throws {DOMException} 同一批有一顆失敗、這一批因此中止時，以中止的原因（`AbortError`）拒絕；之後再問也是，收回或這顆收完之後
   *   則改以 {@link HumanInputWithdrawn}。
   */
  ask(value: unknown): Promise<unknown>;
  /**
   * 等一件要人答了才會動的事（例：排在一顆正在問人的呼叫後面，`tool-barrier.ts`）。等的期間這顆呼叫不算在跑，同一批其餘的都停著時
   * 照樣交出中斷。
   * @param waiting - 要等的那件事。
   * @returns 它的值。
   * @throws `waiting` 拒絕的那個錯。都在 `idle`、沒有一顆在問人時，以判成的那個錯拒絕。收回時先讓它跟著別顆的拒絕落定，下一個
   *   `setImmediate` 還沒落定的以 {@link HumanInputWithdrawn} 拒絕；收回之後再等也當場拒絕。這一批中止時（同 {@link HumanInput.ask}）
   *   以中止的原因拒絕，之後再等也是。
   */
  idle<T>(waiting: Promise<T>): Promise<T>;
  /**
   * 這顆呼叫停在 {@link HumanInput.ask} 上、這次 run 被接回時叫 `listener`：這一顆答到了沒都叫（沒答到的照舊掛著），同 LangGraph
   * 接回時把同一批還沒收完的呼叫都從頭重進一次。同一次接回裡，每一顆的 `listener` 都叫完才交回任何答覆，同步叫。給記日誌的那一層在
   * 接回那一輪補記用。`listener` 拋錯時，這顆的 `ask` 以同一個錯拒絕。
   * @param listener - 每接回一次叫一次。
   * @returns 取消登記。
   */
  onResumed(listener: () => void): () => void;
}

/**
 * 讀節點 config 上的等人服務。
 * @param config - 節點或工具拿到的 config。
 * @returns 服務；沒放、或放的是 {@link NO_HUMAN_INPUT}，都是 `undefined`，要分辨兩者用 {@link humanInputUnavailable}。
 */
export function humanInputOf(config: unknown): HumanInput | undefined {
  const configurable = (config as { configurable?: Record<string, unknown> } | null | undefined)
    ?.configurable;
  const value = configurable?.[HUMAN_INPUT_CONFIG_KEY];
  return isHumanInput(value) ? value : undefined;
}

/**
 * 「這裡沒人可問」：native loop 讀不到等人服務的呼叫在 {@link HUMAN_INPUT_CONFIG_KEY} 上放這個（帶 thread 的 `streamEvents` 之外的 run，
 * 含那種 run 裡的前景子代理），
 * `langgraph` 一律不放。讀到它的生產者不退回 LangGraph 的 `interrupt()`：閘門走沒有核准管道那一格，工具的 `exec.interrupt` 以
 * `@nexus/tools` 的 `HumanInputUnavailable` 拒絕。
 */
export const NO_HUMAN_INPUT: unique symbol = Symbol('nexus.humanInput.unavailable');

/**
 * @param config - 節點或工具拿到的 config。
 * @returns 放的是 {@link NO_HUMAN_INPUT} 就是 `true`。
 */
export function humanInputUnavailable(config: unknown): boolean {
  const configurable = (config as { configurable?: Record<string, unknown> } | null | undefined)
    ?.configurable;
  return configurable?.[HUMAN_INPUT_CONFIG_KEY] === NO_HUMAN_INPUT;
}

/**
 * 一顆呼叫等人的時間（含等完之後排隊取回併發名額）：可暫停的工具時限（`native-loop/tool-node.ts`）照它停表，逾時措辭的「等了多久」
 * 扣掉它（`containment.ts`、`tool-pipeline.ts`）。掛在服務物件的 {@link WAIT_CLOCK} 上，不在 {@link HumanInput} 介面裡。
 */
export interface WaitClock {
  /** 到現在為止累計等了多久（毫秒），正在等的那一段也算進去。 */
  readonly waitedMs: number;
  /**
   * 開始等（`true`）與等完、拿回名額（`false`）時叫。
   * @param listener - 收狀態。
   * @returns 取消登記。
   */
  onWaiting(listener: (waiting: boolean) => void): () => void;
}

/** 服務物件上放 {@link WaitClock} 的鍵。 */
export const WAIT_CLOCK = Symbol('nexus.humanInput.waitClock');

/**
 * @param config - 節點或工具拿到的 config。
 * @returns 那顆呼叫的 {@link WaitClock}；讀不到服務或服務沒帶就是 `undefined`。
 */
export function waitClockOf(config: unknown): WaitClock | undefined {
  const service = humanInputOf(config) as { [WAIT_CLOCK]?: WaitClock } | undefined;
  return service?.[WAIT_CLOCK];
}

/**
 * 從現在起算這顆呼叫等了多久。
 * @param config - 節點或工具拿到的 config。
 * @returns 每次叫都回從建立這個函式到當下之間等的毫秒數；讀不到 {@link WaitClock} 時一律 0。
 */
export function waitedSince(config: unknown): () => number {
  const clock = waitClockOf(config);
  if (clock === undefined) return () => 0;
  const from = clock.waitedMs;
  return () => clock.waitedMs - from;
}

function isHumanInput(value: unknown): value is HumanInput {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as HumanInput).ask === 'function' &&
    typeof (value as HumanInput).idle === 'function' &&
    typeof (value as HumanInput).onResumed === 'function'
  );
}

/**
 * 還沒答就被收回、或那顆呼叫已經收完：{@link HumanInput.ask}、{@link HumanInput.idle} 以它拒絕。是 `GraphInterrupt`，所以閘門、圍堵、屏障都當成控制流往外拋，不記
 * `tool/result`。不套寫入靠的是 native 的 `#toolStep` 看到收回過了就丟掉這一步。日誌與對話由收回那一側寫：停止時是
 * `apps/harness` 的 pump 的 `#withdraw`；收線（`close()`）兩樣都不寫。
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

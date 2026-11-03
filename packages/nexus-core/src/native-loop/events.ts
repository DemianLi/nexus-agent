/**
 * native loop 的四個 agent 事件（[#2356](https://github.com/DemianLi/nexus-agent/issues/2356)）：名字與派發方式照 dsh 的
 * `agent/pre-step`、`agent/request-error`、`agent/turn-stopping`、`llm/stream`（`packages/extensions/tool-cordis/src/api-catalog.ts`
 * 的事件目錄，`8bd07339`）。生產者是 `agent.ts`，只在 `--agent-loop=native` 下派發；今天沒有監聽者，沒有監聽者時每一個都直通。
 *
 * 載荷比 dsh 少：K6 期間訊息還住在 LangGraph 形狀的 state 裡、由 middleware 洋蔥改，所以 `agent/pre-step` 不帶 `messages`、
 * `llm/stream` 環繞的是一次 `invoke` 而不是串流。K7 #2357 把 middleware 搬成這些事件的監聽者時再補齊，契約可能跟著改。
 *
 * @module
 */

/** `agent/pre-step` 的決定。`next()` 回 `continue`。 */
export type PreStepDecision =
  { readonly kind: 'continue' } | { readonly kind: 'reject'; readonly reason: string };

/** `agent/request-error` 的決定：`retry` 再打一次這一步的模型呼叫，`undefined` 讓這次失敗收掉這一輪。 */
export type RequestErrorAction = { readonly kind: 'retry' } | undefined;

/** 每個 agent 事件都帶的那幾格。 */
export interface AgentStepPayload {
  /** 這條 thread。 */
  readonly threadId: string;
  /** 這次 run 裡的第幾步（模型呼叫），從 1 起算。 */
  readonly step: number;
  /** 這一輪的中止訊號。 */
  readonly signal: AbortSignal;
}

declare module '../events.js' {
  interface Events {
    /**
     * 每一步呼叫模型之前：回 `{ kind: 'reject', reason }` 這一輪收成被擋下（`TurnBlockedError`），`next()` 照常進這一步。
     * @param payload - thread、步數、中止訊號。
     * @param next - 往內一位；最內層回 `continue`。
     * @mode waterfall
     */
    'agent/pre-step'(
      payload: AgentStepPayload,
      next: () => Promise<PreStepDecision>,
    ): Promise<PreStepDecision>;
    /**
     * 一次模型呼叫失敗之後（經過整串 `wrapModelCall`，含 stream-retry 自己的重試）：回 `{ kind: 'retry' }` 再打一次，
     * `next()` 交給下一位；最內層回 `undefined`，失敗收掉這一輪。
     * @param payload - thread、步數、中止訊號，加上這次的錯。
     * @param next - 往內一位。
     * @mode waterfall
     */
    'agent/request-error'(
      payload: AgentStepPayload & { readonly error: unknown },
      next: () => Promise<RequestErrorAction>,
    ): Promise<RequestErrorAction>;
    /**
     * 這一輪要收了（模型沒叫工具、所有 `afterAgent` 都跑過）：依序 await，回傳值不看。
     * @param payload - thread、這一輪最後一步的步數、中止訊號。
     * @mode serial
     */
    'agent/turn-stopping'(payload: AgentStepPayload): Promise<void> | void;
    /**
     * 環繞每一次 root 的模型呼叫（洋蔥最內層，綁好工具之後）。`next()` 打模型並回 AI 訊息，只能呼叫一次；不呼叫 `next()`
     * 而回自己的訊息即短路。
     * @param payload - thread、步數、中止訊號。
     * @param next - 打模型。
     * @mode waterfall
     */
    'llm/stream'(payload: AgentStepPayload, next: () => Promise<unknown>): Promise<unknown>;
  }
}

export {};

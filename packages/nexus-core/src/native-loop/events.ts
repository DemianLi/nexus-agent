/**
 * native loop 的四個 agent 事件（[#2356](https://github.com/DemianLi/nexus-agent/issues/2356)）：`agent/pre-step`、`agent/request-error`、
 * `agent/turn-stopping`、`llm/stream`。生產者是 `agent.ts`，在 `--agent-loop=native` 下派發；`agent/turn-stopping` 與 `agent/pre-step` 在
 * `langgraph` 下另由 `turn-stopping.ts`、`pre-step-adapter.ts` 的轉接格派。監聽者有 `agent/turn-stopping`（`@nexus/plugin-workspace-changes`）
 * 與 `agent/pre-step`（`@nexus/plugin-plan-mode`，經 `ToolThread.on`）；`@nexus/agent-loop` 同名的 pre-step listener 經宿主建成
 * `beforeAgent` middleware，不聽這個事件。沒有監聽者時每一個都直通。
 *
 * 訊息還住在 LangGraph 形狀的 state 裡、由 middleware 登記的那幾步改，所以 `agent/pre-step` 不帶 `messages`。TODO(#2363)：訊息搬出
 * LangGraph 形狀的 state、那幾步搬成這些事件的監聽者時補上，契約可能跟著改。模型層還是 LangChain 的 chat model（`model-node.ts`
 * 呼叫它的 `invoke`），所以 `llm/stream` 環繞的是一次 `invoke` 而不是串流。TODO(#2361)：模型轉接器換掉時改成環繞串流。
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
  /** 這條 thread；沒給 `configurable.thread_id` 的一輪是 `undefined`。 */
  readonly threadId: string | undefined;
  /** 第幾次 `agent/pre-step`，從 1 起算；`afterAgent` 跳回模型那次沿用上一步；還沒派過 pre-step 時（`beforeAgent` 跳 `end` 之後）是 0。 */
  readonly step: number;
  /** 這一輪的中止訊號。 */
  readonly signal: AbortSignal;
}

declare module '../events.js' {
  interface Events {
    /**
     * 每一步進 `beforeModel` 之前（`afterAgent` 跳回模型那次不派）：回 `{ kind: 'reject', reason }` 這一輪收成被擋下（`TurnBlockedError`），`next()` 照常進這一步。
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
     * 這一輪正常收尾（`afterAgent` 跑完、沒有跳回模型）時依序 await，回傳值不看；`beforeModel` 跳 `end` 或這一輪拋錯時不派。
     * 只對 root 派。`langgraph` 下由轉接格派（`turn-stopping.ts`），**`step` 一律是 `0`**：那邊沒有 `agent/pre-step` 可數。
     * @param payload - thread、這一輪最後一步的步數（`langgraph` 下是 `0`）、中止訊號。
     * @mode serial
     */
    'agent/turn-stopping'(payload: AgentStepPayload): Promise<void> | void;
    /**
     * 環繞每一次 root 的模型呼叫（`wrapModelCall` 那一串的最內層，綁好工具之後）。`next()` 打模型並回 AI 訊息，只能呼叫一次；不呼叫 `next()`
     * 而回自己的訊息即短路。
     * @param payload - thread、步數、中止訊號。
     * @param next - 打模型。
     * @mode waterfall
     */
    'llm/stream'(payload: AgentStepPayload, next: () => Promise<unknown>): Promise<unknown>;
  }
}

export {};

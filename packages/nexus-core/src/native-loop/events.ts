/**
 * native loop 的四個 agent 事件（[#2356](https://github.com/DemianLi/nexus-agent/issues/2356)）：`agent/pre-step`、`agent/request-error`、
 * `agent/turn-stopping`、`llm/stream`。生產者是 `agent.ts`，在 `--agent-loop=native` 下派發；`agent/turn-stopping` 與 `agent/pre-step` 在
 * `langgraph` 下另由 `turn-stopping.ts`、`pre-step-adapter.ts` 的轉接格派。監聽者有 `agent/turn-stopping`（`@nexus/plugin-workspace-changes`）
 * 與 `agent/pre-step`（`@nexus/plugin-plan-mode`，經 `ToolThread.on`）；`@nexus/agent-loop` 同名的 pre-step listener 經宿主建成
 * `beforeAgent` middleware，不聽這個事件。沒有監聽者時每一個都直通。
 *
 * 訊息還住在 LangGraph 形狀的 state 裡、由 middleware 登記的那幾步改，所以 `agent/pre-step` 不帶 `messages`。TODO(#2363)：訊息搬出
 * LangGraph 形狀的 state、那幾步搬成這些事件的監聽者時補上，契約可能跟著改。
 *
 * @module
 */

/** `agent/pre-step` 的決定。`next()` 回 `continue`。 */
export type PreStepDecision =
  { readonly kind: 'continue' } | { readonly kind: 'reject'; readonly reason: string };

/** `agent/request-error` 的決定：`retry` 再打一次這一步的模型呼叫，`undefined` 讓這次失敗收掉這一輪。 */
export type RequestErrorAction = { readonly kind: 'retry' } | undefined;

/**
 * `llm/stream` 交給監聽者的一顆 chunk：OpenAI Chat Completions 串流 chunk 的形狀，端點送什麼就是什麼，不翻譯。
 * 只寫監聽者會讀的格；`apps/harness` 的型別測試釘住 `openai` SDK 的 `ChatCompletionChunk` 能指派過來。
 * `reasoning_content` 不在 SDK 的型別裡，所以是選填；`id`、`model` 選填，短路的監聽者可以不給。
 */
export interface ModelStreamChunk {
  readonly id?: string;
  readonly model?: string;
  readonly choices: readonly {
    readonly index: number;
    readonly delta?: {
      readonly role?: string | null;
      readonly content?: string | null;
      readonly reasoning_content?: string | null;
      readonly tool_calls?: readonly {
        readonly index: number;
        readonly id?: string;
        readonly type?: string;
        readonly function?: { readonly name?: string; readonly arguments?: string };
      }[];
    };
    readonly finish_reason?: string | null;
  }[];
  readonly usage?: {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly total_tokens: number;
    readonly prompt_tokens_details?: { readonly cached_tokens?: number } | null;
    readonly completion_tokens_details?: { readonly reasoning_tokens?: number } | null;
  } | null;
}

/** 環繞一次模型請求的串流：拿到打端點的 `next`，回交給模型的 chunk 串流。 */
export type ModelStreamAround = (
  next: () => AsyncIterable<ModelStreamChunk>,
) => AsyncIterable<ModelStreamChunk>;

/**
 * 這次模型呼叫的 {@link ModelStreamAround} 放在 config 的 `configurable` 底下的這個鍵（native 的 `model-node.ts` 放，模型取）。
 * `__` 開頭：LangChain 把 `configurable` 抄進 tracer metadata 時跳過這種鍵；`configurable` 本身不進 callback 的參數。
 */
export const LLM_STREAM_CONFIG_KEY = '__nexus_llm_stream';

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
     * 環繞每一次模型請求的串流（`wrapModelCall` 那一串的最內層，綁好工具之後），root 與子代理（前景、背景）的都派，native 下一律打串流請求。
     * `next()` 送出請求並回端點的 chunk 串流，只能呼叫一次；監聽者回的串流就是模型收到的。不呼叫 `next()`、自己 yield chunk 即短路，
     * 請求不送；但這一步的 `request/*` 與 `model/start` 在派發之前已經寫進日誌，用量照 yield 的 `usage` 記。
     *
     * 模型要從這次呼叫 config 的 `configurable[LLM_STREAM_CONFIG_KEY]` 取出環繞函式、包住自己的串流；沒取的模型在 native 下這次呼叫拋錯
     * （`model-node.ts`），`langgraph` 下不派、不檢查。
     * @param payload - thread、步數、中止訊號。
     * @param next - 送出請求，回 chunk 串流。
     * @mode waterfall
     */
    'llm/stream'(
      payload: AgentStepPayload,
      next: () => AsyncIterable<ModelStreamChunk>,
    ): AsyncIterable<ModelStreamChunk>;
  }
}

export {};

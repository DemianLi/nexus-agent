/**
 * native agent loop（[#2356](https://github.com/DemianLi/nexus-agent/issues/2356)）：不經 LangGraph 的 Pregel，自己跑 turn／step。
 *
 * middleware 洋蔥還在（#1827 D189 (a)，[#2357](https://github.com/DemianLi/nexus-agent/issues/2357) 拆掉）：每一步照 langchain `createAgent` 的節點順序跑它（`onion.ts`），日誌、圍堵、重試照舊由
 * middleware 寫與做。對 pump 交出跟 LangGraph 同形的 v3 事件（`protocol.ts`），所以 `thread-pump.ts` 不必分兩條路。
 *
 * 一次 run 的順序（同 `ReactAgent.js` 的邊）：
 *
 * ```
 * beforeAgent[0..n] → ┌ agent/pre-step → beforeModel[0..n] → model → 有工具呼叫 → tools ┐
 *                     └──────────────────────────────── 回到 agent/pre-step ───────────────┘
 *                     沒有工具呼叫，或工具結果要收這一輪 → afterAgent[n..0] → agent/turn-stopping
 * ```
 *
 * `afterAgent` 回 `jumpTo: 'model'`（插話）就跳過 `beforeModel` 直接再叫模型，同 LangGraph 的 `Send(model_request)`。
 *
 * 不支援（[#2358](https://github.com/DemianLi/nexus-agent/issues/2358)、[#2359](https://github.com/DemianLi/nexus-agent/issues/2359)）：中斷與 resume（沒有存檔點，核准管道在組裝點就判成 `no-channel`）、`afterModel`（樹上沒有）。
 *
 * @module
 */

import { randomUUID } from 'node:crypto';

import type { BaseMessage } from '@langchain/core/messages';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { Command, GraphRecursionError, isCommand } from '@langchain/langgraph';

import { TurnBlockedError } from '../archive-gate.js';
import type { EventDispatcher } from '../events.js';
import { turnCancelSignalOf } from '../turn-cancel.js';
import './events.js';
import type { AgentStepPayload } from './events.js';
import {
  callModel,
  NodeTask,
  runHook,
  runTool,
  systemMessageOf,
  type InvokableTool,
  type JumpTarget,
  type LoopMiddleware,
} from './onion.js';
import { NativeStreamHandler, ProtocolEmitter, type NativeProtocolEvent } from './protocol.js';
import { emptyState, StateChannels, type LoopState } from './state.js';

/** {@link createNativeAgent} 的參數，同 `createAgent` 用得到的那幾格。 */
export interface NativeAgentParams {
  readonly model: unknown;
  readonly systemPrompt?: string;
  readonly tools: readonly unknown[];
  readonly middleware: readonly unknown[];
  /** 派發四個 agent 事件；不給就不派發（每一個都直通）。 */
  readonly events?: EventDispatcher;
}

/** `withConfig` 收的那兩格：LangGraph 的步數上限與並行上限，語意照舊。 */
interface LoopDefaults {
  readonly recursionLimit?: number;
  readonly maxConcurrency?: number;
}

/** LangGraph 的預設步數上限。 */
const DEFAULT_RECURSION_LIMIT = 25;

/** 沒給 `maxConcurrency` 時同一步的工具全部一起起跑，同 LangGraph。 */
const UNBOUNDED = Number.POSITIVE_INFINITY;

/** 一次 run 收到的輸入。 */
type LoopInput = { readonly messages?: readonly BaseMessage[] } | Command;

/** 一次 run 的觀察者：v3 事件、CLI 的 updates。 */
interface RunObserver {
  readonly emitter?: ProtocolEmitter;
  readonly onUpdate?: (node: string, update: Record<string, unknown>) => void;
}

/** 名字以 `extract-` 開頭的工具呼叫是結構化輸出，不進 tools（同 `ReactAgent.js`）。nexus 不用，照抄判準。 */
function liveToolCalls(message: AIMessage): NonNullable<AIMessage['tool_calls']> {
  return (message.tool_calls ?? []).filter((call) => !call.name.startsWith('extract-'));
}

/** 同 LangGraph 的 `GraphRecursionError` 訊息與錯誤碼，CLI 的退出碼與 eval 的分類照舊認得。 */
function recursionError(limit: number): GraphRecursionError {
  return new GraphRecursionError(
    [
      `Recursion limit of ${limit} reached`,
      'without hitting a stop condition. You can increase the',
      `limit by setting the "recursionLimit" config key.`,
    ].join(' '),
    { lc_error_code: 'GRAPH_RECURSION_LIMIT' },
  );
}

/**
 * 依上限跑一批工作，**照索引起跑**：前面的先佔名額。屏障（`tool-barrier.ts`）等的是排在前面的呼叫，後面的先佔滿名額會互等。
 * 有一顆拋了就 abort `step`、排著的不再起跑，等跑著的收完再拋第一個錯，同 LangGraph 的 `PregelRunner.tick`。
 */
function runBounded<T>(
  jobs: readonly (() => Promise<T>)[],
  limit: number,
  step: AbortController,
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const results = new Array<T>(jobs.length);
    let next = 0;
    let running = 0;
    let failure: { readonly reason: unknown } | undefined;
    const settle = (): void => {
      if (running > 0) return;
      if (failure !== undefined) reject(failure.reason);
      else if (next >= jobs.length) resolve(results);
    };
    const start = (): void => {
      while (failure === undefined && next < jobs.length && running < limit) {
        const index = next++;
        running += 1;
        jobs[index]!().then(
          (value) => {
            results[index] = value;
          },
          (reason: unknown) => {
            if (failure !== undefined) return;
            failure = { reason };
            step.abort();
          },
        ).finally(() => {
          running -= 1;
          start();
          settle();
        });
      }
    };
    start();
    settle();
  });
}

/** 用來計步：每一個「節點那一格」算一步，算法同 LangGraph 的 super-step（同一步的工具合起來算一格）。 */
class StepBudget {
  #used = 0;

  constructor(private readonly limit: number) {}

  /** 進下一格；超過上限就拋。 */
  take(): void {
    this.#used += 1;
    if (this.#used > this.limit) throw recursionError(this.limit);
  }
}

/** state 對外的樣子，同 LangGraph 的 `StateSnapshot` 用得到的幾格。 */
export interface NativeStateSnapshot {
  readonly values: LoopState;
  readonly next: readonly string[];
  readonly tasks: readonly unknown[];
  readonly config: RunnableConfig;
}

/**
 * native loop 的 agent。成員是 harness 實際叫的那幾個（`streamEvents`、`stream`、`invoke`、`getState`、`updateState`、`withConfig`），
 * 形狀同 LangGraph 編出來的圖。
 */
export class NativeAgent {
  readonly #params: NativeAgentParams;
  readonly #threads: Map<string, LoopState>;
  readonly #defaults: LoopDefaults;
  /** 這張圖的 middleware，照組裝順序。 */
  readonly middleware: readonly LoopMiddleware[];
  readonly #tools: readonly InvokableTool[];
  readonly #returnDirect: ReadonlySet<string>;
  readonly #channels: StateChannels;

  /**
   * @param params - 模型、提示詞、工具、middleware。
   * @param threads - thread 的 state；`withConfig` 出來的那一份共用同一張表。
   * @param defaults - `withConfig` 給的上限。
   */
  constructor(
    params: NativeAgentParams,
    threads = new Map<string, LoopState>(),
    defaults: LoopDefaults = {},
  ) {
    this.#params = params;
    this.#threads = threads;
    this.#defaults = defaults;
    this.middleware = params.middleware as readonly LoopMiddleware[];
    const unsupported = this.middleware.find((m) => m.afterModel !== undefined);
    if (unsupported !== undefined) {
      throw new Error(`native agent loop 不支援 afterModel（middleware "${unsupported.name}"）`);
    }
    const middlewareTools = this.middleware.flatMap(
      (m) => ((m as { tools?: readonly unknown[] }).tools ?? []) as readonly InvokableTool[],
    );
    this.#tools = [...(params.tools as readonly InvokableTool[]), ...middlewareTools];
    this.#returnDirect = new Set(
      this.#tools.filter((t) => t.returnDirect === true).map((t) => t.name),
    );
    this.#channels = new StateChannels(this.middleware);
  }

  /**
   * 疊上 LangGraph 那兩格上限，回一個共用 thread state 的新 agent。
   * @param config - `recursionLimit`、`maxConcurrency`。
   */
  withConfig(config: LoopDefaults): NativeAgent {
    return new NativeAgent(this.#params, this.#threads, { ...this.#defaults, ...config });
  }

  /**
   * 讀一條 thread 的 state。沒跑過的 thread 回空的 state。
   * @param config - 帶 `configurable.thread_id`。
   */
  async getState(config: RunnableConfig): Promise<NativeStateSnapshot> {
    const state = this.#threads.get(threadIdOf(config));
    return {
      values: state === undefined ? emptyState() : { ...state, messages: [...state.messages] },
      next: [],
      tasks: [],
      config,
    };
  }

  /**
   * 寫一份更新進 thread 的 state，套各鍵的合併規則（`messages` 同 id 取代、其餘附加）。
   * @param config - 帶 `configurable.thread_id`。
   * @param values - 要寫的鍵。
   */
  async updateState(
    config: RunnableConfig,
    values: Record<string, unknown>,
  ): Promise<RunnableConfig> {
    this.#channels.apply(this.#stateOf(threadIdOf(config)), values);
    return config;
  }

  /**
   * 跑一次，回最後的 state。
   * @param input - `{ messages }`。
   * @param config - 帶 `configurable.thread_id`。
   */
  async invoke(input: LoopInput, config: RunnableConfig = {}): Promise<LoopState> {
    return this.#run(input, config, {});
  }

  /**
   * CLI 那條：`streamMode: ['updates', 'values']`，每個節點寫完吐一次 `['updates', { 節點: 寫入 }]`，最後吐 `['values', state]`。
   * @param input - `{ messages }`。
   * @param config - 帶 `configurable.thread_id`。
   */
  async stream(
    input: LoopInput,
    config: RunnableConfig = {},
  ): Promise<AsyncIterable<[string, unknown]>> {
    const queue = new AsyncQueue<[string, unknown]>();
    void this.#run(input, config, {
      onUpdate: (node, update) => queue.push(['updates', { [node]: update }]),
    }).then(
      (state) => {
        queue.push(['values', state]);
        queue.close();
      },
      (error: unknown) => queue.fail(error),
    );
    return queue;
  }

  /**
   * pump 那條：v3 事件，形狀同 LangGraph 的 `streamEvents({ version: 'v3' })`（`protocol.ts`）。迭代到底就是這次 run 結束；
   * 失敗時先吐 root `lifecycle failed` 再拋。
   * @param input - `{ messages }`。
   * @param config - 帶 `configurable.thread_id` 與 pump 的三把鍵。
   */
  async streamEvents(
    input: LoopInput,
    config: RunnableConfig & { readonly version?: string },
  ): Promise<AsyncIterable<NativeProtocolEvent>> {
    const queue = new AsyncQueue<NativeProtocolEvent>();
    const emitter = new ProtocolEmitter((event) => queue.push(event));
    void this.#run(input, config, { emitter }).then(
      () => queue.close(),
      (error: unknown) => queue.fail(error),
    );
    return queue;
  }

  #stateOf(threadId: string): LoopState {
    let state = this.#threads.get(threadId);
    if (state === undefined) {
      state = emptyState();
      this.#threads.set(threadId, state);
    }
    return state;
  }

  async #run(input: LoopInput, config: RunnableConfig, observer: RunObserver): Promise<LoopState> {
    const { emitter } = observer;
    emitter?.lifecycle('running');
    try {
      const state = await this.#turn(input, config, observer);
      emitter?.lifecycle('completed');
      return state;
    } catch (error) {
      emitter?.lifecycle('failed', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async #turn(input: LoopInput, config: RunnableConfig, observer: RunObserver): Promise<LoopState> {
    if (isCommand(input)) {
      throw new Error(
        'native agent loop 不支援 resume：沒有可接回的中斷（#2358）',
      );
    }
    // 沒給 thread 的一輪從空的 state 跑、跑完不留，同 LangGraph 沒有存檔點時。
    const threadId = optionalThreadIdOf(config);
    const state = threadId === undefined ? emptyState() : this.#stateOf(threadId);
    this.#channels.apply(state, { messages: [...(input.messages ?? [])] });
    this.#channels.fillDefaults(state);

    const signal = turnCancelSignalOf(config) ?? new AbortController().signal;
    // 呼叫時給的贏過 `withConfig` 的，同 LangGraph 的 `ensureLangGraphConfig(this.config, options)`。兩格都留在節點的 config 上：
    // 工具裡跑的 LangGraph 子圖（前景子代理）從執行脈絡讀同一個上限。
    const recursionLimit =
      config.recursionLimit ?? this.#defaults.recursionLimit ?? DEFAULT_RECURSION_LIMIT;
    const maxConcurrency = config.maxConcurrency ?? this.#defaults.maxConcurrency;
    const base = this.#baseConfig(config, observer.emitter, recursionLimit, maxConcurrency);
    const budget = new StepBudget(recursionLimit);
    const events = this.#params.events;
    // `signal` 是這一步自己的（一顆拋了 abort 兄弟），跟這次 run 的合起來。
    const node = (name: string, taskInput: unknown = state, signal?: AbortSignal): NodeTask => {
      const ns = `${name}:${randomUUID()}`;
      const config =
        signal === undefined
          ? base
          : { ...base, signal: base.signal === undefined ? signal : AbortSignal.any([base.signal, signal]) };
      return new NodeTask(config, ns, name, state, this.#channels, taskInput, () =>
        observer.emitter?.complete([ns]),
      );
    };
    const note = (name: string, update: Record<string, unknown>): void =>
      observer.onUpdate?.(name, update);

    // `beforeAgent` 跳 `end`：同 LangGraph 落到 exitNode，`afterAgent` 照跑，也照樣能跳回模型。
    let exiting = false;
    for (const m of this.middleware) {
      if (m.beforeAgent === undefined) continue;
      budget.take();
      const jump = await runHook(m, 'beforeAgent', node(`${m.name}.before_agent`), this.#channels);
      if (jump === 'end') {
        exiting = true;
        break;
      }
    }

    let step = 0;
    let skipBeforeModel = false;
    for (;;) {
      if (exiting) {
        exiting = false;
      } else {
        if (!skipBeforeModel) {
          step += 1;
          const payload: AgentStepPayload = { threadId, step, signal };
          const decision =
            events === undefined
              ? { kind: 'continue' as const }
              : await events.waterfall('agent/pre-step', payload, async () => ({
                  kind: 'continue' as const,
                }));
          if (decision.kind === 'reject') throw new TurnBlockedError();
          let ended = false;
          for (const m of this.middleware) {
            if (m.beforeModel === undefined) continue;
            budget.take();
            const jump: JumpTarget = await runHook(
              m,
              'beforeModel',
              node(`${m.name}.before_model`),
              this.#channels,
            );
            if (jump === 'end') {
              ended = true;
              break;
            }
          }
          // 從 `beforeModel` 跳 `end` 直接到 END，`afterAgent` 不跑（同 `ReactAgent.js` 的 beforeModel router）。
          if (ended) return state;
        }
        skipBeforeModel = false;

        budget.take();
        const ai = await this.#modelStep(state, threadId, step, signal, node, note);
        const calls = ai === undefined ? [] : liveToolCalls(ai);
        let concluded = calls.length === 0;
        if (!concluded) {
          budget.take();
          concluded = await this.#toolStep(calls, state, node, note);
        }
        if (!concluded) continue;
      }

      const again = await this.#exit(node, budget);
      if (again) {
        skipBeforeModel = true;
        continue;
      }
      if (events !== undefined) {
        await events.serial('agent/turn-stopping', { threadId, step, signal });
      }
      return state;
    }
  }

  /**
   * `afterAgent` 反序跑（最後一顆先）。回 `true` 表示有一顆跳回模型。
   */
  async #exit(node: (name: string) => NodeTask, budget: StepBudget): Promise<boolean> {
    for (let i = this.middleware.length - 1; i >= 0; i--) {
      const m = this.middleware[i]!;
      if (m.afterAgent === undefined) continue;
      budget.take();
      const jump = await runHook(m, 'afterAgent', node(`${m.name}.after_agent`), this.#channels);
      if (jump === 'model') return true;
      if (jump === 'end') return false;
    }
    return false;
  }

  async #modelStep(
    state: LoopState,
    threadId: string | undefined,
    step: number,
    signal: AbortSignal,
    node: (name: string) => NodeTask,
    note: (name: string, update: Record<string, unknown>) => void,
  ): Promise<AIMessage | undefined> {
    // 剛跑完要收這一輪的工具：同 `AgentNode` 的 returnDirect 檢查，不叫模型。
    const last = state.messages.at(-1);
    if (
      ToolMessage.isInstance(last) &&
      last.name !== undefined &&
      this.#returnDirect.has(last.name)
    ) {
      return undefined;
    }
    const events = this.#params.events;
    const payload: AgentStepPayload = { threadId, step, signal };
    for (;;) {
      const task = node('model_request');
      try {
        const { message, commands } = await callModel(
          {
            model: this.#params.model,
            systemMessage: systemMessageOf(this.#params.systemPrompt),
            tools: this.#tools,
            middleware: this.middleware,
            ...(events !== undefined && {
              around: (call) => events.waterfall('llm/stream', payload, call) as Promise<AIMessage>,
            }),
          },
          task,
        );
        task.flush();
        const update = message === undefined ? {} : { messages: [message] };
        this.#channels.apply(state, update);
        for (const command of commands) this.#applyCommand(state, command);
        note('model_request', update);
        return message;
      } catch (error) {
        task.writes.length = 0;
        const action =
          events === undefined
            ? undefined
            : await events.waterfall(
                'agent/request-error',
                { ...payload, error },
                async () => undefined,
              );
        if (action?.kind === 'retry') continue;
        throw error;
      }
    }
  }

  /**
   * 一批工具：每顆一個節點、照上限起跑、結果照 `tool_calls` 的順序寫回。回 `true` 表示這一輪要收（最後一則結果是 returnDirect
   * 工具帶著名字回來的，同 `ReactAgent.js` 的 tools router）。
   */
  async #toolStep(
    calls: NonNullable<AIMessage['tool_calls']>,
    state: LoopState,
    node: (name: string, taskInput?: unknown, signal?: AbortSignal) => NodeTask,
    note: (name: string, update: Record<string, unknown>) => void,
  ): Promise<boolean> {
    const step = new AbortController();
    const tasks = calls.map((call) => node('tools', { ...state, lg_tool_call: call }, step.signal));
    // 有一顆拋了，整步不寫。
    const settled = await runBounded(
      calls.map((call, index) => () => runTool(call, this.#tools, this.middleware, tasks[index]!)),
      Math.max(1, tasks[0]?.config.maxConcurrency ?? UNBOUNDED),
      step,
    );
    const messages: BaseMessage[] = [];
    settled.forEach((value, index) => {
      tasks[index]!.flush();
      if (isCommand(value)) {
        this.#applyCommand(state, value);
      } else {
        messages.push(value);
      }
    });
    if (messages.length > 0) this.#channels.apply(state, { messages });
    note('tools', { messages });
    const last = state.messages.at(-1);
    return (
      ToolMessage.isInstance(last) && last.name !== undefined && this.#returnDirect.has(last.name)
    );
  }

  #applyCommand(state: LoopState, command: Command): void {
    if (command.goto !== undefined && (!Array.isArray(command.goto) || command.goto.length > 0)) {
      throw new Error('native agent loop 不支援 Command.goto');
    }
    const update = command.update;
    if (update === undefined || update === null) return;
    if (Array.isArray(update)) {
      for (const [key, value] of update as [string, unknown][])
        this.#channels.apply(state, { [key]: value });
      return;
    }
    this.#channels.apply(state, update as Record<string, unknown>);
  }

  #baseConfig(
    config: RunnableConfig,
    emitter: ProtocolEmitter | undefined,
    recursionLimit: number,
    maxConcurrency: number | undefined,
  ): RunnableConfig {
    const callbacks = Array.isArray(config.callbacks) ? [...config.callbacks] : [];
    if (emitter !== undefined) callbacks.push(new NativeStreamHandler(emitter));
    return {
      ...config,
      recursionLimit,
      ...(maxConcurrency !== undefined && { maxConcurrency }),
      callbacks,
      configurable: { ...config.configurable },
      ...(emitter !== undefined && { writer: (chunk: unknown) => emitter.custom(chunk) }),
    } as RunnableConfig;
  }
}

function optionalThreadIdOf(config: RunnableConfig): string | undefined {
  const threadId = config.configurable?.['thread_id'];
  return typeof threadId === 'string' && threadId !== '' ? threadId : undefined;
}

function threadIdOf(config: RunnableConfig): string {
  const threadId = optionalThreadIdOf(config);
  if (threadId === undefined) throw new Error('native agent loop 需要 configurable.thread_id');
  return threadId;
}

/** 一條推拉的佇列：生產者 push，消費者 for-await。 */
class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  #waiting: (() => void) | undefined;
  #done = false;
  #error: { readonly reason: unknown } | undefined;

  push(item: T): void {
    this.#items.push(item);
    this.#wake();
  }

  close(): void {
    this.#done = true;
    this.#wake();
  }

  fail(reason: unknown): void {
    this.#error = { reason };
    this.#done = true;
    this.#wake();
  }

  #wake(): void {
    const waiting = this.#waiting;
    this.#waiting = undefined;
    waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      const item = this.#items.shift();
      if (item !== undefined) {
        yield item;
        continue;
      }
      if (this.#done) {
        if (this.#error !== undefined) throw this.#error.reason;
        return;
      }
      await new Promise<void>((resolve) => {
        this.#waiting = resolve;
      });
    }
  }
}

/**
 * 建一個 native loop 的 agent。
 * @param params - 同 `createAgent` 用得到的那幾格，加上事件派發面。
 */
export function createNativeAgent(params: NativeAgentParams): NativeAgent {
  return new NativeAgent(params);
}

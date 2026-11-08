/**
 * native agent loop（[#2356](https://github.com/DemianLi/nexus-agent/issues/2356)）：不經 LangGraph 的 Pregel，自己跑 turn／step。
 *
 * 節點照 langchain `createAgent` 的順序排，每一格直接呼叫 middleware 上登記的那一步（`hook-node.ts`、`model-node.ts`、
 * `tool-node.ts`）；沒登記、也不在 `native-noop-cells.ts` 清單上的格，建構時就拋。日誌、圍堵、重試由那幾步寫與做，
 * TODO(#2357)：搬成事件與服務。對 pump 交出跟 LangGraph 同形的 v3 事件（`protocol.ts`），所以 `thread-pump.ts` 不必分兩條路。
 *
 * 一次 run 的順序（同 `ReactAgent.js` 的邊）：
 *
 * ```
 * beforeAgent[0..n] → ┌ agent/pre-step → beforeModel[0..n] → model → 有工具呼叫 → tools ┐
 *                     └──────────────────────────────── 回到 agent/pre-step ───────────────┘
 *                     沒有工具呼叫，或工具結果要收這一輪 → afterAgent[n..0] → agent/turn-stopping
 * ```
 *
 * `afterAgent` 回 `jumpTo: 'model'`（插話）就跳過 `agent/pre-step` 與 `beforeModel`、`step` 不加（步數上限照扣一格），直接再叫模型，同 LangGraph 的
 * `Send(model_request)`。
 *
 * 不支援：中斷與 resume（沒有存檔點，核准管道在組裝點判成 `no-channel`，TODO(#2358)）、`afterModel`、`Command.goto`，以及
 * {@link SUPPORTED_JUMPS} 以外的跳轉（建構時拋）。子代理仍是 LangGraph 子圖，TODO(#2359)。
 *
 * @module
 */

import { randomUUID } from 'node:crypto';

import { CallbackManager } from '@langchain/core/callbacks/manager';
import type { Callbacks } from '@langchain/core/callbacks/manager';
import type { SerializedNotImplemented } from '@langchain/core/load/serializable';
import type { BaseMessage } from '@langchain/core/messages';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { Command, GraphRecursionError, isCommand } from '@langchain/langgraph';

import { TurnBlockedError } from '../archive-gate.js';
import type { EventDispatcher } from '../events.js';
import { turnCancelSignalOf } from '../turn-cancel.js';
import { toolCallStepOf, wrapToolCallWith } from '../tool-call-step.js';
import { modelCallStepOf, wrapModelCallFromStep } from '../model-call-step.js';
import { systemPromptCellOf, systemPromptWrapWith } from '../system-prompt-step.js';
import { toolListCellOf, wrapModelCallWith } from '../tool-list-step.js';
import { HOOK_KINDS, hookStepOf, hookWith } from '../hook-step.js';
import './events.js';
import type { AgentStepPayload } from './events.js';
import { abortReason, raceAbort } from './abort.js';
import { NodeTask } from './langgraph-compat.js';
import { runHook } from './hook-node.js';
import { hookTargets, type InvokableTool, type LoopMiddleware } from './middleware.js';
import { callModel, systemMessageOf } from './model-node.js';
import { isNativeNoopCell, withNativeNoopCells } from './native-noop-cells.js';
import { runTool } from './tool-node.js';
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
  /** 節點的 `config.store`，呼叫時給的優先，同 LangGraph。 */
  readonly store?: unknown;
}

/** `withConfig` 收的那兩格：LangGraph 的步數上限與並行上限，語意同 LangGraph。 */
interface LoopDefaults {
  readonly recursionLimit?: number;
  readonly maxConcurrency?: number;
}

/** 各掛鉤支援的跳轉目標；`canJumpTo` 宣告了別的就在建構時拋，不在跑到時靜靜忽略。 */
const SUPPORTED_JUMPS: readonly (readonly [
  'beforeAgent' | 'beforeModel' | 'afterAgent',
  readonly string[],
])[] = [
  ['beforeAgent', ['end']],
  ['beforeModel', ['end']],
  ['afterAgent', ['model', 'end']],
];

/** LangGraph 的預設步數上限。 */
const DEFAULT_RECURSION_LIMIT = 25;

/** 沒給 `maxConcurrency` 時同一步的工具全部一起起跑，同 LangGraph。 */
const UNBOUNDED = Number.POSITIVE_INFINITY;

/** 一次 run 收到的輸入。 */
type LoopInput =
  { readonly messages?: readonly BaseMessage[]; readonly [key: string]: unknown } | Command;

/** 一次 run 的觀察者：v3 事件、CLI 的 updates。 */
interface RunObserver {
  readonly emitter?: ProtocolEmitter;
  readonly onUpdate?: (node: string, update: Record<string, unknown>) => void;
}

/** root chain run 的名字與序列化，同沒取名的 `createAgent` 圖（`Pregel.getName()`）。 */
const ROOT_RUN_NAME = 'LangGraph';
const ROOT_SERIALIZED: SerializedNotImplemented = {
  lc: 1,
  type: 'not_implemented',
  id: ['langgraph', 'CompiledStateGraph'],
};

/** 名字以 `extract-` 開頭的工具呼叫是結構化輸出，不進 tools（同 `ReactAgent.js`）。nexus 不用，照抄判準。 */
function liveToolCalls(message: AIMessage): NonNullable<AIMessage['tool_calls']> {
  return (message.tool_calls ?? []).filter((call) => !call.name.startsWith('extract-'));
}

/** 同 LangGraph 的 `GraphRecursionError` 訊息與錯誤碼，CLI 的退出碼與 eval 的分類認得它。 */
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
function runBounded(
  jobs: readonly (() => Promise<void>)[],
  limit: number,
  step: AbortController,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let next = 0;
    let running = 0;
    let failure: { readonly reason: unknown } | undefined;
    const settle = (): void => {
      if (running > 0) return;
      if (failure !== undefined) reject(failure.reason);
      else if (next >= jobs.length) resolve();
    };
    const start = (): void => {
      while (failure === undefined && next < jobs.length && running < limit) {
        running += 1;
        jobs[next++]!()
          .catch((reason: unknown) => {
            if (failure !== undefined) return;
            failure = { reason };
            step.abort();
          })
          .finally(() => {
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

/**
 * 沒登記一步、也不在 {@link NATIVE_NOOP_CELLS} 上的那一格：native 只呼叫登記了的一步，建構時就拋，不在跑到時才發現。
 * @param middleware - 那一顆。
 * @param part - 那一格。
 */
function unregisteredCell(middleware: LoopMiddleware, part: string): Error {
  return new Error(
    `native agent loop 只跑登記了一步的格：middleware "${middleware.name}" 的 ${part} 沒有登記，也不在 NATIVE_NOOP_CELLS 上`,
  );
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
  /** 清單上的格換成空函式之後的那一份（{@link withNativeNoopCells}），跟 {@link NativeAgent.middleware} 一一對應。 */
  readonly #withNoops: readonly LoopMiddleware[];
  /** 有沒有誰執行 `wrapModelCall` 新加的工具：任一顆有 `wrapToolCall`。 */
  readonly #executesAddedTools: boolean;
  /** 一次工具呼叫由外到內經過的那幾格，照組裝順序，每一格直接呼叫它登記的工具步驟（{@link toolCallStepOf}）。 */
  readonly #toolCells: readonly LoopMiddleware[];
  /**
   * 一次模型呼叫由外到內經過的那幾格，跟 {@link NativeAgent.middleware} 一一對應。有 `wrapModelCall` 的，直接呼叫它登記的那一步：
   * 工具清單（{@link toolListCellOf}，有登記 `inner` 就再交給它）、系統提示（{@link systemPromptCellOf}）或環繞步（{@link modelCallStepOf}）。
   */
  readonly #modelCells: readonly LoopMiddleware[];
  /**
   * `beforeAgent`、`beforeModel`、`afterAgent` 實際跑的那一份，跟 {@link NativeAgent.middleware} 一一對應：登記了一步的 hook
   * （{@link hookStepOf}）換成 native 從那一步造的，清單上的格是空函式。
   */
  readonly #hookCells: readonly LoopMiddleware[];
  readonly #tools: readonly InvokableTool[];
  readonly #returnDirect: ReadonlySet<string>;
  readonly #channels: StateChannels;

  /**
   * @param params - 模型、提示詞、工具、middleware。
   * @param threads - thread 的 state；`withConfig` 出來的那一份共用同一張表。
   * @param defaults - `withConfig` 給的上限。
   * @throws {Error} 有一格沒登記一步、也不在 {@link NATIVE_NOOP_CELLS} 上；或一顆 middleware 在模型那一格登記了不只一步
   * （工具清單、系統提示、環繞步）。
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
    this.#withNoops = this.middleware.map((m) => withNativeNoopCells(m));
    this.#executesAddedTools = this.middleware.some((m) => m.wrapToolCall !== undefined);
    this.#toolCells = this.middleware.flatMap((m) => {
      if (m.wrapToolCall === undefined) return [];
      const step = toolCallStepOf(m);
      if (step === undefined) throw unregisteredCell(m, 'wrapToolCall');
      return [
        {
          name: m.name,
          wrapToolCall: wrapToolCallWith(step) as NonNullable<LoopMiddleware['wrapToolCall']>,
        },
      ];
    });
    this.#modelCells = this.middleware.map((m) => {
      const cell = toolListCellOf(m);
      const prompt = systemPromptCellOf(m);
      const around = modelCallStepOf(m);
      if ([cell, prompt, around].filter((registered) => registered !== undefined).length > 1) {
        throw new Error(
          `middleware "${m.name}" 在模型那一格登記了不只一步（工具清單、系統提示、環繞步），native 只能直接呼叫其中一個`,
        );
      }
      if (m.wrapModelCall === undefined) return m;
      if (around !== undefined) {
        return {
          name: m.name,
          wrapModelCall: wrapModelCallFromStep(around) as NonNullable<
            LoopMiddleware['wrapModelCall']
          >,
        };
      }
      if (cell !== undefined) {
        return {
          name: m.name,
          wrapModelCall: wrapModelCallWith(cell.step, cell.inner as never) as NonNullable<
            LoopMiddleware['wrapModelCall']
          >,
        };
      }
      if (prompt !== undefined) {
        return {
          name: m.name,
          wrapModelCall: systemPromptWrapWith(prompt) as NonNullable<
            LoopMiddleware['wrapModelCall']
          >,
        };
      }
      throw unregisteredCell(m, 'wrapModelCall');
    });
    this.#hookCells = this.middleware.map((m, index) => {
      const withNoops = this.#withNoops[index]!;
      const replaced = HOOK_KINDS.flatMap((kind) => {
        if (m[kind] === undefined || isNativeNoopCell(m.name, kind)) return [];
        const cell = hookStepOf(m, kind);
        if (cell === undefined) throw unregisteredCell(m, kind);
        return [[kind, hookWith(cell)] as const];
      });
      if (replaced.length === 0) return withNoops;
      const view = Object.create(withNoops) as Record<string, unknown>;
      for (const [kind, hook] of replaced) {
        Object.defineProperty(view, kind, { value: hook, enumerable: true });
      }
      return view as unknown as LoopMiddleware;
    });
    for (const m of this.#withNoops) {
      for (const [kind, allowed] of SUPPORTED_JUMPS) {
        const hook = m[kind];
        const extra =
          hook === undefined ? [] : hookTargets(hook).filter((t) => !allowed.includes(t));
        if (extra.length > 0) {
          throw new Error(
            `native agent loop 不支援 ${kind} 跳 ${extra.join('、')}（middleware "${m.name}"）`,
          );
        }
      }
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
   * 讀一條 thread 的 state。沒跑過的 thread 的 `values` 是 `{}`（沒有 `messages`），同 LangGraph 沒有存檔點的 thread。
   * @param config - 帶 `configurable.thread_id`。
   */
  async getState(config: RunnableConfig): Promise<NativeStateSnapshot> {
    const state = this.#threads.get(threadIdOf(config));
    return {
      values: state === undefined ? ({} as LoopState) : { ...state, messages: [...state.messages] },
      next: [],
      tasks: [],
      config,
    };
  }

  /**
   * 寫一份更新進 thread 的 state，套各鍵的合併規則（`state.ts`：`messages` 同 id 取代、`ReducedValue` 用它自己的 reducer、
   * 其餘後寫的贏）。沒有 `stateSchema` 宣告的鍵與 `jumpTo` 丟掉（{@link StateChannels.apply}）。
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
   * 跑一次，回最後的 state，不含 `_` 開頭的私有鍵（{@link outputOf}）。
   * @param input - `{ messages }`，加上不以 `_` 開頭、`stateSchema` 宣告過的鍵（{@link StateChannels.inputOf}）；其餘的鍵丟掉。
   * @param config - 帶 `configurable.thread_id`。
   */
  async invoke(input: LoopInput, config: RunnableConfig = {}): Promise<LoopState> {
    return outputOf(await this.#run(input, config, {}));
  }

  /**
   * CLI 那條：每個節點寫完吐一次 updates（`{ 節點: 寫入 }`，同 LangGraph 的 `streamMode: 'updates'`；hook 節點見 `runHook`，工具每顆
   * 收完各吐一次、`Command` 吐它的 `update`）；結束時吐一次 values（不含 `_` 開頭的鍵），中間各步的 values 不吐。`streamMode`
   * 照 LangGraph：沒給是 `'updates'`（`StateGraph.compile` 的預設），給字串就只吐那一種的內容，給陣列吐 `[mode, 內容]`；`updates`、`values` 以外的拋錯。
   * @param input - `{ messages }`，加上不以 `_` 開頭、`stateSchema` 宣告過的鍵（{@link StateChannels.inputOf}）；其餘的鍵丟掉。
   * @param config - 帶 `configurable.thread_id`。
   */
  async stream(
    input: LoopInput,
    config: RunnableConfig & { readonly streamMode?: string | readonly string[] } = {},
  ): Promise<AsyncIterable<unknown>> {
    const requested = config.streamMode ?? 'updates';
    const modes = typeof requested === 'string' ? [requested] : requested;
    const unsupported = modes.filter((mode) => mode !== 'updates' && mode !== 'values');
    if (unsupported.length > 0) {
      throw new Error(
        `native agent loop 的 stream() 不支援 streamMode：${unsupported.join(', ')}（#2356）`,
      );
    }
    const queue = new AsyncQueue<unknown>();
    const emit = (mode: string, payload: unknown): void => {
      if (!modes.includes(mode)) return;
      queue.push(typeof requested === 'string' ? payload : [mode, payload]);
    };
    void this.#run(input, config, {
      onUpdate: (node, update) => emit('updates', { [node]: update }),
    }).then(
      (state) => {
        emit('values', outputOf(state));
        queue.close();
      },
      (error: unknown) => queue.fail(error),
    );
    return queue;
  }

  /**
   * pump 那條：v3 事件，形狀同 LangGraph 的 `streamEvents({ version: 'v3' })`（`protocol.ts`）。迭代到底就是這次 run 結束；
   * 失敗時先吐 root `lifecycle failed` 再拋。
   * @param input - `{ messages }`，加上不以 `_` 開頭、`stateSchema` 宣告過的鍵（{@link StateChannels.inputOf}）；其餘的鍵丟掉。
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

  /**
   * 一次 run 包在一顆 root chain run 裡，節點拿它的 child callbacks，同 LangGraph `_streamIterator` 的 `handleChainStart`／
   * `handleChainEnd`：tracer（LangSmith）靠 root run 收尾才送出整串。
   */
  async #run(input: LoopInput, config: RunnableConfig, observer: RunObserver): Promise<LoopState> {
    const { emitter } = observer;
    const manager = await CallbackManager.configure(
      config.callbacks,
      undefined,
      config.tags,
      undefined,
      config.metadata,
    );
    const handler = emitter === undefined ? undefined : new NativeStreamHandler(emitter);
    const root = await manager?.handleChainStart(
      ROOT_SERIALIZED,
      input as Record<string, unknown>,
      config.runId,
      undefined,
      undefined,
      undefined,
      config.runName ?? ROOT_RUN_NAME,
    );
    const callbacks: Callbacks = root?.getChild() ?? [];
    if (handler !== undefined) {
      if (Array.isArray(callbacks)) callbacks.push(handler);
      else callbacks.addHandler(handler, true);
    }
    emitter?.lifecycle('running');
    try {
      const state = await this.#turn(input, config, observer, callbacks);
      emitter?.lifecycle('completed');
      await root?.handleChainEnd(outputOf(state));
      return state;
    } catch (error) {
      emitter?.lifecycle('failed', error instanceof Error ? error.message : String(error));
      await root?.handleChainError(error);
      throw error;
    }
  }

  async #turn(
    input: LoopInput,
    config: RunnableConfig,
    observer: RunObserver,
    callbacks: Callbacks,
  ): Promise<LoopState> {
    if (isCommand(input)) {
      throw new Error('native agent loop 不支援 resume：沒有可接回的中斷（#2358）');
    }
    // 呼叫前就已中止：輸入不寫、拋 signal 的 reason，同 LangGraph 拿到已中止的 signal 時。
    if (config.signal?.aborted === true) throw abortReason(config.signal);
    // 沒給 thread 的一輪從空的 state 跑、跑完不留，同 LangGraph 沒有存檔點時。
    const threadId = optionalThreadIdOf(config);
    const state = threadId === undefined ? emptyState() : this.#stateOf(threadId);
    this.#channels.apply(state, {
      ...this.#channels.inputOf(input),
      messages: [...(input.messages ?? [])],
    });
    this.#channels.fillDefaults(state);

    const signal = turnCancelSignalOf(config) ?? new AbortController().signal;
    // 呼叫時給的贏過 `withConfig` 的，同 LangGraph 的 `ensureLangGraphConfig(this.config, options)`。兩格都留在節點的 config 上：
    // 工具裡跑的 LangGraph 子圖（前景子代理）從執行脈絡讀同一個上限。
    const recursionLimit =
      config.recursionLimit ?? this.#defaults.recursionLimit ?? DEFAULT_RECURSION_LIMIT;
    const maxConcurrency = config.maxConcurrency ?? this.#defaults.maxConcurrency;
    const base = this.#baseConfig(
      config,
      callbacks,
      observer.emitter,
      recursionLimit,
      maxConcurrency,
    );
    const budget = new StepBudget(recursionLimit);
    const events = this.#params.events;
    // `stepSignal` 是一批工具共用的（一顆拋了就 abort 兄弟），跟呼叫端的 `config.signal` 合起來；這一輪的中止訊號走
    // `configurable`，不在這裡。
    const node = (name: string, taskInput: unknown = state, stepSignal?: AbortSignal): NodeTask => {
      const ns = `${name}:${randomUUID()}`;
      const config =
        stepSignal === undefined
          ? base
          : {
              ...base,
              signal:
                base.signal === undefined ? stepSignal : AbortSignal.any([base.signal, stepSignal]),
            };
      return new NodeTask(
        config,
        ns,
        name,
        state,
        this.#channels,
        taskInput,
        () => observer.emitter?.complete([ns]),
        stepSignal,
        base.signal,
      );
    };
    const note = (name: string, update: Record<string, unknown>): void =>
      observer.onUpdate?.(name, update);

    // `beforeAgent` 跳 `end`：同 LangGraph 落到 exitNode，`afterAgent` 照跑，也照樣能跳回模型。
    let exiting = false;
    for (const m of this.#hookCells) {
      if (m.beforeAgent === undefined) continue;
      budget.take();
      const name = `${m.name}.before_agent`;
      const { jump, update } = await runHook(m, 'beforeAgent', node(name), this.#channels);
      note(name, update);
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
          for (const m of this.#hookCells) {
            if (m.beforeModel === undefined) continue;
            budget.take();
            const name = `${m.name}.before_model`;
            const { jump, update } = await runHook(m, 'beforeModel', node(name), this.#channels);
            note(name, update);
            if (jump === 'end') {
              ended = true;
              break;
            }
          }
          // 從 `beforeModel` 跳 `end` 直接到 END：`afterAgent` 不跑、`agent/turn-stopping` 不派（同 `ReactAgent.js` 的 beforeModel router）。
          if (ended) return state;
        }
        skipBeforeModel = false;

        budget.take();
        const ai = await this.#modelStep(state, threadId, step, signal, node, note);
        const calls = ai === undefined ? [] : liveToolCalls(ai);
        let concluded = calls.length === 0;
        if (!concluded && ai !== undefined) {
          budget.take();
          concluded = await this.#toolStep(ai, calls, state, node, note, base.signal);
        }
        if (!concluded) continue;
      }

      const again = await this.#exit(node, budget, note);
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
   * `afterAgent` 反序跑（最後一顆先），一顆跳 `end` 其餘不跑。回 `true` 表示有一顆跳回模型。
   */
  async #exit(
    node: (name: string) => NodeTask,
    budget: StepBudget,
    note: (name: string, update: Record<string, unknown>) => void,
  ): Promise<boolean> {
    for (let i = this.#hookCells.length - 1; i >= 0; i--) {
      const m = this.#hookCells[i]!;
      if (m.afterAgent === undefined) continue;
      budget.take();
      const name = `${m.name}.after_agent`;
      const { jump, update } = await runHook(m, 'afterAgent', node(name), this.#channels);
      note(name, update);
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
            middleware: this.#modelCells,
            executesAddedTools: this.#executesAddedTools,
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
        // 呼叫端中止：這個節點的寫入丟掉、不問要不要重試，同 LangGraph 中止的節點。
        if (task.callerSignal?.aborted === true) throw error;
        const action =
          events === undefined
            ? undefined
            : await events.waterfall(
                'agent/request-error',
                { ...payload, error },
                async () => undefined,
              );
        // 重試前看一次這一輪的中止訊號，監聽者一直回 retry 時停止照樣收得掉；重試的次數由監聽者自己限，不算步數。
        if (action?.kind === 'retry' && !signal.aborted) {
          task.writes.length = 0;
          continue;
        }
        task.keepWrites();
        throw error;
      }
    }
  }

  /**
   * 一批工具：每顆一個節點、照上限起跑，結果（`ToolMessage` 或 `Command`）照 `tool_calls` 的順序寫回。回 `true` 表示這一輪要收（最後一則結果是 returnDirect
   * 工具帶著名字回來的，同 `ReactAgent.js` 的 tools router）。
   */
  async #toolStep(
    owner: AIMessage,
    calls: NonNullable<AIMessage['tool_calls']>,
    state: LoopState,
    node: (name: string, taskInput?: unknown, stepSignal?: AbortSignal) => NodeTask,
    note: (name: string, update: Record<string, unknown>) => void,
    caller: AbortSignal | undefined,
  ): Promise<boolean> {
    const step = new AbortController();
    const tasks = calls.map((call) => node('tools', { ...state, lg_tool_call: call }, step.signal));
    const results = new Array<ToolMessage | Command | undefined>(calls.length);
    // 照 `tool_calls` 的順序寫回，同 LangGraph 照 task 的順序套寫入。
    const commit = (keepUnfinishedWrites: boolean): void => {
      tasks.forEach((task, index) => {
        const value = results[index];
        if (value === undefined) {
          if (keepUnfinishedWrites) task.keepWrites();
          return;
        }
        task.flush();
        if (isCommand(value)) {
          this.#applyCommand(state, value);
        } else {
          this.#channels.apply(state, { messages: [value] });
        }
      });
    };
    // 呼叫端已中止就當場拋，不起跑，同 LangGraph `_executeTasksWithRetry` 起跑前那一檢。
    if (caller?.aborted === true) throw new Error('Abort');
    const batch = runBounded(
      calls.map((call, index) => async () => {
        const result = await runTool(call, this.#tools, this.#toolCells, tasks[index]!, owner);
        results[index] = result;
        note('tools', isCommand(result) ? commandUpdateOf(result) : { messages: [result] });
      }),
      Math.max(1, tasks[0]?.config.maxConcurrency ?? UNBOUNDED),
      step,
    );
    try {
      if (caller === undefined) await batch;
      else {
        batch.catch(() => undefined);
        await raceAbort(batch, caller);
      }
    } catch (error) {
      // 一顆失敗：跑完的兄弟結果照寫，沒收完的（含失敗那顆）送出的寫入照套、不算完成，同 LangGraph 把這一步存成 pending writes。
      // 呼叫端中止：只寫回收完的那幾顆，沒收完的寫入丟掉，同 `PregelRunner` 的 `abortPromise`。
      commit(!(caller?.aborted ?? false));
      throw error;
    }
    commit(true);
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
    callbacks: Callbacks,
    emitter: ProtocolEmitter | undefined,
    recursionLimit: number,
    maxConcurrency: number | undefined,
  ): RunnableConfig {
    const store = (config as { store?: unknown }).store ?? this.#params.store;
    return {
      ...withoutRunOptions(config),
      ...(store !== undefined && { store }),
      recursionLimit,
      ...(maxConcurrency !== undefined && { maxConcurrency }),
      callbacks,
      configurable: { ...config.configurable },
      ...(emitter !== undefined && { writer: (chunk: unknown) => emitter.custom(chunk) }),
    } as RunnableConfig;
  }
}

/**
 * 只給這一次 run 的選項，不往節點的 config 傳。LangGraph 的節點也拿不到：`ensureLangGraphConfig` 只留 `CONFIG_KEYS`（`subgraphs`、
 * `encoding`、`debug`、`inputKeys` 不在其中），`_streamIterator` 拿掉 `runId`，`_defaults` 拿掉 `streamMode`、`outputKeys`、
 * `interruptBefore`／`interruptAfter`。漏下去的話，
 * 工具裡再叫一張圖（`task` 叫子代理）會照呼叫端的 `streamMode: [...]` 回一串 chunk，而不是 state。
 */
const RUN_OPTION_KEYS = [
  'runId',
  'debug',
  'streamMode',
  'inputKeys',
  'outputKeys',
  'interruptBefore',
  'interruptAfter',
  'subgraphs',
  'encoding',
] as const;

function withoutRunOptions(config: RunnableConfig): RunnableConfig {
  const rest: Record<string, unknown> = { ...config };
  for (const key of RUN_OPTION_KEYS) delete rest[key];
  return rest as RunnableConfig;
}

/** 回給呼叫端的 state：`_` 開頭的鍵是 middleware 私有的，不輸出（state 裡照留），同 langchain `createAgentState` 的 output 欄位。 */
function outputOf(state: LoopState): LoopState {
  return Object.fromEntries(
    Object.entries(state).filter(([key]) => !key.startsWith('_')),
  ) as LoopState;
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

/** 一顆工具回的 `Command` 在 updates 裡的樣子：它的 `update`，tuple 陣列攤成物件。 */
function commandUpdateOf(command: Command): Record<string, unknown> {
  const update = command.update;
  if (update === undefined || update === null) return {};
  if (Array.isArray(update)) return Object.fromEntries(update as [string, unknown][]);
  return update as Record<string, unknown>;
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

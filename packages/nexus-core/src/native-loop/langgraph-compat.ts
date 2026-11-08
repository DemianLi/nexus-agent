/**
 * native loop 模擬 LangGraph 節點的執行環境：`getConfig()`、`getCurrentTaskInput()` 與 deepagents 零參數的 `StateBackend`
 * （`__pregel_read`／`__pregel_send`）在 native 下讀到的 config 由這裡合成。只為了讓 LangChain、LangGraph、deepagents 的物件能在
 * native 下跑而存在，TODO(#2363)：K13 換掉這些物件時拿掉這個檔。
 *
 * @module
 */

import type { RunnableConfig } from '@langchain/core/runnables';
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';

import { raceAbort } from './abort.js';
import type { LoopState, StateChannels } from './state.js';

/**
 * 一個節點（一顆 hook、一次模型呼叫、一顆工具）的執行環境：合成的 config，加上這個節點經 `__pregel_send` 送出、
 * 還沒套進 state 的寫入（同 LangGraph：節點結束才套；`__pregel_read(…, true)` 看得到自己的）。
 */
export class NodeTask {
  readonly writes: [string, unknown][] = [];
  readonly config: RunnableConfig;

  /**
   * @param base - 這次 run 的 config（configurable、callbacks、signal、writer）。
   * @param checkpointNs - 這個節點的命名空間（`model_request:<id>`、`tools:<id>`）。
   * @param node - 節點名。
   * @param state - 節點開始時的 state。
   * @param channels - 合併規則。
   * @param taskInput - `getCurrentTaskInput()` 讀到的值。
   * @param onFlush - 節點寫回之後（{@link NodeTask.flush}）。
   * @param stepSignal - 同一批工具共用、一顆拋了就舉起來的訊號；工具進 `invoke` 前看它。
   * @param callerSignal - 呼叫端的 `config.signal`；{@link NodeTask.run} 照它中止這個節點。
   */
  constructor(
    base: RunnableConfig,
    checkpointNs: string,
    node: string,
    readonly state: LoopState,
    private readonly channels: StateChannels,
    taskInput: unknown,
    private readonly onFlush?: () => void,
    readonly stepSignal?: AbortSignal,
    readonly callerSignal?: AbortSignal,
  ) {
    this.config = {
      ...base,
      metadata: { ...base.metadata, langgraph_node: node, langgraph_checkpoint_ns: checkpointNs },
      configurable: {
        ...base.configurable,
        checkpoint_ns: checkpointNs,
        __pregel_send: (writes: [string, unknown][]) => {
          this.writes.push(...writes);
        },
        __pregel_read: (channel: string, fresh?: boolean) => this.#read(channel, fresh === true),
        __pregel_scratchpad: { currentTaskInput: taskInput },
      },
    };
  }

  #read(channel: string, fresh: boolean): unknown {
    if (!fresh) return this.state[channel];
    const view: LoopState = { messages: this.state.messages, [channel]: this.state[channel] };
    for (const [key, value] of this.writes) {
      if (key === channel) this.channels.apply(view, { [key]: value });
    }
    return view[channel];
  }

  /**
   * 在這個節點的 config 裡跑，照呼叫端的 signal 中止，同 LangGraph 的一個節點（`PregelRunner` 起跑前那一檢，加上節點那串
   * `RunnableSequence` 的 `raceWithSignal`）：起跑前已中止拋 `Abort`；跑著時中止拋 signal 的 reason（`abort.ts` 的 `abortReason`），
   * 這個節點的寫入不套。不多包一層 `async`：兄弟失敗時 `stepSignal` 要趕在兄弟進工具之前舉起來（`tool-node.ts` 的 `runTool`）。
   * @param body - 要跑的東西。
   * @returns 它的結果。
   */
  run<T>(body: () => Promise<T>): Promise<T> {
    const signal = this.callerSignal;
    if (signal?.aborted === true) return Promise.reject(new Error('Abort'));
    const running = AsyncLocalStorageProviderSingleton.runWithConfig(
      this.config,
      body,
    ) as Promise<T>;
    return signal === undefined ? running : raceAbort(running, signal);
  }

  /** 節點結束：把經 `__pregel_send` 送出的寫入套進 state。 */
  flush(): void {
    this.keepWrites();
    this.onFlush?.();
  }

  /**
   * 把經 `__pregel_send` 送出的寫入套進 state 並清空，不叫 `onFlush`（節點不算完成）；`flush` 與失敗、沒收完的路徑共用。
   * LangGraph 把失敗 task 的寫入連同 `ERROR` 存成 pending writes，`getState` 與之後的 `updateState` 會套上（例如摘要器先寫的
   * 歷史檔）；native 當場套進 state。
   */
  keepWrites(): void {
    for (const [key, value] of this.writes) this.channels.apply(this.state, { [key]: value });
    this.writes.length = 0;
  }
}

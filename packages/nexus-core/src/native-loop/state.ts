/**
 * native loop 的 thread state：每個 `thread_id` 一份放在記憶體，取代 LangGraph 的存檔點（[#2356](https://github.com/DemianLi/nexus-agent/issues/2356)）。
 *
 * 鍵與合併規則從 middleware 的 `stateSchema` 收：`messages` 走 LangGraph 的 `messagesStateReducer`（同 id 取代、`RemoveMessage`），
 * `StateSchema` 裡的 `ReducedValue`（`files`、`skillsMetadata`）用它自己的 reducer，其餘後寫的贏。預設值照 langchain
 * `#initializeMiddlewareStates`：輪頭補上缺的鍵。
 *
 * @module
 */

import type { BaseMessage } from '@langchain/core/messages';
import { getInteropZodObjectShape, isInteropZodObject } from '@langchain/core/utils/types';
import {
  getSchemaDefaultGetter,
  messagesStateReducer,
  ReducedValue,
  StateSchema,
} from '@langchain/langgraph';

/** 一格的合併規則：舊值、新寫入 → 新值。 */
type Reducer = (current: unknown, update: unknown) => unknown;

/** state 的一份值。`messages` 一定在。 */
export interface LoopState {
  messages: BaseMessage[];
  [key: string]: unknown;
}

/** 有 `stateSchema` 的那幾顆 middleware 的形狀。 */
interface WithStateSchema {
  readonly stateSchema?: unknown;
}

/** 從 middleware 收出來的鍵：誰有 reducer、誰有預設值。 */
export class StateChannels {
  readonly #reducers = new Map<string, Reducer>();
  readonly #defaults = new Map<string, () => unknown>();

  /**
   * @param middleware - 組裝好的那一串 middleware。
   */
  constructor(middleware: readonly WithStateSchema[]) {
    this.#reducers.set('messages', messagesStateReducer as Reducer);
    for (const entry of middleware) this.#collect(entry.stateSchema);
  }

  #collect(schema: unknown): void {
    if (schema === undefined || schema === null) return;
    if (StateSchema.isInstance(schema)) {
      for (const [key, field] of Object.entries(
        (schema as { fields: Record<string, unknown> }).fields,
      )) {
        if (ReducedValue.isInstance(field)) {
          const reduced = field as unknown as { reducer: Reducer; valueSchema: unknown };
          this.#reducers.set(key, reduced.reducer);
          this.#noteDefault(key, reduced.valueSchema);
        } else {
          this.#noteDefault(key, field);
        }
      }
      return;
    }
    if (isInteropZodObject(schema)) {
      for (const [key, field] of Object.entries(getInteropZodObjectShape(schema))) {
        this.#noteDefault(key, field);
      }
    }
  }

  #noteDefault(key: string, schema: unknown): void {
    if (key === 'messages' || this.#defaults.has(key)) return;
    const getter = getSchemaDefaultGetter(schema as never);
    if (getter !== undefined) this.#defaults.set(key, getter as () => unknown);
  }

  /**
   * 輪頭補預設值：只補缺的鍵（同 langchain 的 `#initializeMiddlewareStates`）。
   * @param state - 要補的 state，原地改。
   */
  fillDefaults(state: LoopState): void {
    for (const [key, getter] of this.#defaults) {
      if (!(key in state)) state[key] = getter();
    }
  }

  /**
   * 把一份寫入套進 state，原地改。`undefined` 的格不寫（同 LangGraph：沒寫就是沒更新），`jumpTo` 不進 state。
   * @param state - 目前的 state。
   * @param update - 一份寫入。
   */
  apply(state: LoopState, update: Readonly<Record<string, unknown>>): void {
    for (const [key, value] of Object.entries(update)) {
      if (value === undefined || key === 'jumpTo') continue;
      const reducer = this.#reducers.get(key);
      state[key] = reducer === undefined ? value : reducer(state[key], value);
    }
  }
}

/** 一份空的 state。 */
export function emptyState(): LoopState {
  return { messages: [] };
}

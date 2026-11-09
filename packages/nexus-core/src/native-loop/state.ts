/**
 * native loop 的 thread state：每個 `thread_id` 一份放在記憶體，取代 LangGraph 的存檔點（[#2356](https://github.com/DemianLi/nexus-agent/issues/2356)）。
 *
 * 鍵與合併規則從 middleware 的 `stateSchema` 收：`messages` 走 LangGraph 的 `messagesStateReducer`（同 id 取代、`RemoveMessage`），
 * `StateSchema` 裡的 `ReducedValue`（`files`、`skillsMetadata`）用它自己的 reducer，其餘後寫的贏。預設值照 langchain
 * `#initializeMiddlewareStates`：輪頭補上缺的鍵，每條 thread 各拿一份。
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

/** 一份 `stateSchema` 的每一格：鍵與它的欄位定義。`StateSchema` 與 zod 物件兩種寫法都認。 */
function schemaFields(schema: unknown): readonly (readonly [string, unknown])[] {
  if (schema === undefined || schema === null) return [];
  if (StateSchema.isInstance(schema)) {
    return Object.entries((schema as { fields: Record<string, unknown> }).fields);
  }
  if (isInteropZodObject(schema)) return Object.entries(getInteropZodObjectShape(schema));
  return [];
}

/**
 * 一顆 middleware 的 hook 讀得到的鍵：`messages` 加上它自己 `stateSchema` 的每一格，同 langchain 給 hook 節點的 input
 * （`derivePrivateState(stateSchema)`）。
 * @param schema - 那一顆的 `stateSchema`。
 */
export function hookStateKeys(schema: unknown): readonly string[] {
  return ['messages', ...schemaFields(schema).map(([key]) => key)];
}

/** 從 middleware 收出來的鍵：誰有 reducer、誰有預設值。 */
export class StateChannels {
  readonly #reducers = new Map<string, Reducer>();
  readonly #defaults = new Map<string, () => unknown>();
  readonly #keys = new Set<string>(['messages']);

  /**
   * @param middleware - 組裝好的那一串 middleware。
   */
  constructor(middleware: readonly WithStateSchema[]) {
    this.#reducers.set('messages', messagesStateReducer as Reducer);
    for (const entry of middleware) this.#collect(entry.stateSchema);
  }

  #collect(schema: unknown): void {
    for (const [key, field] of schemaFields(schema)) {
      this.#keys.add(key);
      if (ReducedValue.isInstance(field)) {
        const reduced = field as unknown as { reducer: Reducer; valueSchema: unknown };
        this.#reducers.set(key, reduced.reducer);
        this.#noteDefault(key, reduced.valueSchema);
      } else {
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
   * 輪頭補預設值：只補缺的鍵（同 langchain 的 `#initializeMiddlewareStates`）。`getSchemaDefaultGetter` 每次回同一個物件，
   * 所以補的是複本；LangGraph 每一步從存檔點讀回各自的一份，thread 之間本來就不共用。
   * @param state - 要補的 state，原地改。
   */
  fillDefaults(state: LoopState): void {
    for (const [key, getter] of this.#defaults) {
      if (!(key in state)) state[key] = structuredClone(getter());
    }
  }

  /**
   * 一次 run 的輸入裡呼叫端寫得進的那幾格：不以 `_` 開頭的鍵，同 `createAgent` 的 input schema 不收私有鍵。沒有 `stateSchema`
   * 宣告的鍵由 {@link StateChannels.apply} 丟掉。
   * @param input - 呼叫端給的輸入。
   */
  inputOf(input: Readonly<Record<string, unknown>>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(input).filter(([key]) => !key.startsWith('_')));
  }

  /**
   * 把一份寫入套進 state，原地改。`undefined` 的格不寫（同 LangGraph：沒寫就是沒更新），`jumpTo` 與沒有 `stateSchema`
   * 宣告的鍵不進 state（同 LangGraph：沒有那個 channel，寫了也丟掉）。
   * @param state - 目前的 state。
   * @param update - 一份寫入。
   */
  apply(state: LoopState, update: Readonly<Record<string, unknown>>): void {
    for (const [key, value] of Object.entries(update)) {
      if (value === undefined || key === 'jumpTo' || !this.#keys.has(key)) continue;
      const reducer = this.#reducers.get(key);
      state[key] = reducer === undefined ? value : reducer(state[key], value);
    }
  }
}

/** 一份空的 state。 */
export function emptyState(): LoopState {
  return { messages: [] };
}

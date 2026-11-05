/**
 * 記憶那一段（[#2414](https://github.com/DemianLi/nexus-agent/issues/2414)）：讀到的內容記在宿主這一側的 {@link MemoryContents}，
 * 每條 thread 一份；文字由這裡渲染（`base-prompt-text.ts`），接在洋蔥最內層、後綴之後，自己一塊。
 *
 * 讀檔仍委派基座的 `createMemoryMiddleware` 的 `beforeAgent`：同一條 thread 第一次 invoke 讀一次，結果寫進 state 的
 * `memoryContents`，之後 state 裡有就不再讀（中途改檔，這條 thread 看不到）。這裡跟著記下那一次的結果或 state 裡已有的那一份，
 * 渲染只讀 {@link MemoryContents}，不讀模型請求上的 state。
 *
 * @module
 */

import type { AnyBackendProtocol } from 'deepagents';
import { createMemoryMiddleware as createBaseMemoryMiddleware } from 'deepagents';
import { createHookStepMiddleware } from './hook-step.js';
import type { AgentMiddleware } from 'langchain';

import { renderMemorySection } from './base-prompt-text.js';
import { withSystemPromptStep } from './system-prompt-step.js';
import type { SystemPromptCell } from './system-prompt-step.js';

/** 一條 thread 讀到的記憶：來源路徑 → 內容。 */
type Contents = Readonly<Record<string, string>>;

/** 記憶的內容，每條 thread 一份。沒帶 `thread_id` 的呼叫共用一格。 */
export interface MemoryContents {
  /**
   * 記下這條 thread 讀到的。
   *
   * @param thread - `configurable.thread_id`。
   * @param contents - 讀到的。
   */
  record(thread: string | undefined, contents: Contents): void;
  /**
   * 這條 thread 讀到的。
   *
   * @param thread - `configurable.thread_id`。
   * @returns 還沒讀過是 `undefined`。
   */
  of(thread: string | undefined): Contents | undefined;
}

/** 建一份空的 {@link MemoryContents}。 */
export function createMemoryContents(): MemoryContents {
  const byThread = new Map<string | undefined, Contents>();
  return {
    record: (thread, contents) => {
      byThread.set(thread, contents);
    },
    of: (thread) => byThread.get(thread),
  };
}

/** 呼叫帶的 `configurable.thread_id`。 */
function threadOf(runtime: unknown): string | undefined {
  const thread = (runtime as { readonly configurable?: { readonly thread_id?: unknown } } | null)
    ?.configurable?.thread_id;
  return typeof thread === 'string' ? thread : undefined;
}

/** 基座 middleware 上我們要轉呼叫的鉤子。 */
interface BaseHooks {
  readonly name: string;
  readonly stateSchema?: unknown;
  readonly beforeAgent: (
    state: unknown,
    runtime: unknown,
  ) => Promise<{ memoryContents?: Contents } | undefined>;
}

/**
 * 建記憶 middleware。名字與 state 形狀同基座那顆（`MemoryMiddleware`、`memoryContents`）。
 *
 * @param options - 後端與來源路徑。
 * @param options.backend - 讀記憶檔的後端。
 * @param options.sources - 來源路徑，照登記的先後。
 * @param contents - 讀到的內容記在這裡；省略就自己建一份。
 * @returns middleware。
 */
export function createMemoryMiddleware(
  options: { readonly backend: AnyBackendProtocol; readonly sources: readonly string[] },
  contents: MemoryContents = createMemoryContents(),
): AgentMiddleware {
  const base = createBaseMemoryMiddleware({
    backend: options.backend,
    sources: [...options.sources],
    addCacheControl: false,
  }) as unknown as BaseHooks;
  // 不是 `concat`：另建一則內容是區塊陣列的系統訊息，記憶自己一塊（字串內容也先包成一塊），同基座。
  const cell: SystemPromptCell = {
    step: (request) => [
      {
        block: renderMemorySection(contents.of(threadOf(request.runtime)) ?? {}, options.sources),
      },
    ],
  };
  return withSystemPromptStep(cell, (wrapModelCall) =>
    createHookStepMiddleware({
      name: base.name,
      ...(base.stateSchema !== undefined && { stateSchema: base.stateSchema as never }),
      async beforeAgent(state: unknown, runtime: unknown) {
        const result = await base.beforeAgent(state, runtime);
        const loaded =
          result?.memoryContents ??
          (state as { readonly memoryContents?: Contents } | null)?.memoryContents ??
          {};
        contents.record(threadOf(runtime), loaded);
        return result as never;
      },
      wrapModelCall,
    } as never),
  ) as unknown as AgentMiddleware;
}

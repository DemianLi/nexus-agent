/**
 * 兩個 loop 共用的等人測試的組裝：同一批工具、同一串模型回應，`langgraph` 與 `native` 各組一份，`streamEvents` 跑到停住、帶答覆接回。
 * 工具裡問人時讀得到等人服務就 await 它，讀不到（`langgraph`）就用 LangGraph 的 `interrupt()`。
 */

import type { StructuredToolInterface } from '@langchain/core/tools';
import { Command, MemorySaver, interrupt } from '@langchain/langgraph';
import { StateBackend } from 'deepagents';
import type { fakeModel } from 'langchain';

import { assembleAgent } from '../agent-assembly.js';
import { fakePlugin } from '../fixtures.js';
import { foldRegistry } from '../fold.js';
import { humanInputOf } from '../human-input.js';
import { loadPlugins } from '../load.js';

export const LOOPS = ['langgraph', 'native'] as const;
export type Loop = (typeof LOOPS)[number];

/** `streamEvents` v3 交出的一顆事件，這裡讀到的格子。 */
export interface LoopEvent {
  readonly method: string;
  readonly params: {
    readonly namespace?: readonly string[];
    readonly data?: { readonly values?: unknown };
  };
}

/**
 * 問人：讀得到服務就 await 它，否則 LangGraph 的 `interrupt()`。
 * @param config - 工具拿到的 config。
 * @param value - 問題的酬載。
 * @returns 答覆。
 */
export async function askHuman(config: unknown, value: unknown): Promise<unknown> {
  const service = humanInputOf(config);
  return service === undefined ? interrupt(value) : service.ask(value);
}

/** 組好的 agent：跑到停住或收完，帶答覆接回。 */
export interface LoopRun {
  /** 跑第一段；回這一段的事件。 */
  start(text: string): Promise<LoopEvent[]>;
  /** 照 id 送答覆，回這一段的事件。 */
  resume(answers: Readonly<Record<string, unknown>>): Promise<LoopEvent[]>;
  /** 存檔點上的對話，每則的 `content`。 */
  contents(): Promise<unknown[]>;
}

/**
 * @param loop - 哪一種 loop。
 * @param tools - 註冊的工具。
 * @param model - 模型回應。
 * @param config - 另外帶進每次 `streamEvents` 的 config（例：`maxConcurrency`）。
 * @returns 跑法。
 */
export async function loopRun(
  loop: Loop,
  tools: readonly StructuredToolInterface[],
  model: ReturnType<typeof fakeModel>,
  config: Readonly<Record<string, unknown>> = {},
): Promise<LoopRun> {
  const { registry } = await loadPlugins([
    fakePlugin('tools', (r) => {
      for (const each of tools) r.tools.register(each);
    }),
  ]);
  const backend = new StateBackend();
  const params = foldRegistry(registry, {
    summarization: false,
    defaultBackend: backend,
    events: registry.dispatch,
  });
  const agent = assembleAgent({
    ...params,
    model,
    backend: params.backend ?? backend,
    checkpointer: new MemorySaver(),
    loop,
    events: registry.dispatch,
  }) as unknown as {
    streamEvents(input: unknown, config: object): Promise<AsyncIterable<LoopEvent> & Projections>;
    getState(config: object): Promise<{ values: { messages?: readonly { content: unknown }[] } }>;
  };
  const options = { version: 'v3', configurable: { thread_id: 't' }, ...config };
  const drain = async (input: unknown): Promise<LoopEvent[]> => {
    const events: LoopEvent[] = [];
    const run = await agent.streamEvents(input, options);
    markToolCallsHandled(run);
    for await (const event of run) events.push(event);
    return events;
  };
  return {
    start: (text) => drain({ messages: [{ role: 'user', content: text }] }),
    resume: (answers) => drain(new Command({ resume: answers })),
    contents: async () =>
      ((await agent.getState(options)).values.messages ?? []).map((message) => message.content),
  };
}

/** langchain 在 v3 run 物件上掛的每顆工具呼叫投影；`langgraph` 那條才有。 */
interface Projections {
  readonly toolCalls?: AsyncIterable<{ readonly output: Promise<unknown> }>;
}

/**
 * 工具一發 `tool-error`，`langgraph` 那條的投影就 reject 那顆的 `output`，沒人讀就成了未處理的 rejection。標成已處理，同
 * `apps/harness/src/thread-pump.ts` 的 `markProjectionsHandled`（[#346](https://github.com/DemianLi/nexus-agent/issues/346)）。
 * @param run - `streamEvents` 交出的 run。
 */
function markToolCallsHandled(run: Projections): void {
  const ignore = (): void => undefined;
  if (run.toolCalls === undefined) return;
  void (async () => {
    for await (const call of run.toolCalls!) call.output.catch(ignore);
  })().catch(ignore);
}

/**
 * @param events - 一段事件。
 * @returns 這一段交出的中斷 id（root 那一層），照出現的先後、去重。
 */
export function interruptIds(events: readonly LoopEvent[]): string[] {
  const ids = events
    .filter((event) => event.method === 'updates' && (event.params.namespace ?? []).length === 0)
    .flatMap((event) => {
      const values = event.params.data?.values;
      return Array.isArray(values)
        ? values.flatMap((value: { id?: unknown }) => (typeof value.id === 'string' ? [value.id] : []))
        : [];
    });
  return [...new Set(ids)];
}

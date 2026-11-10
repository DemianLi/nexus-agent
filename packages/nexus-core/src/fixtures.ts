/**
 * 測試用的假 plugin 與假擴充內容。只給本套件的測試用，不從 `index.ts` 對外匯出。
 *
 * 衝突單測用的一次性假 plugin 全部留在這裡——真的 workspace plugin 是各個 `packages/nexus-plugin-*` 的事。
 * `packages/nexus-plugin-echo` 已經不是 `NexusPlugin`（#1416 PR 2 起它是樹上的函式插件，證明的是 SDK 契約
 * 沒有要求你伸手進 harness 內部），所以這裡不再拿它當 `NexusPlugin` 的真實例子。
 */

import type { FeedbackService } from './feedback.js';
import { AIMessage } from '@langchain/core/messages';
import { fakeModel as langchainFakeModel } from 'langchain';
import { tool } from '@langchain/core/tools';
import type { StructuredTool } from '@langchain/core/tools';
import type { AnyBackendProtocol, SubAgent } from 'deepagents';
import { z } from 'zod';
import { SESSION_EVENT_MAX_DEPTH, SessionLog } from './session-log.js';
import type { SessionEvent, SessionEventType } from './session-log.js';
import type {
  AgentMiddleware,
  NexusPlugin,
  PluginEntry,
  PluginRegistry,
  SessionTelemetryRecord,
  SessionTelemetryService,
  SessionTelemetrySharingStatus,
} from './index.js';
import { LLM_STREAM_CONFIG_KEY } from './native-loop/events.js';
import type { ModelStreamAround, ModelStreamChunk } from './native-loop/events.js';

/**
 * 一個什麼都不做、只有名字有意義的工具。
 * @param name - 工具名。
 * @returns 可註冊的工具。
 */
export function fakeTool(name: string): StructuredTool {
  return tool(() => `${name} 跑過了`, {
    name,
    description: `測試用的 ${name}`,
    schema: z.object({}),
  });
}

/**
 * 一個只有名字與描述的 subagent。
 * @param name - subagent 名。
 * @returns 可註冊的 subagent。
 */
export function fakeSubAgent(name: string): SubAgent {
  return { name, description: `測試用的 ${name}` };
}

/**
 * 包一個 plugin，回傳掛著它的**條目**——清單收的是條目，所以測試直接把它放進 `plugins` 即可。
 *
 * 不收 `config`：假 plugin 沒有 `Config`，給了也不驗、原樣交給 `apply`（見 `plugin.ts` 的 `parseEntryConfig`）。
 * 要驗設定那條路的測試自己寫條目。
 *
 * @param name - plugin 名，不必唯一。
 * @param apply - 註冊內容。
 * @param requires - 需要的能力。
 * @returns 可載入的條目。
 */
export function fakePlugin(
  name: string,
  apply: (registry: PluginRegistry) => void | Promise<void>,
  requires?: string[],
): PluginEntry {
  const plugin: NexusPlugin = requires === undefined ? { name, apply } : { name, requires, apply };
  return { plugin };
}

/**
 * 一個只有身分、沒有行為的 backend。
 *
 * fold 只把 backend 當值搬運，基座的 `CompositeBackend` 也只在真的做檔案操作時才
 * 碰它的方法，所以測試不需要一個會動的 backend——需要的是一個認得出來的東西。
 * @param id - 認得出是哪一個用的標記。
 * @returns 可以掛上去的假 backend。
 */
export function fakeBackend(id: string): AnyBackendProtocol {
  return { nexusFakeBackend: id } as unknown as AnyBackendProtocol;
}

/**
 * 一個只有名字的 middleware。
 * @param name - middleware 名。
 * @returns 可以註冊的假 middleware。
 */
export function fakeMiddleware(name: string): AgentMiddleware {
  return { name } as unknown as AgentMiddleware;
}

/** 記下收到什麼的假後端，加上一支看得到關機次數的計數。 */
export interface FakeSink extends SessionTelemetryService {
  readonly records: SessionTelemetryRecord[];
  readonly flushes: { count: number };
  readonly shutdowns: { count: number };
}

/**
 * 一個只會把記錄收進陣列的後端。
 *
 * `emit` 契約上要求非阻塞入隊——push 進陣列正是那個形狀，所以這個假貨在時序上跟真的
 * 一樣，不會替被測程式掩蓋掉「同步呼叫」這件事。
 *
 * @param options - `emit` / `shutdown` 要不要拋，用來驗圍堵。
 * @returns 可以掛上去的假後端。
 */
export function fakeSink(
  options: {
    readonly onEmit?: () => void;
    readonly onFlush?: () => void;
    readonly onShutdown?: () => void;
    readonly sharing?: SessionTelemetrySharingStatus;
  } = {},
): FakeSink {
  const records: SessionTelemetryRecord[] = [];
  const flushes = { count: 0 };
  const shutdowns = { count: 0 };
  return {
    records,
    flushes,
    shutdowns,
    sharing: options.sharing ?? 'full',
    emit(record) {
      options.onEmit?.();
      records.push(record);
    },
    flush() {
      flushes.count += 1;
      options.onFlush?.();
    },
    shutdown() {
      shutdowns.count += 1;
      options.onShutdown?.();
      return Promise.resolve();
    },
  };
}

/** 一份什麼都不寫的回饋規則：拿它的測試只看它佔不佔得住那個位子。 */
export function fakeFeedback(): FeedbackService {
  return {
    put: () => Promise.resolve({ ok: false, error: { code: 'target-not-found', messageId: 'm' } }),
    delete: () => Promise.resolve({ ok: true, value: { absent: true } }),
    list: () => Promise.resolve({ ok: true, value: { items: [] } }),
    record: () => Promise.resolve({ ok: true, value: { recorded: true } }),
  };
}

/**
 * 從 seed 接上一份「舊日誌」：事件不經 `append`，所以不受寫入那一關的深度上限（`SESSION_EVENT_MAX_DEPTH`）。
 *
 * 上限出現之前寫下的日誌可能有更深的事件，續接之後讀方要照樣吃得下（#1661）。深巢狀的讀方測試用這個造資料，
 * 不然 `append` 先拒了，讀方那一刀拿掉也紅不起來。
 *
 * @param sessionId - 會話 id。
 * @param entries - 依序的事件種類與 data；`seq` 照位置、`time` 照 seq。
 * @returns 接上 seed 的日誌（末尾多一顆 `session/end-seed`）。
 */
export function resumedLog(
  sessionId: string,
  entries: readonly (readonly [type: SessionEventType, data: unknown])[],
): SessionLog {
  const seed = entries.map(
    ([type, data], seq) => ({ type, seq, time: seq, data }) as unknown as SessionEvent,
  );
  return new SessionLog(sessionId, { seed });
}

/**
 * 日誌那一關一定拒收的值：物件與陣列交錯巢狀 {@link SESSION_EVENT_MAX_DEPTH} 層（#1665）。它自己就在上限上，放進任何
 * 一顆事件的 `data` 裡都至少再多一層，`append` 當場拋 `TypeError`（#1661）。用真的拒收、不 mock `append`，同 dsh 拿真的否決測。
 *
 * @returns 那個值。
 */
export function pastLogDepthCap(): unknown {
  let value: unknown = 'leaf';
  for (let level = 0; level < SESSION_EVENT_MAX_DEPTH; level++) {
    value = level % 2 ? { next: value } : [value];
  }
  return value;
}

/**
 * `langchain` 的 `fakeModel()`，加上 native 的 `llm/stream` 接法：呼叫 config 的 `configurable[LLM_STREAM_CONFIG_KEY]` 有環繞函式時，
 * 經它打這顆假模型——`next()` 打假模型，交出一顆內容同回覆的 chunk；監聽者轉交了就回假模型原本的那則訊息，短路了就用監聽者給的
 * chunk 拼一則。`bindTools`、`withConfig` 綁出來的（連同它們的 `bound`）也照這樣接。沒有環繞函式時跟 `fakeModel()` 完全相同。
 * @returns 跟 `fakeModel()` 同一套建構方法的假模型。
 */
export function fakeModel(): ReturnType<typeof langchainFakeModel> {
  return takesLlmStream(langchainFakeModel());
}

function takesLlmStream<M extends object>(model: M): M {
  return new Proxy(model, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (property === 'bound' && typeof value === 'object' && value !== null)
        return takesLlmStream(value);
      if ((property === 'bindTools' || property === 'withConfig') && typeof value === 'function')
        return (...args: unknown[]) =>
          takesLlmStream((value as (...a: unknown[]) => object).apply(receiver, args));
      if (property === 'invoke' && typeof value === 'function')
        return (input: unknown, config?: { configurable?: Record<string, unknown> }) => {
          const invoke = (value as (i: unknown, c: unknown) => Promise<AIMessage>).bind(receiver);
          const around = config?.configurable?.[LLM_STREAM_CONFIG_KEY] as
            ModelStreamAround | undefined;
          if (around === undefined) return invoke(input, config);
          // 往內交時拿掉這把鍵：綁定與它的 `bound` 都包了一層，只能由最外層這一層取用。
          const { [LLM_STREAM_CONFIG_KEY]: _taken, ...configurable } = config!.configurable!;
          return viaAround(around, () => invoke(input, { ...config, configurable }));
        };
      return value;
    },
  });
}

async function viaAround(
  around: ModelStreamAround,
  invoke: () => Promise<AIMessage>,
): Promise<AIMessage> {
  let answered: AIMessage | undefined;
  const chunks: ModelStreamChunk[] = [];
  for await (const chunk of around(async function* () {
    answered = await invoke();
    yield chunkOf(answered);
  }))
    chunks.push(chunk);
  if (answered !== undefined) return answered;
  return new AIMessage({
    content: chunks.map((chunk) => chunk.choices[0]?.delta?.content ?? '').join(''),
  });
}

function chunkOf(message: AIMessage): ModelStreamChunk {
  return {
    ...(message.id !== undefined && { id: message.id }),
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
          content: typeof message.content === 'string' ? message.content : message.text,
          tool_calls: (message.tool_calls ?? []).map((call, index) => ({
            index,
            ...(call.id !== undefined && { id: call.id }),
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          })),
        },
        finish_reason: (message.tool_calls ?? []).length > 0 ? 'tool_calls' : 'stop',
      },
    ],
  };
}

/**
 * native loop 吐給 pump 的 v3 事件（[#2356](https://github.com/DemianLi/nexus-agent/issues/2356)）：形狀同 `@langchain/langgraph`
 * `streamEvents({ version: 'v3' })` 的 `ProtocolEvent`，只產 pump 與 wire 讀的那幾種（`lifecycle`、`messages`、`tools`、root 的 `custom`）；
 * 中斷類（`updates` 的 `__interrupt__`、`input.requested`）不產，TODO(#2358)。
 * TODO(#2363)：拿掉 LangChain 時換成自己的線上協定。
 *
 * 模型的逐片事件由 `@langchain/core` 產：callback handler 宣告 `lc_prefer_chat_model_stream_events`，`BaseChatModel` 就算是 `invoke`
 * 也改走 `_streamChatModelEvents`，逐顆交給 `handleChatModelStreamEvent`，缺 id 時補成 `run-<runId>`。不會串流的模型（腳本模型）
 * 在 `handleLLMEnd` 補發完整一則，同 LangGraph 的 `StreamProtocolMessagesHandler`。
 *
 * @module
 */

import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { ChatModelStreamEvent } from '@langchain/core/language_models/event';
import { BaseMessage } from '@langchain/core/messages';
import type { LLMResult } from '@langchain/core/outputs';

/** 一顆線上事件，同 LangGraph v3 的 `ProtocolEvent`。 */
export interface NativeProtocolEvent {
  readonly type: 'event';
  readonly seq: number;
  readonly method: string;
  readonly params: {
    readonly namespace: string[];
    readonly timestamp: number;
    readonly node?: string;
    readonly data: unknown;
  };
}

/** 收事件的一方。 */
export type ProtocolSink = (event: NativeProtocolEvent) => void;

/**
 * 給一次 run 編號、組事件。子層（`model_request:<id>`、`tools:<id>`）的 `lifecycle` 照 LangGraph 的 `createLifecycleTransformer`
 * 推：那一層第一顆事件之前補 `started`，節點寫回之後 {@link ProtocolEmitter.complete} 補 `completed`；root 收尾時還開著的
 * 子層跟著 root 收成同一個狀態。沒發過事件的節點（hook）沒有 `lifecycle`，同 LangGraph。
 */
export class ProtocolEmitter {
  #seq = 0;
  readonly #open = new Map<string, string[]>();

  /**
   * @param sink - 收事件的一方。
   */
  constructor(private readonly sink: ProtocolSink) {}

  /**
   * 發一顆事件。
   * @param method - 頻道。
   * @param namespace - 圖的命名空間；root 是 `[]`。
   * @param data - 內容。
   * @param node - 節點名（`messages` 才帶）。
   */
  emit(method: string, namespace: string[], data: unknown, node?: string): void {
    for (let length = 1; length <= namespace.length; length++) {
      const prefix = namespace.slice(0, length);
      const key = prefix.join('|');
      if (this.#open.has(key)) continue;
      this.#open.set(key, prefix);
      this.#push('lifecycle', prefix, { event: 'started', graph_name: graphNameOf(prefix) });
    }
    this.#push(method, namespace, data, node);
  }

  #push(method: string, namespace: string[], data: unknown, node?: string): void {
    this.sink({
      type: 'event',
      seq: this.#seq++,
      method,
      params: {
        namespace,
        timestamp: Date.now(),
        ...(node === undefined ? {} : { node }),
        data,
      },
    });
  }

  /**
   * 一個節點寫回了：它那一層發過事件的話補 `completed`。
   * @param namespace - 那個節點的命名空間。
   */
  complete(namespace: string[]): void {
    const key = namespace.join('|');
    if (!this.#open.delete(key)) return;
    this.#push('lifecycle', namespace, { event: 'completed', graph_name: graphNameOf(namespace) });
  }

  /**
   * root 的 `lifecycle`。收尾（`completed`、`failed`）前先把還開著的子層收成同一個狀態。
   * @param event - `running`、`completed`、`failed`。
   * @param error - `failed` 時的錯誤訊息。
   */
  lifecycle(event: 'running' | 'completed' | 'failed', error?: string): void {
    if (event !== 'running') {
      for (const namespace of this.#open.values()) {
        this.#push('lifecycle', namespace, { event, graph_name: graphNameOf(namespace) });
      }
      this.#open.clear();
    }
    this.#push('lifecycle', [], {
      event,
      graph_name: 'root',
      ...(error === undefined ? {} : { error }),
    });
  }

  /**
   * root 的 `custom`：`getConfig().writer` 寫的東西，包法同 LangGraph（沒有 `name` 鍵就包成 `{ payload }`）。
   * @param payload - 寫進來的值。
   */
  custom(payload: unknown): void {
    const data =
      typeof payload === 'object' &&
      payload !== null &&
      !Array.isArray(payload) &&
      'name' in payload
        ? payload
        : { payload };
    this.emit('custom', [], data);
  }
}

/** 同 LangGraph 的 `defaultGuessGraphName`：最後一段 `name:<id>` 的 `name`。 */
function graphNameOf(namespace: readonly string[]): string {
  const last = namespace.at(-1) ?? '';
  const colon = last.indexOf(':');
  return colon === -1 ? last : last.slice(0, colon);
}

/** 一則內容塊，取 LangChain 的標準形狀裡用得到的幾格。 */
interface Block {
  readonly type: string;
  readonly index?: number;
  readonly text?: unknown;
  readonly reasoning?: unknown;
  readonly id?: unknown;
  readonly name?: unknown;
}

function startBlockFor(block: Block): unknown {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: '' };
    case 'reasoning':
      return { type: 'reasoning', reasoning: '' };
    case 'tool_call':
    case 'tool_call_chunk':
      return {
        type: 'tool_call_chunk',
        ...(block.id == null ? {} : { id: block.id }),
        ...(block.name == null ? {} : { name: block.name }),
        args: '',
      };
    default:
      return block;
  }
}

function deltaFor(block: Block, index: number): unknown {
  if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
    return { event: 'content-block-delta', index, delta: { type: 'text-delta', text: block.text } };
  }
  if (
    block.type === 'reasoning' &&
    typeof block.reasoning === 'string' &&
    block.reasoning.length > 0
  ) {
    return {
      event: 'content-block-delta',
      index,
      delta: { type: 'reasoning-delta', reasoning: block.reasoning },
    };
  }
  if (block.type === 'tool_call_chunk') {
    return {
      event: 'content-block-delta',
      index,
      delta: { type: 'block-delta', fields: { ...block, type: 'tool_call_chunk' } },
    };
  }
  return undefined;
}

/** 模型呼叫帶的 metadata 裡，native loop 放的兩格。 */
const NODE_KEY = 'langgraph_node';
const NS_KEY = 'langgraph_checkpoint_ns';

/**
 * 把 metadata 帶 {@link NS_KEY} 的模型呼叫轉成 `messages` 頻道、工具呼叫轉成 `tools` 頻道（後者同 LangGraph 的
 * `StreamToolsHandler`）：root 的節點與工具裡跑的子圖都帶這一格，命名空間照它。模型帶 `nostream`、工具帶 `langsmith:hidden` 的不發。
 */
export class NativeStreamHandler extends BaseCallbackHandler {
  name = 'NativeStreamHandler';
  lc_prefer_chat_model_stream_events = true;
  awaitHandlers = true;
  readonly #runs = new Map<string, { namespace: string[]; node: string | undefined }>();
  readonly #streamed = new Set<string>();
  readonly #tools = new Map<string, { namespace: string[]; toolCallId: string | undefined }>();
  readonly #subgraphNodes = new Map<string, string[]>();

  /**
   * @param emitter - 這次 run 的事件出口。
   */
  constructor(private readonly emitter: ProtocolEmitter) {
    super();
  }

  #emit(runId: string, data: Record<string, unknown>): void {
    const run = this.#runs.get(runId);
    if (run === undefined) return;
    this.emitter.emit('messages', run.namespace, { ...data, run_id: runId }, run.node);
  }

  override handleChatModelStart(
    _llm: unknown,
    _messages: unknown,
    runId: string,
    _parentRunId?: string,
    _extraParams?: unknown,
    tags?: string[],
    metadata?: Record<string, unknown>,
  ): void {
    if (tags?.includes('nostream') === true || tags?.includes('langsmith:nostream') === true)
      return;
    const ns = metadata?.[NS_KEY];
    if (typeof ns !== 'string') return;
    const node = metadata?.[NODE_KEY];
    this.#runs.set(runId, {
      namespace: ns.split('|'),
      node: typeof node === 'string' ? node : undefined,
    });
  }

  /**
   * core 逐顆交來的串流事件，原樣轉發；`message-start` 缺 id 時補 `run-<runId>`。
   * @param event - core 的串流事件。
   * @param runId - 這次模型呼叫。
   */
  override handleChatModelStreamEvent(event: ChatModelStreamEvent, runId: string): void {
    if (!this.#runs.has(runId)) return;
    const data = event as unknown as Record<string, unknown>;
    if (data['event'] === 'message-start') {
      this.#streamed.add(runId);
      this.#emit(runId, { ...data, id: data['id'] ?? `run-${runId}` });
      return;
    }
    this.#emit(runId, data);
  }

  override handleLLMEnd(output: LLMResult, runId: string): void {
    const message = (output.generations[0]?.[0] as { message?: unknown } | undefined)?.message;
    if (!this.#streamed.has(runId) && BaseMessage.isInstance(message)) {
      this.#emitFinal(runId, message);
    }
    this.#streamed.delete(runId);
    this.#runs.delete(runId);
  }

  override handleLLMError(_error: unknown, runId: string): void {
    this.#streamed.delete(runId);
    this.#runs.delete(runId);
  }

  /**
   * 工具裡跑的子圖（前景子代理是 LangGraph 子圖，TODO(#2359)）：它的節點結束時補那一層的 `completed`。LangGraph 是看子圖的
   * `updates` 補的，那份串流不經 callback，所以看節點那顆 chain run（名字等於 `langgraph_node`）的收尾。
   */
  override handleChainStart(
    _chain: unknown,
    _inputs: unknown,
    runId: string,
    _parentRunId?: string,
    _tags?: string[],
    metadata?: Record<string, unknown>,
    _runType?: string,
    runName?: string,
  ): void {
    const ns = metadata?.[NS_KEY];
    if (typeof ns !== 'string' || runName === undefined || runName !== metadata?.[NODE_KEY]) return;
    const namespace = ns.split('|');
    if (namespace.length < 2) return;
    this.#subgraphNodes.set(runId, namespace);
  }

  override handleChainEnd(_outputs: unknown, runId: string): void {
    const namespace = this.#subgraphNodes.get(runId);
    if (namespace === undefined) return;
    this.#subgraphNodes.delete(runId);
    this.emitter.complete(namespace);
  }

  override handleChainError(_error: unknown, runId: string): void {
    this.#subgraphNodes.delete(runId);
  }

  override handleToolStart(
    _tool: unknown,
    input: string,
    runId: string,
    _parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
    toolCallId?: string,
  ): void {
    const ns = metadata?.[NS_KEY];
    if (typeof ns !== 'string' || tags?.includes('langsmith:hidden') === true) return;
    const namespace = ns.split('|');
    this.#tools.set(runId, { namespace, toolCallId });
    this.emitter.emit('tools', namespace, {
      event: 'tool-started',
      tool_call_id: String(toolCallId ?? ''),
      tool_name: runName ?? 'unknown',
      input,
    });
  }

  override handleToolEvent(chunk: unknown, runId: string): void {
    const run = this.#tools.get(runId);
    if (run === undefined) return;
    this.emitter.emit('tools', run.namespace, {
      event: 'tool-output-delta',
      tool_call_id: String(run.toolCallId ?? ''),
      delta: typeof chunk === 'string' ? chunk : JSON.stringify(chunk ?? ''),
    });
  }

  override handleToolEnd(output: unknown, runId: string): void {
    const run = this.#tools.get(runId);
    this.#tools.delete(runId);
    if (run === undefined) return;
    this.emitter.emit('tools', run.namespace, {
      event: 'tool-finished',
      tool_call_id: String(run.toolCallId ?? ''),
      output,
    });
  }

  override handleToolError(error: unknown, runId: string): void {
    const run = this.#tools.get(runId);
    this.#tools.delete(runId);
    if (run === undefined) return;
    this.emitter.emit('tools', run.namespace, {
      event: 'tool-error',
      tool_call_id: String(run.toolCallId ?? ''),
      message:
        typeof error === 'object' &&
        error !== null &&
        'message' in error &&
        typeof error.message === 'string'
          ? error.message
          : String(error ?? 'unknown error'),
    });
  }

  /** 沒串流的模型：一次補發 start、每塊 start／delta／finish、finish，同 LangGraph 的 `emitFinalMessage`。 */
  #emitFinal(runId: string, message: BaseMessage): void {
    if (message.id == null) {
      message.id = `run-${runId}`;
      message.lc_kwargs.id = message.id;
    }
    this.#emit(runId, { event: 'message-start', id: message.id });
    const blocks: Block[] = Array.isArray(message.content)
      ? (message.content as Block[])
      : typeof message.content === 'string' && message.content.length > 0
        ? [{ type: 'text', text: message.content }]
        : [];
    blocks.forEach((block, offset) => {
      const index = typeof block.index === 'number' ? block.index : offset;
      this.#emit(runId, { event: 'content-block-start', index, content: startBlockFor(block) });
      const delta = deltaFor(block, index);
      if (delta !== undefined) this.#emit(runId, delta as Record<string, unknown>);
      this.#emit(runId, { event: 'content-block-finish', index, content: block });
    });
    const usage = (message as { usage_metadata?: unknown }).usage_metadata;
    this.#emit(runId, {
      event: 'message-finish',
      ...(usage == null ? {} : { usage }),
      ...(message.response_metadata == null ? {} : { responseMetadata: message.response_metadata }),
    });
  }
}

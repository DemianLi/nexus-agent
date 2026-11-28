/**
 * agent 把手：兩條 loop（`langgraph`、`native`）對外只有這一份形狀（[#3342](https://github.com/DemianLi/nexus-agent/issues/3342)）。
 *
 * 呼叫端（`thread-pump.ts`、`background-subagents.ts`、`conversation-restore.ts`、CLI、eval）只認 {@link LoopAgent}：成員全部必有，
 * 沒有選填，也不探測「現在是哪條 loop」。兩條 loop 在同一件事上做法不同的地方收進各自的實作：
 *
 * - `NativeAgent`（`native-loop/agent.ts`）直接 `implements` 它；
 * - LangGraph 的圖包一層 {@link adaptLangGraph}（`langgraph-agent.ts`）。
 *
 * 簽名裡的 LangChain 語彙（`Command` 的 `resume`、`BaseMessage`、`configurable.thread_id`、v3 事件、`__interrupt__`）這一版不換，
 * TODO(#2363) 刪 `langgraph` 時連同 adapter 與 {@link LoopAgent.danglingCalls} 一起處理。
 *
 * @module
 */

import { AIMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { Command } from '@langchain/langgraph';

import { ARCHIVE_GATE_CONFIG_KEY } from './archive-gate.js';
import type { LoopState } from './native-loop/state.js';
import { toBaseMessage } from './langchain-message-adapter.js';
import type { SessionEvent } from './session-log.js';
import { STEP_INBOX_CONFIG_KEY } from './step-inbox.js';
import type { StepInbox } from './step-inbox.js';
import { TURN_CANCEL_CONFIG_KEY } from './turn-cancel.js';

/** 這條 thread 的位址。 */
export interface ThreadConfig {
  readonly configurable: { readonly thread_id: string };
}

/** 基座 v3 run 抽出來的一顆原始封包（`GraphRunStream implements AsyncIterable<ProtocolEvent>`）。 */
export interface RawProtocolEvent {
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

/** langchain 投影裡一次工具呼叫的那一格。這裡只碰得到它的 `output`。 */
export interface ToolCallProjection {
  readonly output: Promise<unknown>;
}

/** langchain 投影裡一個子代理：自己的 `output`，外加它那一層的工具呼叫與再下一層的子代理。 */
export interface SubagentProjection {
  readonly output: Promise<unknown>;
  readonly toolCalls: AsyncIterable<ToolCallProjection>;
  readonly subagents: AsyncIterable<SubagentProjection>;
}

/**
 * langchain 在 v3 run 物件上掛的原生投影裡，**帶 promise 的那兩種**。選填：只有 `langgraph` 的 run 有（native 不產），也不是每個替身都有。
 *
 * 形狀照 `langchain@1.5.10` 的 `dist/agents/transformers/tool-call.js` 與 `subagent.js`。
 */
export interface RunProjections {
  readonly toolCalls?: AsyncIterable<ToolCallProjection>;
  readonly subagents?: AsyncIterable<SubagentProjection>;
}

/** 一次 run 收到的輸入：`{ messages }` 加上 `stateSchema` 宣告過的鍵，或接回停在等待點的 run 用的 `Command`。 */
export type LoopInput =
  { readonly messages?: readonly BaseMessage[]; readonly [key: string]: unknown } | Command;

/** `streamEvents` 與 `stream` 帶的存檔點策略；`'exit'` 是每輪只存一份（`RUN_DURABILITY`）。 */
export type LoopDurability = 'exit';

/**
 * `streamEvents` 的 `configurable`：pump 與背景 host 各帶自己的那幾把鍵，其餘的鍵（背景 run 的 session、停止回呼）原樣交給 loop。
 */
export interface StreamEventsConfigurable {
  readonly thread_id: string;
  /** 這一輪的中止訊號。**不交給 LangGraph 的 `signal`**，理由見 `turn-cancel.ts`。 */
  readonly [TURN_CANCEL_CONFIG_KEY]?: AbortSignal;
  /** 插話的領取口（#710）。圖裡沒掛那顆 middleware 就沒人讀，見 `step-inbox.ts`。 */
  readonly [STEP_INBOX_CONFIG_KEY]?: StepInbox;
  /** 準入閘門（#633）：每次模型呼叫之前問，回 `true` 就擋下。只有接了整理檔的組裝才放。 */
  readonly [ARCHIVE_GATE_CONFIG_KEY]?: () => boolean;
  readonly [key: string]: unknown;
}

/** `streamEvents` 的設定。 */
export interface StreamEventsConfig {
  readonly version: 'v3';
  readonly durability?: LoopDurability;
  readonly configurable: StreamEventsConfigurable;
}

/** `stream` 的設定（CLI 那條）：`streamMode` 給陣列，吐 `[mode, payload]`。 */
export interface StreamConfig {
  readonly streamMode: readonly ('updates' | 'values')[];
  readonly durability?: LoopDurability;
  readonly configurable?: { readonly thread_id?: string; readonly [key: string]: unknown };
}

/** `invoke` 的設定。 */
export interface InvokeConfig {
  readonly configurable?: { readonly thread_id?: string; readonly [key: string]: unknown };
  readonly recursionLimit?: number;
  readonly durability?: LoopDurability;
  readonly [key: string]: unknown;
}

/** `withConfig` 收的兩格：步數上限與並行上限，語意同 LangGraph。 */
export interface LoopDefaults {
  readonly recursionLimit?: number;
  readonly maxConcurrency?: number;
}

/** 對話上還沒配到結果的一顆工具呼叫。 */
export interface DanglingCall {
  readonly id: string;
  readonly name: string;
  readonly args: unknown;
}

/**
 * 一條 loop 對 harness 的全部要求。成員全部必有。
 *
 * thread 的對話由日誌推、loop 自己留一份：下面三個寫的成員（{@link LoopAgent.seedThread}、{@link LoopAgent.appendLoggedMessages}、
 * {@link LoopAgent.discardSuspended}）是呼叫端唯一能動它的路；{@link LoopAgent.getState} 只給測試讀，產品碼不叫。
 */
export interface LoopAgent {
  /** pump 與背景 host 那條：回一個可抽的 v3 run。迭代到底是這次 run 結束，或停在等待點（最後一顆是 `__interrupt__`）。 */
  streamEvents(
    input: LoopInput,
    config: StreamEventsConfig,
  ): Promise<AsyncIterable<RawProtocolEvent> & RunProjections>;
  /** CLI 那條：每個節點寫完吐一次 `['updates', { 節點: 寫入 }]`，結束時吐一次 `['values', 最後的 state]`。 */
  stream(
    input: LoopInput,
    config: StreamConfig,
  ): Promise<AsyncIterable<readonly [mode: string, payload: unknown]>>;
  /** 跑一次，回最後的 state。 */
  invoke(input: LoopInput, config?: InvokeConfig): Promise<LoopState>;
  /** 疊上步數與並行上限，回一個共用同一份 thread state 的新把手。 */
  withConfig(defaults: LoopDefaults): LoopAgent;
  /** 唯讀的 state 視圖，留給測試看對話；沒跑過的 thread 的 `values` 沒有 `messages`。 */
  getState(config: ThreadConfig): Promise<{ readonly values: unknown }>;
  /**
   * 續接時把日誌推出來的對話放進一條**還沒有對話**的 thread（重啟、冷復活、閒置逐出之後新建的 agent）。
   *
   * @param guard - 這份對話能不能放進去的檢查，不能就拋。native 沒有存檔點替它把關，放之前由這一支呼叫；LangGraph 的存檔點寫入時自己驗，
   *   adapter 不呼叫它。
   * @throws 這條 thread 已經有對話（native）：日誌以外的東西不能覆蓋它；`guard` 或存檔點拒收。
   */
  seedThread(
    config: ThreadConfig,
    messages: readonly BaseMessage[],
    guard: (messages: readonly BaseMessage[]) => void,
  ): Promise<void>;
  /**
   * 把剛寫進日誌的幾則接到這條 thread 的對話後面：中止或失敗時 pump 替懸著的呼叫補的結果、被停止那則回覆的半段。
   * 工具結果只收對話上最後一則帶呼叫的回覆**還懸著**的那幾顆，不在懸著清單上的略過。
   */
  appendLoggedMessages(config: ThreadConfig, messages: readonly BaseMessage[]): Promise<void>;
  /**
   * 收回停在等待點、還在記憶體裡等答覆的那次 run：不發事件；停住那一步已經收完的呼叫寫入套進對話，等核准那幾顆的不寫。
   * 停在中斷時 JS 呼叫沒結束的 loop 才有東西可收，其他什麼都不做。
   */
  discardSuspended(config: ThreadConfig): void;
  /**
   * 這條 thread 對話上還沒配到結果的工具呼叫（停在核准點時是等核准的那幾顆，加上同一批排在後面還沒起跑的）。
   * native 從日誌算；LangGraph 的 adapter 問存檔點。TODO(#2363) 連 adapter 一起刪，pump 改成直接從日誌算。
   *
   * @param events - 這份日誌的事件，照 `seq` 排。
   */
  danglingCalls(
    config: ThreadConfig,
    events: readonly SessionEvent[],
  ): Promise<readonly DanglingCall[]>;
}

/**
 * 對話最後一則帶工具呼叫的 AI 訊息裡，**還沒配到結果的那幾顆**。
 *
 * 停在核准點時是那幾顆等核准的，加上同一批排在後面、還沒起跑的呼叫。前景子代理的核准冒到人面前（[#328](https://github.com/DemianLi/nexus-agent/issues/328) 第 1 項），
 * 那時 `task` 也是其中一顆沒配到結果的——`gatedToolsOf` 的 `nested` 把委派工具名併進等核准的名單，卡維持「執行中」。
 *
 * @param values - state 的值，讀它的 `messages`。
 */
export function danglingToolCalls(values: unknown): DanglingCall[] {
  const messages = (values as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages)) return [];
  let last = -1;
  for (let at = messages.length - 1; at >= 0; at -= 1) {
    const message: unknown = messages[at];
    if (AIMessage.isInstance(message) && (message.tool_calls?.length ?? 0) > 0) {
      last = at;
      break;
    }
  }
  if (last < 0) return [];
  const answered = new Set<string>();
  for (const message of messages.slice(last + 1) as unknown[]) {
    if (ToolMessage.isInstance(message)) answered.add(message.tool_call_id);
  }
  const ai = messages[last] as AIMessage;
  return (ai.tool_calls ?? [])
    .filter((call) => call.id !== undefined && !answered.has(call.id))
    .map((call) => ({ id: call.id as string, name: call.name, args: call.args }));
}

/**
 * 日誌上最後一則帶工具呼叫的 `assistant/message` 裡還沒有 `tool/result` 的那幾顆，規則同 {@link danglingToolCalls}，讀的是日誌。
 *
 * @param events - 這份日誌的事件，照 `seq` 排。
 */
export function danglingLoggedCalls(events: readonly SessionEvent[]): DanglingCall[] {
  const answered = new Set<string>();
  for (let at = events.length - 1; at >= 0; at -= 1) {
    const event = events[at]!;
    if (event.type === 'tool/result') {
      answered.add((event as SessionEvent<'tool/result'>).data.callId);
      continue;
    }
    if (event.type !== 'assistant/message') continue;
    const message = toBaseMessage((event as SessionEvent<'assistant/message'>).data.message);
    if (!AIMessage.isInstance(message) || (message.tool_calls?.length ?? 0) === 0) continue;
    return (message.tool_calls ?? [])
      .filter((call) => call.id !== undefined && !answered.has(call.id))
      .map((call) => ({ id: call.id as string, name: call.name, args: call.args }));
  }
  return [];
}

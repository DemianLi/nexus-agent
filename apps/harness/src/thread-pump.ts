/**
 * 下行 pump：把 N 個 run 物件接成一條長期串流。
 *
 * **這是這一層存在的全部理由。** 一場對話不是一個 run 物件——停在核准點時 run 就收掉，
 * `streamEvents(new Command({ resume }), …)` 回的是**另一個** run 物件，而且只帶
 * resume 之後的訊息。把某一個 run 直接交給瀏覽器，核准一次就斷一次線。
 *
 * 量到而且會無聲壞掉的四件事（見開發計劃第 7 節決策 6）：
 *
 * 1. **`seq` 在每個 run 上從 0 重來**，所以接起來的時候一定要重新編號；照原樣轉出去
 *    的話瀏覽器那側的排序與去重會靜靜地壞掉——seq 不會變小到看得出來，它是一段一段重來。
 * 2. **`lifecycle` 的 `{ event:'completed', graph_name:'root' }` 在中斷時照樣會發**，
 *    所以它不是關線的訊號。拿它關線的話每按一次核准就斷一次。
 * 3. **中斷時 raw iteration 乾淨結束、不拋**，所以 pump 從頭到尾不必碰 `run.output`
 *    （那個「暫停時 `await run.output` 會炸」的陷阱屬於核准 UI 那一端）。
 * 4. **失敗會先上線再拋**：最後一顆 frame 是 `lifecycle { event:'failed', … , error }`，
 *    然後 iteration 才 throw。所以這裡的 try/catch 是用來收尾的，不是用來補錯誤 frame 的。
 *
 * 第五件是 `feat/web-hitl` 動工前才量到的，理由不同（它不是接線問題，是**靜默**問題）：
 *
 * 5. **停在核准點時再送一句話，中斷會被靜靜丟掉。** 實測基座照跑新的一輪
 *    （`patchToolCallsMiddleware.before_agent` 補掉懸空的工具呼叫），那個等著核准的工具
 *    **既沒執行也沒被拒絕**，而且**不會再發第二顆 `input.requested`**——核准請求就這樣
 *    蒸發了，下行上一顆 frame 都看不出來。所以 pump 記著還掛著的那些中斷
 *    （{@link ThreadPump.awaitingInput}），讓上行那一側擋得下來；上行擋不到的那種——跑著時收下、
 *    輪到時才撞上核准點——由 pump 自己停住，等中斷答完才跑
 *    （[#629](https://github.com/DemianLi/nexus-agent/issues/629)）。
 *
 * ## 工具卡從日誌開、以日誌收（[#296](https://github.com/DemianLi/nexus-agent/issues/296)、[#297](https://github.com/DemianLi/nexus-agent/issues/297)）
 *
 * dsh 的 web 工具卡只從會話日誌導出：`tool/call` 開卡、`tool/result` 收卡，文字是那則結果的內容
 * （`packages/client/ui-chat/src/client/conversation-nodes/tool.ts:40-66`，`c291e79`）。`tool/call`
 * 在核准之前就寫（`packages/core/agent-loop/src/tool-calls.ts:168`），`tool/result` 在所有鉤子之後
 * 才寫，所以等核准時畫面上已經有卡，事後被改成錯誤的結果畫面上就是錯誤。
 *
 * 我們的 `tools` frame 是基座在**工具本體**被呼叫時發的：本體沒被呼叫到的那些——核准閘門、先讀後改、
 * plan-mode 在 `handler` 之前擋下的，分派前就中止的，基座找不到的工具——一顆都沒有；本體之後才把結果
 * 改掉的 middleware，基座也看不到。所以 pump 訂閱會話註冊表（子代理的日誌也在裡面）：
 *
 * - **開卡**：圍堵寫 `tool/call` 的那一刻合成一顆 `tool-started`（{@link ThreadPump.#openCard}）。
 * - **收卡**：圍堵寫的 `tool/result` 為準。基座那顆 `tool-finished` 已轉發就補發更正、還在路上就等它
 *   來了套上；基座從沒開始的，由這裡合成收尾（{@link ThreadPump.#noteVerdict}）。紅字就是那顆事件帶的
 *   訊息的文字，同 dsh（[#305](https://github.com/DemianLi/nexus-agent/issues/305) 之前日誌不帶內容，
 *   文字另外靠一張發佈期間才讀得到的側表）。
 *
 * **登記的偏離剩兩條。** 一、**基座的 `tools` frame 照舊轉發**，同一張卡因此收得到兩顆 `tool-started`
 * （合成的先、基座的後，折疊器照 id 取代）：子代理的歸屬只從 `task` 那顆 frame 的 `namespace[0]` 學，
 * 而那一段是基座的 task id，日誌上沒有（`@nexus/core` 的 `toolCallSessionAddress` 正是把它去掉的）。
 * 二、**逐字片段仍走基座的 frame**，同 #296。射程只到經過圍堵的呼叫——圍堵是每一層 middleware 陣列的
 * 第 0 格，基座自己長出來、沒有我們 middleware 的 agent 不寫 `tool/call`／`tool/result`，那裡照舊只有
 * 基座的 frame。
 */

import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import {
  INTERRUPTED_REPLY_MARKER,
  isTurnCancelled,
  MAX_TOKENS_TURN_END,
  SessionRegistry,
  TOOL_ABORTED,
  TOOL_ABORTED_BEFORE_DISPATCH,
  TOOL_ABORTED_BEFORE_DISPATCH_REASON,
  TOOL_ABORTED_BEFORE_DISPATCH_TEXT,
  TOOL_ABORTED_REASON,
  TOOL_ABORTED_TEXT,
  toolRefusal,
  TURN_CANCEL_CONFIG_KEY,
  toLoggedMessage,
  turnReachedMaxTokens,
  type SessionAddress,
  type SessionEntry,
  type SessionEvent,
  type SessionEventMap,
  type SessionLog,
  type TurnEndReason,
} from '@nexus/core';
import type { Event, WireChannel } from '@nexus/wire';
import { channelOfMethod, eventId } from '@nexus/wire';

import {
  contextMeasureData,
  deliverablesData,
  isTodosReset,
  modelUsageData,
  SessionTotals,
  todosData,
  workspaceChangesData,
} from './conversation-history.js';
import { driveGoalRound } from './goal-driver.js';
import type { GoalDriverPort, GoalRoundRequest } from './goal-driver.js';
import { capToolResultMeta, toolResultText } from './tool-result-text.js';
import { toolTextConfigSchema } from './settings/tool-text.js';
import type { ToolTextConfig } from './settings/tool-text.js';

/** 基座 v3 run 抽出來的一顆原始封包（`GraphRunStream implements AsyncIterable<ProtocolEvent>`）。 */
interface RawProtocolEvent {
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
interface ToolCallProjection {
  readonly output: Promise<unknown>;
}

/** langchain 投影裡一個子代理：自己的 `output`，外加它那一層的工具呼叫與再下一層的子代理。 */
interface SubagentProjection {
  readonly output: Promise<unknown>;
  readonly toolCalls: AsyncIterable<ToolCallProjection>;
  readonly subagents: AsyncIterable<SubagentProjection>;
}

/**
 * langchain 在 v3 run 物件上掛的原生投影裡，**帶 promise 的那兩種**。可選：替身 agent 沒有它們。
 *
 * 形狀照 `langchain@1.5.10` 的 `dist/agents/transformers/tool-call.js` 與 `subagent.js`。
 */
interface RunProjections {
  readonly toolCalls?: AsyncIterable<ToolCallProjection>;
  readonly subagents?: AsyncIterable<SubagentProjection>;
}

const ignore = (): void => undefined;

/**
 * **把 langchain 投影裡沒人讀的 promise 標成已處理**（[#346](https://github.com/DemianLi/nexus-agent/issues/346)）。
 *
 * v3 run 替每次工具呼叫、每個子代理（連同子代理那一層的工具呼叫）各建一顆 `output`，工具本體一拋錯、
 * 子代理那一輪一失敗就 reject。pump 讀的是原始封包，從來不 await 它們，所以每一顆都會變成未處理的
 * rejection，而 Node 預設遇到就結束行程——serve 上所有 thread 一起斷。`containment` 救不回來：
 * `tool-error` 是工具自己的 run manager 在拋錯當下發的（`@langchain/core` `dist/tools/index.js:141-143`），
 * 早於任何 `wrapToolCall` 的 `catch`。
 *
 * **這不是吞錯。** 這一輪的失敗照舊以 `lifecycle failed` 上線、記成 `turn/failed`；工具的錯照舊由
 * `containment` 回給模型。標掉的只是那份沒有人要讀的副本。
 *
 * **偏離，登記**：dsh 沒有對應物——它的串流不造出這種 promise，行程層的 unhandled rejection 在那邊是
 * 「大聲死」（`installFailLoud`），所以我們也不在行程層接。代價是這裡**依賴投影的形狀**：哪天 langchain
 * 加一種帶 promise 的原生投影，這裡會漏。上游修掉那天，`tool-throw-orphan.test.ts` 的上游絆索會紅，
 * 這一段該拆。
 *
 * 不等它：投影在 run 收尾（或失敗）時才關，而那時 pump 早就往下走了。迭代本身在 run 失敗時也會拋，
 * 所以每一條背景迴圈自己也要接住——不然修掉一顆孤兒又生一顆。
 */
function markProjectionsHandled(projections: RunProjections): void {
  if (projections.toolCalls !== undefined) markToolCalls(projections.toolCalls);
  if (projections.subagents !== undefined) markSubagents(projections.subagents);
}

function markToolCalls(calls: AsyncIterable<ToolCallProjection>): void {
  void (async () => {
    for await (const call of calls) call.output.catch(ignore);
  })().catch(ignore);
}

function markSubagents(subagents: AsyncIterable<SubagentProjection>): void {
  void (async () => {
    for await (const subagent of subagents) {
      subagent.output.catch(ignore);
      markToolCalls(subagent.toolCalls);
      markSubagents(subagent.subagents);
    }
  })().catch(ignore);
}

/** 這條 thread 的 checkpoint 位址。 */
interface ThreadConfig {
  readonly configurable: { readonly thread_id: string };
}

/**
 * pump 對 agent 的全部要求：給我一個可抽的 v3 run，與讀寫這條 thread 的 checkpoint。
 *
 * 後兩個是中止這一輪加的（[#276](https://github.com/DemianLi/nexus-agent/issues/276)）：停在核准點時
 * 收回要知道哪幾顆呼叫還懸著、要把收回的結果寫進去；模型講到一半被切斷時要把使用者看到的那半段
 * 寫回對話。
 */
export interface PumpAgent {
  streamEvents(
    input: never,
    config: {
      readonly version: 'v3';
      readonly configurable: {
        readonly thread_id: string;
        /** 這一輪的中止訊號。**不交給 LangGraph 的 `signal`**，理由見 `@nexus/core` 的 `turn-cancel.ts`。 */
        readonly [TURN_CANCEL_CONFIG_KEY]?: AbortSignal;
      };
    },
  ): Promise<AsyncIterable<RawProtocolEvent> & RunProjections>;
  getState(config: ThreadConfig): Promise<{ readonly values: unknown }>;
  updateState(config: ThreadConfig, values: Record<string, unknown>): Promise<unknown>;
}

/**
 * 送進去的東西：一句話、一組核准決定，或**排程器排的一輪續行**。
 *
 * `goal` 那一種與 `message` 在圖上走同一條路（都是一則 `HumanMessage`），差別全在日誌
 * 上那顆 `turn/start` 的 `kind`——而那一格是授權的判別欄（`session-log.ts`）。
 */
export type PumpInput =
  | { readonly kind: 'message'; readonly text: string }
  | {
      readonly kind: 'resume';
      /**
       * 這個決定回答的是**哪一顆**中斷。
       *
       * 承重：`Command({ resume })` 在基座有兩條路——鍵全是 32 個小寫 hex（`isXXH3`，
       * `@langchain/langgraph@1.4.12` 的 `hash.js`）走逐 task 派送，否則整個
       * `resume` 值**廣播給每一顆待決的 task**（`pregel/io.js:48`）。裸值送出去走的
       * 正是廣播那一支，那就是「一個決定套到同一輪兩顆中斷上」的機制本身
       * （[#232](https://github.com/DemianLi/nexus-agent/issues/232)）。
       */
      readonly interruptId: string;
      readonly response: unknown;
    }
  | ({ readonly kind: 'goal' } & GoalRoundRequest);

interface Subscriber {
  readonly channels: readonly WireChannel[];
  readonly queue: Event[];
  wake?: () => void;
  done: boolean;
}

/**
 * 排著、還沒開跑的一件事（[#629](https://github.com/DemianLi/nexus-agent/issues/629)）。
 *
 * 分兩種，照 dsh：**答覆**（`resume` 與收回）屬於停在核准點的那一輪，**開新一輪的**（說話、續行）是收件匣
 * 裡的東西，只在一輪開始時領（`packages/core/agent-loop/src/agent.ts:296-330` 的 `turn()`，`477b4f4`）。
 */
interface QueuedJob {
  /** 是答覆：停在核准點時照樣跑，而且排在開新一輪的前面。 */
  readonly answers: boolean;
  readonly run: () => Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

/** 掛在這條 thread 上、還沒被回答的其中一顆中斷。 */
export interface PendingInterrupt {
  readonly interruptId: string;
  /** 這一批要回答幾筆決定——基座逐 index 配對，長度不符當場拋。 */
  readonly actionCount: number;
  /**
   * 停在核准閘門上的那幾顆工具的名字（酬載的 `actionRequests[].name`）；問答那一種是空的。
   *
   * 重播靠它分兩種等法（[#317](https://github.com/DemianLi/nexus-agent/issues/317)）：日誌上兩種都只留一顆沒落定的
   * `tool/call` 與一顆只帶 id 的 `interrupt/raised`，閘門的酬載也沒有 callId——這裡是唯一分得出來的地方。
   */
  readonly gatedTools: readonly string[];
}

/** 基座把中斷發在 `updates` 上的那一顆的 data 形狀。 */
interface InterruptEntry {
  readonly id: string;
  readonly value: unknown;
}

/**
 * 一串值裡認得出來的中斷條目。
 *
 * **抽出來是因為它有第二個消費者**：一顆掛著的中斷在 `tools` 通道上會先變成一顆
 * `tool-error`，而它的 `message` 正是**這串東西序列化過的 JSON**（實測，見
 * {@link ThreadPump.#translate}）。兩邊各寫一份「怎麼認」的話，基座哪天換掉這個形狀，
 * 會變成中斷還折得出來、但工具條目又開始謊報失敗——而那不會有任何測試紅。
 */
function interruptEntriesOf(values: unknown): readonly InterruptEntry[] {
  if (!Array.isArray(values)) {
    return [];
  }
  return values.filter(
    (entry): entry is InterruptEntry =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as InterruptEntry).id === 'string',
  );
}

function asInterruptEntries(data: unknown): readonly InterruptEntry[] {
  // `updates` 的 data 是 `{ node, values }`，中斷那一顆的 values 才是中斷清單。
  return interruptEntriesOf((data as { values?: unknown } | null)?.values);
}

/**
 * 這顆 `tool-error` 其實是「停下來等人」嗎。
 *
 * ## 為什麼分類要做在這裡
 *
 * 中斷是用**拋例外**實作的（`interrupt()`），所以基座的 tools 節點把它當成工具炸了，
 * 在線上發一顆 `tool-error`——`message` 裝的是那顆 `GraphInterrupt` 的酬載。下游沒有第二
 * 個訊號分得出「等人」與「炸了」，於是畫面把一顆還沒回的問題畫成紅字「失敗」，
 * 而且把整串原始酬載當錯誤訊息印出來（[#239](https://github.com/DemianLi/nexus-agent/issues/239)
 * 實測）。
 *
 * **`tools` 那幾顆 frame 是基座產的**（`streamEvents(version: 'v3')` 直出），最靠近來源的那一層
 * 就是這裡的 `#translate`。分類放到瀏覽器那側等於讓消費端去猜一個它看不見的成因。
 *
 * ## 判準是結構不是字串
 *
 * 不比對措辭——比對**它 parse 出來是不是一串中斷條目**，而且用的是
 * {@link interruptEntriesOf}，跟 `updates/__interrupt__` 那條路同一個讀法。一則真的工具
 * 錯誤，`message` 是那個 Error 的訊息，parse 不成陣列。
 *
 * @param message - `tool-error` 帶的訊息。
 * @returns 認得出中斷條目就是 `true`。
 */
function isSuspensionMessage(message: unknown): boolean {
  if (typeof message !== 'string') return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return false;
  }
  return Array.isArray(parsed) && interruptEntriesOf(parsed).length > 0;
}

/**
 * 把 `tools` 那一顆的 `data` 換成**說得出成因**的樣子。
 *
 * 兩件事，兩個成因不同的謊：
 *
 * 1. 掛著等人的中斷來的是 `tool-error`（中斷用拋的），換成 `tool-suspended`，**而且不帶
 *    `message`**——那串東西是中斷酬載，不是給人看的錯誤訊息。
 * 2. 一則 `status: 'error'` 的 ToolMessage 來的是 `tool-finished`，補一格 `failed` 與它的
 *    內容，否則折疊器只看事件名，會把它畫成「完成」。
 *
 * **其餘一律原樣穿過去。** 這一層只看基座那顆 frame 本身，不改基座的欄位。第 2 項讀的是**工具本體**
 * 回的那則，而本體之後還有 middleware 會改結果——終態以日誌為準的那一步在 pump 的
 * `#settleFinish`（[#296](https://github.com/DemianLi/nexus-agent/issues/296)），這裡的判斷是日誌
 * 判定沒來時的退路。
 *
 * @param data - 基座給的那顆 `tools` data。
 * @returns 原樣，或補過分類的那一顆。
 */
export function classifyToolData(data: unknown): unknown {
  const shaped = data as { event?: unknown; message?: unknown; output?: unknown } | null;
  if (shaped === null || typeof shaped !== 'object') return data;
  if (shaped.event === 'tool-error' && isSuspensionMessage(shaped.message)) {
    const { message: _dropped, ...rest } = shaped as Record<string, unknown>;
    return { ...rest, event: 'tool-suspended' };
  }
  if (shaped.event === 'tool-finished') {
    const failure = failureTextOf(shaped.output);
    if (failure !== undefined) return { ...shaped, failed: true, message: failure };
  }
  return data;
}

/**
 * 參數解不開的那顆，模型吐的原字串（[#281](https://github.com/DemianLi/nexus-agent/issues/281)）。
 *
 * 那一顆在歷史裡已經被改寫成 `{}`（`@nexus/core` 的 `invalid-tool-args.ts`），所以基座發的
 * `tool-started` 帶的 `input` 是 `"{}"`。原字串在同一條串流上更早的地方：模型那一段收尾時的
 * `content-block-finish`，block 的 `type` 是 `invalid_tool_call`（實測）。pump 記下它，等
 * `tool-started` 來了換掉 `input`——這是 #269 登記的偏離：工具卡的參數由 pump 換，因為開卡的
 * `tool-started` 是基座產的，我們能做的是轉發時改它。
 *
 * **不讀 core 的載體**：那一份在工具落定時就刪鍵，而這一層讀到 frame 的時刻可能晚於落定。
 * 同一條串流上的先後則是保證的：模型那一段收尾之後，工具節點才開始。
 *
 * @param data - `messages` 那一顆的 `data`。
 * @returns 解不開的那顆的 id 與原字串；不是那種 block 就 `undefined`。
 */
export function invalidArgumentsOf(data: unknown): { id: string; raw: string } | undefined {
  const shaped = data as { event?: unknown; content?: unknown } | null;
  if (shaped === null || typeof shaped !== 'object') return undefined;
  if (shaped.event !== 'content-block-finish') return undefined;
  const block = shaped.content as { type?: unknown; id?: unknown; args?: unknown } | null;
  if (block === null || typeof block !== 'object' || block.type !== 'invalid_tool_call') {
    return undefined;
  }
  return typeof block.id === 'string' && typeof block.args === 'string'
    ? { id: block.id, raw: block.args }
    : undefined;
}

/**
 * 這則工具結果自己說它失敗了嗎。
 *
 * `tool-finished` 帶的 `output` 是一則序列化過的 `ToolMessage`，**失敗與否住在
 * `kwargs.status` 裡**（核准閘門的拒絕、`ask_user_question` 的放棄都走這條）。折疊器
 * 今天只看事件名，所以一則 `status: 'error'` 的結果在畫面上是「完成」——這是
 * [#239](https://github.com/DemianLi/nexus-agent/issues/239) 第 1 項的另一面。
 *
 * **讀 `kwargs` 這個形狀的知識留在這一層**：`@nexus/wire` 跑在瀏覽器裡、不相依
 * LangChain，讓它去拆序列化格式等於把基座的形狀搬進前端。
 *
 * @param output - `tool-finished` 的 `output`。
 * @returns 那則 ToolMessage 的 `status` 是 `'error'` 時回它的內容，否則 `undefined`。
 */
function failureTextOf(output: unknown): string | undefined {
  // **這一層拿到的是 `ToolMessage` 實例，不是它序列化過的樣子。** 實測 pump 這裡的
  // `output` 帶的是 `lc_serializable` / `lc_kwargs` 那組欄位，`status` 直接掛在實例上；
  // 客戶端看到的 `{ lc, type, kwargs }` 是 SSE 那次 `JSON.stringify` 才長出來的。
  // 兩個形狀都認，因為**這條線上有兩個位置讀得到同一個東西**，只認一個的話換位置就靜靜失效。
  const shaped = output as {
    status?: unknown;
    content?: unknown;
    kwargs?: { status?: unknown; content?: unknown };
  } | null;
  const status = shaped?.status ?? shaped?.kwargs?.status;
  if (status !== 'error') return undefined;
  const content = shaped?.content ?? shaped?.kwargs?.content;
  return typeof content === 'string' ? content : '未指名的錯誤';
}

/**
 * 日誌對一次呼叫的判定（#296）：失敗與否、模型看到的那一句，與給畫面的 `meta`（#617，已照上限截過；
 * 失敗的不帶）。
 */
interface ToolVerdict {
  readonly failed: boolean;
  readonly text: string | undefined;
  readonly meta?: unknown;
}

/** 已經轉發出去、還在等日誌判定的那顆 `tool-finished`。更正時原樣帶回它的 namespace 與 data。 */
interface ForwardedFinish {
  readonly namespace: readonly string[];
  readonly data: Record<string, unknown>;
}

/**
 * 把日誌的判定套到一顆 `tool-finished` 的 data 上。
 *
 * `message` 是**這次呼叫的結果文字**，成功與失敗都帶（#439）：成功時就是日誌那一則的內容，
 * 沒抽出文字（多塊內容）就不帶這一格；失敗時取同一段字，沒有的話退回本體自己說的，再退回
 * 「未指名的錯誤」。畫面上分紅字還是輸出，看的是 `failed`，同 dsh 的 content ＋ isError。
 */
function applyVerdict(
  data: Record<string, unknown>,
  verdict: ToolVerdict,
): Record<string, unknown> {
  const { failed: _failed, message: bodyText, meta: _meta, ...rest } = data;
  if (!verdict.failed) {
    return {
      ...rest,
      ...(verdict.text === undefined ? {} : { message: verdict.text }),
      // `meta` 同 dsh 的 `SessionWireEvent.data.meta`：原封不動交給 client 的卡片模型驗。
      ...(verdict.meta === undefined ? {} : { meta: verdict.meta }),
    };
  }
  return {
    ...rest,
    failed: true,
    message: verdict.text ?? (typeof bodyText === 'string' ? bodyText : '未指名的錯誤'),
  };
}

/**
 * 從日誌開的那張卡，掛在哪個 namespace 上（#297）。
 *
 * 折疊器只看得懂兩件事：長度 ≤ 1 是 root，否則拿 `namespace[0]` 去查 `task` 那顆 frame 記下的子代理
 * （`@nexus/wire` 的 `attribute`）。子代理的 `runId` 就是父圖那次 `task` 呼叫的命名空間，與基座給那顆
 * `task` frame 的 `namespace[0]` 同一個值；第二段只是讓長度過 1，基座那一段（本次呼叫自己的 task id）
 * 日誌上沒有。
 */
function cardNamespace(address: SessionAddress): readonly string[] {
  return address.kind === 'root' ? [] : [address.runId, 'tools'];
}

/** 一次輸入在日誌上的那顆頭。**三種各自對應一個 `kind`**，見 `session-log.ts`。 */
function turnStartOf(input: PumpInput): SessionEventMap['turn/start'] {
  switch (input.kind) {
    case 'message':
      return { kind: 'message', text: input.text };
    case 'resume':
      return { kind: 'resume' };
    case 'goal':
      return {
        kind: 'goal',
        text: input.text,
        goalId: input.goalId,
        revision: input.revision,
        round: input.round,
      };
  }
}

/** 這顆中斷在問幾件事。問不出來就當 0——上行那側只在數得出來時才校驗。 */
function actionCountOf(value: unknown): number {
  const requests = (value as { actionRequests?: unknown } | null)?.actionRequests;
  return Array.isArray(requests) ? requests.length : 0;
}

/** 這顆中斷停在閘門上的工具名。問答那一種沒有 `actionRequests`，是空的。見 {@link PendingInterrupt.gatedTools}。 */
function gatedToolsOf(value: unknown): string[] {
  const requests = (value as { actionRequests?: unknown } | null)?.actionRequests;
  if (!Array.isArray(requests)) return [];
  return requests.flatMap((request: unknown) => {
    const name = (request as { name?: unknown } | null)?.name;
    return typeof name === 'string' ? [name] : [];
  });
}

/** 人按了停止——`turn/end` 帶的那一格。見 `session-log.ts` 的 `turn/end`。 */
const ABORTED_BY_USER: TurnEndReason = { kind: 'aborted', cause: { kind: 'user' } };

/**
 * 派子代理的那顆工具的名字。
 *
 * **只用在收回時選碼**：停在核准點時懸著的 root 呼叫，一般是那幾顆等核准的（從沒開始 →
 * `ABORTED_BEFORE_DISPATCH`）；而**等核准的是子代理的話**，root 這一層懸著的是 `task` 本身——它早就
 * 開始了，是 `ABORTED`。名字取自 deepagents 的 `task` 工具。
 */
const DELEGATION_TOOL = 'task';

/**
 * 正在跑的那一輪：它自己的中止控制器，與 pump 在線上看到的、root 那則還沒講完的回覆。
 *
 * **半段文字只有這裡看得到**：產品路徑的 `streamEvents` v3 上，逐字片段不經過模型層的回呼，
 * 經過的是這條線（見 `@nexus/core` 的 `turn-cancel.ts`「兩處偏離」）。這裡收到的正好是瀏覽器畫出
 * 來的那些字。
 */
interface CurrentRun {
  readonly controller: AbortController;
  /** root 那則回覆到目前為止的文字。`message-finish` 之後清空——講完的那則已經在 checkpoint 裡了。 */
  partial: string;
  /** 同 {@link partial}，是那則回覆到目前為止的推理（#561）。 */
  reasoning: string;
  /** root 有一則回覆講到一半。 */
  replyOpen: boolean;
  /** root 那顆收尾的 `lifecycle` 已經標成中止送上線了。日誌照它收尾，畫面與日誌才對得上。 */
  stopped: boolean;
  /** 同 {@link stopped}，標的是撞到輸出上限（#433）。 */
  maxTokens: boolean;
}

/** root 那一層的訊息片段（子代理的 namespace 至少兩段，見 `@nexus/wire` 的 `attribute`）。 */
function trackRootReply(current: CurrentRun, raw: RawProtocolEvent): void {
  if (raw.method !== 'messages' || raw.params.namespace.length > 1) return;
  const data = raw.params.data as {
    event?: string;
    delta?: { type?: string; text?: string; reasoning?: string };
  } | null;
  switch (data?.event) {
    case 'message-start':
      current.partial = '';
      current.reasoning = '';
      current.replyOpen = true;
      return;
    case 'content-block-delta':
      if (data.delta?.type === 'text-delta') current.partial += data.delta.text ?? '';
      if (data.delta?.type === 'reasoning-delta') current.reasoning += data.delta.reasoning ?? '';
      return;
    case 'message-finish':
      current.partial = '';
      current.reasoning = '';
      current.replyOpen = false;
      return;
    default:
      return;
  }
}

/** root 那一層「這一輪結束了」的那顆 `lifecycle`：完成與失敗都算。 */
/** root 那一層正常收尾的 `lifecycle`。失敗的那一顆不算：拋錯記的是 `turn/failed`。 */
function isRootCompleted(raw: RawProtocolEvent): boolean {
  return (
    isRootTerminal(raw) && (raw.params.data as { event?: unknown } | null)?.event === 'completed'
  );
}

function isRootTerminal(raw: RawProtocolEvent): boolean {
  if (raw.method !== 'lifecycle' || raw.params.namespace.length > 0) return false;
  const data = raw.params.data as { event?: unknown; graph_name?: unknown } | null;
  return data?.graph_name === 'root' && (data.event === 'completed' || data.event === 'failed');
}

/**
 * checkpoint 上最後一則帶工具呼叫的 AI 訊息裡，**還沒配到結果的那幾顆**。
 *
 * 停在核准點時就是那幾顆等核准的。子代理照 dsh 不停下來等人
 * （[#324](https://github.com/DemianLi/nexus-agent/issues/324)），所以 `task` 不會是其中一顆。
 */
function danglingToolCalls(values: unknown): { readonly id: string; readonly name: string }[] {
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
    .map((call) => ({ id: call.id as string, name: call.name }));
}

export class ThreadPump {
  readonly #agent: PumpAgent;
  readonly #threadId: string;
  /** 一段工具結果文字放上線的上限，見建構子的 `toolText`（#538）。 */
  readonly #toolTextMaxBytes: number;
  readonly #subscribers = new Set<Subscriber>();
  readonly #sessions: SessionRegistry;
  /**
   * 傳輸層的號，給瀏覽器排序去重用的。
   *
   * **跟 {@link ThreadPump.sessionLog} 的 `seq` 是兩個號、兩個工作**，而且刻意不互相
   * 讀取——[#89](https://github.com/DemianLi/nexus-agent/issues/89) 否掉方案 (A) 的理由
   * 就是「拿傳輸序號去冒充耐久序號」。這個號在伺服器重啟時歸零（pump 是 per-instance 的），
   * 那對瀏覽器無所謂，對遙測會要命。
   */
  #seq = 0;
  /**
   * 還沒被回答的中斷，**逐 `interruptId` 並存**。
   *
   * 同一輪兩個工具都要核准時閘門逐次呼叫各自 `interrupt()`，`#translate` 那個迴圈
   * 會一次收到兩顆。這裡曾經是單一欄位，第二顆直接覆寫第一顆——上行那側因此會把
   * 「回答第一顆」判成 `no_such_interrupt`。
   */
  readonly #pending = new Map<string, PendingInterrupt>();
  /**
   * 參數解不開的那幾顆：callId → 模型吐的原字串，見 {@link invalidArgumentsOf}。
   *
   * **活在 thread 上、不是 run 上**：要核准的那顆，模型那一段在第一個 run，`tool-started` 在人按了
   * 核准之後的那個 run。換過一次就刪；被拒的那顆永遠等不到 `tool-started`，留著一筆短字串到 thread
   * 結束。
   */
  readonly #invalidArguments = new Map<string, string>();
  /**
   * 圖裡注進來的那幾則 human 訊息的 `run_id`——**這些 frame 不上線**（[#388](https://github.com/DemianLi/nexus-agent/issues/388)）。
   *
   * middleware 往 state 塞一則 `HumanMessage` 時（工作區指令的基線、重複提醒），LangGraph 照樣把它當成
   * 一則訊息串出來：`message-start role: "human"` ＋ 逐段 `content-block-delta`。而 `@nexus/wire` 的
   * `reduceMessage` 看到 `role: "human"` 就開一顆使用者泡泡——它的註解寫著「**`human` 只有歷史送**：
   * 線上不回聲人打的字」，那句話一直是**假設**，不是有人在擋。基線一來就被打破：畫面上每個會話開頭都會多
   * 一顆幾百個位元組的 `<system-reminder>` 泡泡，而那是給模型看的東西，不是誰講的話。
   *
   * **所以這裡把那個假設變成護欄**：線上一則 human 訊息都不送。人剛打的那句走 `appendHumanTurn`，
   * 重播的那幾句走歷史（`conversation-history.ts`，它同樣不畫外掛注入的 `user/message`）——兩條都不經過
   * 這裡。認的是 `run_id`：`content-block-delta` 與 `message-finish` 上沒有 `role`。
   */
  readonly #injectedMessages = new Set<string>();
  /**
   * 這一輪轉發過、還在等日誌判定的 `tool-finished`：callId → 那顆 frame
   * （[#296](https://github.com/DemianLi/nexus-agent/issues/296)）。
   *
   * **工具卡的終態以日誌的 `tool/result` 為準**，不以基座那顆 `tool-finished` 為準：基座在工具本體
   * 裡就發了它，之後還有 middleware 把成功換成錯誤——檔案工具的失敗、輸出不合 schema、停止之後才落定
   * 的那顆、內層在本體之後拋錯。判定比 frame 晚到 pump 的話，由這裡補發一顆同 id 的更正。
   */
  readonly #forwardedFinishes = new Map<string, ForwardedFinish>();
  /**
   * 比那顆 `tool-finished` 先到 pump 的判定。日誌的訂閱者是同步叫的，frame 是 `for await` 抽的，
   * 兩種先後都會發生。
   */
  readonly #earlyVerdicts = new Map<string, ToolVerdict>();
  /**
   * 從日誌 `tool/call` 開過、還沒收的卡：callId → 它的 namespace（#297）。
   *
   * **活在 thread 上、不是 run 上**，理由同 {@link ThreadPump.#invalidArguments}：被核准閘門中斷的那顆，
   * `tool/call` 在第一個 run 記一次，resume 之後圍堵再進一次、再記一次。第二次不再開卡。
   */
  readonly #openCards = new Map<string, readonly string[]>();
  /**
   * 這一輪轉發過基座 `tool-started` 的 callId：本體被呼叫到了，它那顆 `tool-finished` 會來。
   * 不在這裡的，落定時由 pump 自己收卡。
   */
  readonly #bodyStarted = new Set<string>();
  /** 收掉日誌的訂閱：註冊表那一層，與每一份日誌那一層。 */
  readonly #unobserveLogs: () => void;
  /**
   * root 日誌的會話累計（[#574](https://github.com/DemianLi/nexus-agent/issues/574)）：token 總帳與會話統計，從日誌
   * 開頭折起。**這是 pump 唯一記著的投影狀態**——用量表、待辦清單一顆事件就算得出值，這兩個是累計的。
   */
  readonly #totals = new SessionTotals();
  /**
   * 排著、還沒開跑的事。**一個 thread 一次只跑一件**；後到的排隊，不平行跑。
   *
   * 挑下一件的規則在 {@link ThreadPump.#nextIndex}：答覆先跑；還有中斷掛著、又沒有答覆排著的時候，
   * 開新一輪的停住（#629）。
   */
  readonly #queue: QueuedJob[] = [];
  /** 有一件正在跑（一輪 run，或一次收回）。 */
  #busy = false;
  /** 等「沒有可跑的、也沒在跑」的人，見 {@link ThreadPump.whenIdle}。 */
  readonly #idleWaiters: (() => void)[] = [];
  /**
   * 還沒抽完的 run 有幾段——**排隊的也算，停住的也算**。
   *
   * 這個計數存在的理由在 {@link ThreadPump.running}：上行的回應是收件回條，
   * 「已經收下但還沒開跑」與「正在跑」對發派斜線命令的那一側是同一件事。
   */
  #inFlight = 0;
  #closed = false;
  /** 正在跑的那一輪；沒有就是 `undefined`（閒著、停在核准點、或排著還沒開跑）。 */
  #current: CurrentRun | undefined;
  /**
   * 續行排程器那一側。**`undefined` 就是沒掛**——這條 thread 一輪都不會自己排。
   *
   * 它是建構參數而不是後來設得上去的一格：掛不掛是一次組裝的決定（`--goal-driver`），
   * 而一條跑到一半忽然開始自己排輪次的 thread 沒有人要得起。
   */
  readonly #driver: GoalDriverPort | undefined;

  /**
   * @param agent - 這條 thread 的 agent。
   * @param threadId - 就是 root 會話的 id。
   * @param driver - 續行排程器那一側；省略即這條 thread 一輪都不自己排。
   * @param rootSeed - root 日誌的 seed：serve 碰到一條以前寫過的 thread 時，上一個行程留下的
   *   事件（[#251](https://github.com/DemianLi/nexus-agent/issues/251) 的門 A，同 CLI 的
   *   `--resume`）。省略即一份新日誌。
   * @param toolText - 一段工具結果文字放上線的上限（[#538](https://github.com/DemianLi/nexus-agent/issues/538)）。
   *   值由 `serve.ts` 在起動期從清單解出來、經 `createWireHandler` 傳進來。**省略即 schema 的
   *   預設**——這條路上有二十九個測試呼叫點，全部改成必填買不到任何東西：它們量的不是上限。
   */
  constructor(
    agent: PumpAgent,
    threadId: string,
    driver?: GoalDriverPort,
    rootSeed?: readonly SessionEvent[],
    toolText?: ToolTextConfig,
  ) {
    this.#agent = agent;
    this.#threadId = threadId;
    this.#toolTextMaxBytes = (toolText ?? toolTextConfigSchema.parse({})).maxBytes;
    this.#sessions = new SessionRegistry(threadId, rootSeed === undefined ? {} : { rootSeed });
    this.#driver = driver;
    // 訂閱**註冊表**，不是只訂 root：子代理的日誌後來才開，`observe` 會補上每一份（#296）。
    // 這個回呼跑在寫日誌那一層的堆疊上，而註冊表不接訂閱者的例外——`subscribe` 本身不會拋。
    const unsubscribes: (() => void)[] = [];
    const unobserve = this.#sessions.observe((entry) => {
      if (entry.address.kind === 'root') {
        // 上一個行程留下的那一段（seed）先折進來、不送：那一段的值由歷史的最後一頁送。漏折它的話，重開之後送出去的
        // 總帳只剩這個行程叫的那幾次。**跟訂閱在同一個同步段裡**，中間沒有空檔讓一顆事件兩邊都沒算到或兩邊都算到。
        this.#totals.seed(entry.log.events);
        this.#totals.flush();
      }
      unsubscribes.push(entry.log.subscribe((event) => this.#noteLogEvent(entry, event)));
    });
    this.#unobserveLogs = () => {
      unobserve();
      for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
    };
  }

  get threadId(): string {
    return this.#threadId;
  }

  /**
   * 這條 thread 的會話註冊表：**root 那一份，加上 subagent 後來出生的那些**。
   *
   * 三個消費者接的是它而不是單一份日誌，理由見
   * {@link @nexus/core!SessionRegistry}。
   */
  get sessions(): SessionRegistry {
    return this.#sessions;
  }

  /** 這條 thread 的 root 會話事件日誌。**耐久序號的擁有者**，見 `@nexus/core` 的 `SessionLog`。 */
  get sessionLog(): SessionLog {
    return this.#sessions.root;
  }

  /** 掛著等人回答的中斷，發出的順序。一顆都沒有就是空的。 */
  get pendings(): readonly PendingInterrupt[] {
    return [...this.#pending.values()];
  }

  /** 這條 thread 停在核准點沒有——**任何一顆**掛著就算。 */
  get awaitingInput(): boolean {
    return this.#pending.size > 0;
  }

  /** 停在核准閘門上的工具名，所有掛著的中斷合起來。見 {@link PendingInterrupt.gatedTools}。 */
  get gatedTools(): ReadonlySet<string> {
    return new Set([...this.#pending.values()].flatMap((pending) => pending.gatedTools));
  }

  /** 認領某一顆。認不得就是 `undefined`，上行那側據此回 `no_such_interrupt`。 */
  pendingFor(interruptId: string): PendingInterrupt | undefined {
    return this.#pending.get(interruptId);
  }

  /**
   * 這條 thread 上有沒有 run 還沒跑完——**排隊中的也算**，停在核准點而等著的那幾句也算（#629）。
   * 所以停在核准點時它可以跟 {@link ThreadPump.awaitingInput} 同時為真。
   *
   * 給上行那一側擋斜線命令用（[#123](https://github.com/DemianLi/nexus-agent/issues/123)）。
   * 與 {@link ThreadPump.awaitingInput} 各擋一種：那個是「停在核准點」，這個是「還在飛」。
   * 兩個都不擋的話，`/plan` 的 pending intent 會跟飛行中那一輪的 `beforeAgent` 賽跑。
   */
  get running(): boolean {
    return this.#inFlight > 0;
  }

  /**
   * 開一條下行。它**跨 run 存活**：核准前後是同一條線。
   *
   * 沒有重播——訂閱之前發生的事這條線上看不到，接回來的方式是重開 ＋ 重抓歷史
   * （照 dsh 的 `reconnection = reopen the stream + refetch history`）。
   */
  subscribe(
    channels: readonly WireChannel[],
    signal?: AbortSignal,
  ): AsyncGenerator<Event, void, undefined> {
    // **註冊是同步的**，抽是之後的事。這樣「線開好了」與「開始抽」才是兩件事——
    // 開好之後才發生的 frame 一顆都不會掉在中間，即使消費端還沒開始抽。
    const subscriber: Subscriber = { channels, queue: [], done: this.#closed };
    this.#subscribers.add(subscriber);
    return this.#drain(subscriber, signal);
  }

  async *#drain(
    subscriber: Subscriber,
    signal?: AbortSignal,
  ): AsyncGenerator<Event, void, undefined> {
    const onAbort = () => {
      // **中止的是這條線，不是 run。** 瀏覽器關掉分頁不該讓 agent 停下來。
      subscriber.done = true;
      subscriber.wake?.();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      for (;;) {
        while (subscriber.queue.length > 0) {
          yield subscriber.queue.shift() as Event;
        }
        if (subscriber.done) {
          return;
        }
        await new Promise<void>((resolve) => {
          subscriber.wake = resolve;
        });
        subscriber.wake = undefined;
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.#subscribers.delete(subscriber);
    }
  }

  /** 目前有幾條下行掛著。給 handler 與測試看的。 */
  get subscriberCount(): number {
    return this.#subscribers.size;
  }

  /**
   * 送一件事進去，排在目前那一輪後面跑。
   *
   * **說話與續行在停在核准點時不開跑**（[#629](https://github.com/DemianLi/nexus-agent/issues/629)）：
   * 它們留在隊裡，等中斷被回答或收回、那一輪收掉之後才照 FIFO 跑。答覆（`resume`）排在它們前面。
   *
   * 回傳的 promise 在**這一段** run 抽完時 resolve（跑完或停在核准點都算）；停住的那段要等它真的
   * 跑完。收線時還停著的會 reject。上行的 handler 不等它——那是收件回條，不是「跑完了」。
   */
  submit(input: PumpInput): Promise<void> {
    if (this.#closed) {
      return Promise.reject(new Error('這條 thread 已經收掉了'));
    }
    // **收下的那一刻就不再掛著了，不是等它排到才清。** 排隊期間還掛著的話，連按兩次
    // 核准的第二次會通過上行的校驗、送出第二次 resume，而那時已經沒有中斷可以回答。
    //
    // **只收掉被答的那一顆。** 同一輪的其他中斷還等著人，整個清掉的話回答它們會被
    // 判成 `no_such_interrupt`。
    //
    // 說話與續行**不碰**掛著的中斷：它們停在隊裡等（#629）。以前這裡整個清掉當止血，那等於
    // 讓繞過上行那道擋的呼叫端把中斷靜靜丟掉——正是這張卡要修的事換一扇門進來。
    if (input.kind === 'resume') {
      this.#pending.delete(input.interruptId);
    }
    return this.#schedule(() => this.#runOnce(input), input.kind === 'resume');
  }

  /**
   * 排一件事到這條 thread 的序列上：一輪 run，或一次收回（{@link ThreadPump.cancel}）。
   *
   * 收回走同一條序列，是因為它也要讀寫 checkpoint、也要寫一輪日誌——跟一輪 run 並行的話，
   * 兩邊的 `turn/start`／`turn/end` 會交錯，不變量會把它讀成寫錯了。
   *
   * @param answers - 是不是答覆（`resume`、收回），見 {@link QueuedJob.answers}。
   */
  #schedule(run: () => Promise<void>, answers: boolean): Promise<void> {
    // **同步就加一**：上行回的是收件回條，緊接著到的 `slash.run` 必須看得到「在飛」。
    this.#inFlight += 1;
    const done = new Promise<void>((resolve, reject) => {
      this.#queue.push({ answers, run, resolve, reject });
    });
    // **不在這裡同步開跑**：`turn/start` 記在真正開跑的那一刻（`#runOnce`），不是收下的那一刻。
    this.#kick();
    return done;
  }

  /** 下一個 microtask 看看有沒有能跑的。 */
  #kick(): void {
    void Promise.resolve().then(() => this.#next());
  }

  /**
   * 下一件能跑的在隊裡哪一格；沒有就是 -1。
   *
   * **答覆先跑**：它屬於停在核准點的那一輪，連比它早排進來的說話也要讓它（第一輪還在收尾時就答了，
   * 答覆排在第二句後面）。**還有中斷掛著、又沒有答覆排著的時候，開新一輪的停住**——照 dsh，收件匣只在
   * 一輪開始時領，而那一輪還沒結束（#629）。其餘照 FIFO。
   */
  #nextIndex(): number {
    const answer = this.#queue.findIndex((job) => job.answers);
    if (answer >= 0) return answer;
    if (this.#pending.size > 0) return -1;
    return this.#queue.length > 0 ? 0 : -1;
  }

  #next(): void {
    if (this.#busy) return;
    const index = this.#nextIndex();
    if (index < 0) {
      for (const wake of this.#idleWaiters.splice(0)) wake();
      return;
    }
    const [job] = this.#queue.splice(index, 1) as [QueuedJob];
    this.#busy = true;
    // 一件跑壞不能讓後面的斷掉；減一兩條路都要走到。
    //
    // **減一與排程在呼叫端接到結果之前**：`#driveGoalRound` 靠 `#inFlight === 0` 判斷
    // 「沒有人在排隊」，減一之前問的話它永遠看得到自己。跑壞的那一條也走到這裡，
    // 但決策函式會看到日誌上那顆 `turn/failed` 而回 `turn-failed`——**續行不重試**；
    // 被中止的那一條同理，看到 `turn/end` 帶 aborted 而回 `turn-aborted`。
    const settle = (finish: () => void) => {
      this.#busy = false;
      this.#inFlight -= 1;
      this.#driveGoalRound();
      finish();
      this.#kick();
    };
    job.run().then(
      () => settle(job.resolve),
      (error: unknown) => settle(() => job.reject(error)),
    );
  }

  /**
   * 等到沒有能跑的、也沒在跑的。測試用。
   *
   * **停住的不算**（#629）：停在核准點、後面有說話排著的 thread 是閒著的——它在等人。
   */
  whenIdle(): Promise<void> {
    if (!this.#busy && this.#nextIndex() < 0) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  /**
   * 中止這一輪（[#276](https://github.com/DemianLi/nexus-agent/issues/276)）。**只受理、不等停穩**，
   * 照 dsh 的 `session.cancel` → `{ accepted: true }`：停下來的事實走下行與日誌。
   *
   * 三種情況，各落一種：
   *
   * - **有一輪在跑**：觸發它的中止訊號。正在跑的工具等它落定、還沒開始的不開始、模型請求中途
   *   切斷，這一步之後圖停下（`@nexus/core` 的 `turn-cancel.ts`）；這一輪收成 `turn/end` 帶 aborted。
   * - **停在核准點**：收回——排一次 {@link ThreadPump.#withdraw}（#265 的 Q7／Q15）。
   * - **閒著**：什麼都不做，同 dsh「閒著時中止不影響之後的事」。
   *
   * **排在後面的輸入不動**：停完就接著跑（#265 的 Q6，同 dsh web 的 `keepInbox`）。停在核准點時
   * 停住的那幾句也一樣：收回那一輪收掉之後照 FIFO 跑（#629）。
   *
   * @returns 這一次落在哪一種。線上只回受理，這個給測試看。
   */
  cancel(): 'run' | 'withdrawn' | 'idle' {
    const current = this.#current;
    if (current !== undefined) {
      current.controller.abort();
      return 'run';
    }
    if (this.#pending.size > 0 && !this.#closed) {
      // **同步就清**，同 `submit`：收下的那一刻就不再掛著，緊接著到的 `run.start` 不會被
      // 「停在核准點」擋回去——它排在這次收回後面。
      this.#pending.clear();
      void this.#schedule(() => this.#withdraw(), true).catch(() => {
        // 失敗已經進了日誌（`turn/failed`），這個 promise 沒有別人在等。
      });
      return 'withdrawn';
    }
    return 'idle';
  }

  /**
   * 停在核准點時按了停止：把那幾顆等核准的呼叫收回（#265 的 Q7，日誌形狀是 Q15）。
   *
   * 那時沒有 run 在跑，圍堵看不到它們，所以日誌由這裡寫：**一輪 `resume`**（人回覆了那張核准卡，
   * 回覆的內容是「停」）→ 每一顆懸著的呼叫一個 `tool/result` → `turn/end` 帶 aborted。不變量的配對
   * 成立，那顆中斷也就算答了（日誌上「答了」的樣子本來就是下一顆 `resume`）。
   *
   * 對話那一側也由這裡寫：每一顆一則 dsh 原字串的錯誤 ToolMessage。**不讓基座補**——
   * `patchToolCallsMiddleware` 補的那句說「another message came in」，成因是錯的（#265 的 Q12）。
   * **日誌的 `tool/result` 帶的就是寫進對話的那一則**（#305）：同一個實例，兩邊不會各算各的。
   */
  async #withdraw(): Promise<void> {
    const log = this.#sessions.root;
    log.append('turn/start', { kind: 'resume' });
    const started = (name: string) => name === DELEGATION_TOOL;
    let dangling: { readonly id: string; readonly name: string }[];
    try {
      const config: ThreadConfig = { configurable: { thread_id: this.#threadId } };
      dangling = danglingToolCalls((await this.#agent.getState(config)).values);
      // 碼不在訊息上標：這裡直接寫日誌，下面那顆 `tool/result` 自己帶。
      const withdrawn = dangling.map((call) =>
        toolRefusal(
          started(call.name) ? TOOL_ABORTED_REASON : TOOL_ABORTED_BEFORE_DISPATCH_REASON,
          { callId: call.id, name: call.name },
        ),
      );
      for (const [index, call] of dangling.entries()) {
        log.append('tool/result', {
          callId: call.id,
          isError: true,
          error: {
            name: 'AbortError',
            code: started(call.name) ? TOOL_ABORTED : TOOL_ABORTED_BEFORE_DISPATCH,
          },
          message: toLoggedMessage(withdrawn[index]!),
        });
      }
      if (withdrawn.length > 0) {
        await this.#agent.updateState(config, { messages: withdrawn });
      }
      log.append('turn/end', { reason: ABORTED_BY_USER });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      log.append('turn/failed', { message: failure.message });
      throw failure;
    }
    // 那幾張卡照上面寫的 `tool/result` 收（#297）。**不走日誌的訂閱者**：它只認有 run 的時候，
    // 見 `#noteVerdict`。文字就是寫進對話的那一句，模型看到的也是它。
    for (const call of dangling) {
      this.#closeCard(call.id, {
        failed: true,
        text: started(call.name) ? TOOL_ABORTED_TEXT : TOOL_ABORTED_BEFORE_DISPATCH_TEXT,
      });
    }
    // 看得到那張核准卡的每一條下行都要知道「不必再問了、這一輪停了」。這一顆是合成的：
    // 沒有 run，就沒有基座發的收尾 frame。
    this.#broadcast(
      this.#seal({
        method: 'lifecycle',
        params: {
          namespace: [],
          timestamp: Date.now(),
          data: { event: 'completed', graph_name: 'root', aborted: true },
        },
        // `aborted` 不在協定的 `LifecycleData` 裡——那正是它存在的理由，見 `#translate` 那一格。
      } as unknown as Event),
    );
  }

  /**
   * 收線。掛著的下行會正常結束，不是拋錯。
   *
   * **它同時關掉續行的準入**，而真正擋住那一輪的是 {@link ThreadPump.submit} 自己的拒絕
   * ——收線之後它一律 reject，所以一個正在 `await flush()` 的排程器塞不進東西。
   * `#driveGoalRound` 那兩處 `#closed` 是提早退出（省掉一次白算與一次 `flush()`），
   * **不是那道閘**；量過，拿掉它們行為不變。
   *
   * 「停用續行授權」那一半由 `wire-handler.ts` 的 `dispose` 走 detachSession 完成——
   * 服務跟著日誌一起從註冊表下線，而 `activation` 本來就不持久。
   */
  close(): void {
    this.#closed = true;
    this.#unobserveLogs();
    // **停住的那幾件收掉**（#629）：停在核准點、又沒有答覆排著，它們永遠等不到開跑。不收的話
    // 送出它們的 promise 永遠掛著，`running` 也永遠是真的。
    if (this.#nextIndex() < 0) {
      for (const job of this.#queue.splice(0)) {
        this.#inFlight -= 1;
        job.reject(new Error('這條 thread 已經收掉了'));
      }
      for (const wake of this.#idleWaiters.splice(0)) wake();
    }
    for (const subscriber of this.#subscribers) {
      subscriber.done = true;
      subscriber.wake?.();
    }
  }

  /**
   * 一輪落定之後，問排程器要不要再排一輪。
   *
   * **不 await**：它自己就會把排出來的那一輪丟回 {@link ThreadPump.submit}，而那條路
   * 跑完又會回到這裡。整串續行因此是一條由 `#queue` 序列化的鏈，不是一個遞迴呼叫堆。
   */
  #driveGoalRound(): void {
    const driver = this.#driver;
    if (driver === undefined || this.#closed) return;
    // **有人在排隊就讓行**，而且送出去之前還會再問一次（下面那一句）。
    //
    // **這兩道今天量不出行為差異，而且那件事要講清楚**：`#queue` 已經把所有輸入序列化
    // 了，所以排程器排出來的那一輪一定接在人那一筆後面——它搶不了先。留著它們是因為
    // 它們擋的是**多算一次**（連 `flush()` 都省下來），而且 `#queue` 那個保證一旦鬆動，
    // 這兩句就是唯一擋得住的東西。**不要把它們讀成有測試釘住的因果。**
    if (this.#inFlight > 0) return;
    void (async () => {
      try {
        const round = await driveGoalRound(() => this.#sessions.root.events, driver);
        // 再問一次：`flush()` 期間人可能已經送了東西進來。`driveGoalRound` 自己看不到
        // 排隊——它只讀日誌，而排隊中的那一筆還沒寫下任何事件——所以這是唯一看得到的地方。
        if (round === undefined || this.#closed || this.#inFlight > 0) return;
        void this.submit({ kind: 'goal', ...round }).catch(() => {
          // 那一輪自己的失敗已經進了日誌（`turn/failed`），而 `submit` 回的 promise
          // 沒有別人在等——不接住的話它是一顆 unhandled rejection，會殺掉整個行程。
        });
      } catch (error: unknown) {
        driver.warn(`排下一輪時出事：${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  }

  async #runOnce(input: PumpInput): Promise<void> {
    // **記在這裡而不是 submit 裡**：submit 只是排隊，真正開跑才是這一輪的起點。
    // 記在排隊時的話，兩件事排在一起時日誌會出現「兩個 start 之後才有第一個 end」。
    this.#sessions.root.append('turn/start', turnStartOf(input));
    // **`text` 只讀一次的那個值就是上面寫進日誌的那個。** 兩份分開算的話，一顆日誌上
    // 逐字正確的 `turn/start` 可以配上餵給模型的任意字串，而不變量伴生只看得到日誌那
    // 一份——它結構上驗不到這種偏差。所以這兩行必須共用同一個來源。
    const payload =
      input.kind === 'resume'
        ? // **逐 id 派送，不是裸值。** 鍵是那顆 `XXH3(checkpoint_ns)`，基座只把值送給
          // 那一顆 task；裸值會廣播給每一顆待決的 task（見 `PumpInput` 的 `interruptId`）。
          new Command({ resume: { [input.interruptId]: input.response } })
        : { messages: [new HumanMessage(input.text)] };

    // 一輪一個中止控制器，照 dsh（`packages/core/agent-loop/src/agent.ts:149-155`）。
    const current: CurrentRun = {
      controller: new AbortController(),
      partial: '',
      reasoning: '',
      replyOpen: false,
      stopped: false,
      maxTokens: false,
    };
    this.#current = current;
    try {
      // **取串流這一步也在 try 裡面。** 它自己就會拋（模型建不起來、憑證不對），
      // 而擺在外面的話那種失敗會留下一顆沒有結尾的 `turn/start` ——
      // 日誌上看起來像跑到一半消失，跟真的跑到一半消失分不出來。
      const run = await this.#agent.streamEvents(payload as never, {
        version: 'v3',
        configurable: {
          thread_id: this.#threadId,
          // **放在 `configurable`，不是 LangGraph 的 `signal`**：交給 LangGraph 會丟下正在跑的
          // 工具（實測），見 `@nexus/core` 的 `turn-cancel.ts`。
          [TURN_CANCEL_CONFIG_KEY]: current.controller.signal,
        },
      });
      // **在第一顆封包之前**：投影裡的 promise 一建立就可能被 reject，晚掛就漏（#346）。
      markProjectionsHandled(run);
      for await (const raw of run) {
        trackRootReply(current, raw);
        for (const event of this.#translate(raw)) {
          this.#broadcast(event);
        }
      }
      // 跑完與停在核准點都算收工——停在核准點時前面會有一顆 `interrupt/raised`。
      // **中止照上線那顆收尾 frame 判**，不是照訊號：訊號在收尾 frame 送出之後才觸發的話，
      // 畫面上是「完成」，日誌也該是。
      this.#sessions.root.append(
        'turn/end',
        current.stopped
          ? { reason: ABORTED_BY_USER }
          : current.maxTokens
            ? { reason: MAX_TOKENS_TURN_END }
            : {},
      );
    } catch (error) {
      // **認的是中止訊號已經觸發**，不是錯誤長什麼樣：被切斷的模型請求拋什麼要看供應商與抽法，
      // 而 `TurnCancelledError` 是我們自己的類別（沿 `MiddlewareError` 拆到底再認），兩個都不比對
      // 訊息（#276）。
      if (current.controller.signal.aborted || isTurnCancelled(error)) {
        await this.#keepInterruptedReply(current);
        this.#sessions.root.append('turn/end', { reason: ABORTED_BY_USER });
        return;
      }
      // 失敗的原因已經以 `lifecycle failed` 上了線（實測：失敗 frame 先發、然後才拋），
      // 所以這裡不再合成一顆。下行**不關**——這條線是長期的，下一次 submit 還要用。
      const failure = error instanceof Error ? error : new Error(String(error));
      this.#sessions.root.append('turn/failed', { message: failure.message });
      throw failure;
    } finally {
      if (this.#current === current) this.#current = undefined;
      // 一輪裡的判定在這一輪裡就落定了：圍堵在 `wrapToolCall` 回傳之前寫，而圖要等每一顆工具回傳
      // 才走得完，串流才收得了尾。剩下的是已經由日誌收掉的那幾顆（本體沒被呼叫到、或本體拋錯走
      // `tool-error` 的）與沒接日誌的組裝轉發過的，留著只佔記憶體。**哪天有一層在回傳之後才非同步
      // 寫 `tool/result`，這裡會把它的判定靜靜丟掉**，而沒有測試會紅。
      this.#forwardedFinishes.clear();
      this.#earlyVerdicts.clear();
      this.#bodyStarted.clear();
    }
  }

  /**
   * 模型講到一半被切斷：把使用者看到的那半段寫回對話，帶 {@link INTERRUPTED_REPLY_MARKER}
   * （#265 的 Q11）。一個字都沒送出就不寫——同 dsh，沒有看得見的內容就不算一則回覆。
   *
   * **推理也是看得見的內容**（#561），照 dsh 跟正文一起留（`packages/core/agent-loop/src/agent.ts:404`
   * 取 `packages/llm/llm/src/assembler.ts:169` 的 `interruptedBlocks`，`ddefc45`）：逐塊判，只有空白的
   * 那塊不留，一塊都不剩就整則不寫。所以停在推理階段的那則也會留下來，只是正文是空的。
   * - 它送回模型時是 `{"role":"assistant","content":[]}`：`ChatOpenAI` 會丟掉推理區塊。NVIDIA 閘道收這種
   *   訊息，#561 用真的 `ChatOpenAI` 量過。
   * - 一則裡的推理攤平成一塊、排在正文前面，同 `@nexus/wire` 的 `AiEntry.reasoning`（#527 登記過的偏離）。
   * - 沒有推理時 content 照舊是字串。
   *
   * **寫不進去不能把這一輪變成失敗**：人按了停止是事實，留不下半段只是少了一則訊息。
   *
   * **日誌同時記一顆 `assistant/message {interrupted: true}`**（#305），照 dsh 被中止時把已送出的
   * 前綴收成一則帶記號的回覆。先記日誌再寫對話：日誌是對話的真相，對話那一側寫不進去時，推歷史的
   * 一側照樣拿得到這半段。它落在被切斷那次呼叫的 `model/end` 之後——寫入點看到的是拋錯，不是回覆。
   */
  async #keepInterruptedReply(current: CurrentRun): Promise<void> {
    const reasoning = current.reasoning.trim() === '' ? '' : current.reasoning;
    const text = current.partial.trim() === '' ? '' : current.partial;
    if (!current.replyOpen || (reasoning === '' && text === '')) return;
    const reply = new AIMessage({
      content:
        reasoning === ''
          ? text
          : [
              { type: 'reasoning', reasoning },
              ...(text === '' ? [] : [{ type: 'text' as const, text }]),
            ],
      additional_kwargs: { [INTERRUPTED_REPLY_MARKER]: true },
    });
    try {
      this.#sessions.root.append('assistant/message', {
        message: toLoggedMessage(reply),
        interrupted: true,
      });
    } catch {
      // 同下：這一輪照樣收成中止。
    }
    try {
      await this.#agent.updateState(
        { configurable: { thread_id: this.#threadId } },
        { messages: [reply] },
      );
    } catch {
      // 見上面：這一輪照樣收成中止。
    }
  }

  /** 一顆原始封包 → 零到多顆線上的封包。 */
  *#translate(raw: RawProtocolEvent): Generator<Event> {
    if (raw.method === 'updates' && raw.params.node === '__interrupt__') {
      // 基座把中斷發在 `updates` 上（`node: "__interrupt__"`），不發協定裡的
      // `input.requested`。這裡補上那一顆——順帶讓 `updates` 整條留在白名單外，
      // 它每一顆都夾著完整序列化的訊息。
      for (const entry of asInterruptEntries(raw.params.data)) {
        // 同 id 覆寫：沒被答到的那些會帶著原本那顆 id 再度中斷（實測）。
        this.#pending.set(entry.id, {
          interruptId: entry.id,
          actionCount: actionCountOf(entry.value),
          gatedTools: gatedToolsOf(entry.value),
        });
        this.#sessions.root.append('interrupt/raised', { interruptId: entry.id });
        yield this.#seal({
          method: 'input.requested',
          params: {
            namespace: raw.params.namespace,
            timestamp: raw.params.timestamp,
            data: { interrupt_id: entry.id, payload: entry.value },
          },
        } as Event);
      }
      return;
    }

    const current = this.#current;
    if (
      current !== undefined &&
      current.controller.signal.aborted &&
      isRootTerminal(raw) &&
      // **停在核准點的那一次不標**：停止剛好撞上這一輪要停下來等核准時，讓它照常停在核准點
      // ——畫面上看得到卡片，再按一次停止就是收回。標了的話畫面會把卡片清掉，伺服器這一側卻
      // 還掛著那顆中斷，兩邊對不上。
      this.#pending.size === 0
    ) {
      // **只加分類，不改基座的欄位**，同 `classifyToolData`：協定的 `AgentStatus` 沒有「被中止」
      // 這一種（`interrupted` 是停下來等輸入），所以用一格我們自己的 `aborted` 讓畫面分得出
      // 「已停止」與「失敗」（#265 的 Q13）。
      current.stopped = true;
      yield this.#seal({
        method: raw.method,
        params: {
          namespace: raw.params.namespace,
          timestamp: raw.params.timestamp,
          data: { ...(raw.params.data as object), aborted: true },
        },
      } as Event);
      return;
    }

    if (
      current !== undefined &&
      isRootCompleted(raw) &&
      this.#pending.size === 0 &&
      turnReachedMaxTokens(this.#sessions.root.events)
    ) {
      // **撞到輸出上限（#433）一樣只加分類**，理由同上面那一格：協定的 `AgentStatus` 沒有這一種。判準讀的是
      // 這一輪記下的回覆——`assistant/message` 在模型呼叫的 middleware 裡寫，早於這顆收尾 frame。中止先判，
      // 蓋過它，同 dsh（`agent-loop/src/agent.ts:349-355`）。停在核准點的那一次不標：那一輪還沒收。
      current.maxTokens = true;
      yield this.#seal({
        method: raw.method,
        params: {
          namespace: raw.params.namespace,
          timestamp: raw.params.timestamp,
          data: { ...(raw.params.data as object), maxTokens: true },
        },
      } as Event);
      return;
    }

    if (raw.method === 'messages') {
      const invalid = invalidArgumentsOf(raw.params.data);
      if (invalid !== undefined) this.#invalidArguments.set(invalid.id, invalid.raw);
      // 圖裡注進來的 human 訊息一則都不上線，見 {@link ThreadPump.#injectedMessages}。
      if (this.#dropInjectedMessage(raw.params.data)) return;
    }
    // **圖自己發的 `custom` 不上線**：那一格只放 pump 從日誌合成的 domain 事件（見 `@nexus/wire` 的
    // `WIRE_CHANNELS`）。放行它的話，任何一顆用 `config.writer` 的工具都能往瀏覽器寫東西。
    if (raw.method === 'custom' || channelOfMethod(raw.method) === undefined) {
      return;
    }
    yield this.#seal({
      method: raw.method,
      params: {
        namespace: raw.params.namespace,
        timestamp: raw.params.timestamp,
        ...(raw.params.node === undefined ? {} : { node: raw.params.node }),
        data:
          raw.method === 'tools'
            ? this.#toolData(raw.params.namespace, raw.params.data)
            : raw.params.data,
      },
    } as Event);
  }

  /**
   * 這一顆 `messages` frame 是圖裡注進來的 human 訊息嗎——是的話整則丟掉。
   *
   * 見 {@link ThreadPump.#injectedMessages}。**`message-finish` 也丟，而且丟完才忘掉那個 `run_id`**：
   * 留著它的話 `reduceMessage` 會收到一顆對不到 entry 的收尾。
   *
   * @param data - frame 的 `params.data`。
   * @returns 要丟掉就是 `true`。
   */
  #dropInjectedMessage(data: unknown): boolean {
    const shaped = data as {
      event?: unknown;
      role?: unknown;
      run_id?: unknown;
      id?: unknown;
    } | null;
    const id = typeof shaped?.run_id === 'string' ? shaped.run_id : shaped?.id;
    if (typeof id !== 'string') return false;
    if (shaped?.event === 'message-start') {
      if (shaped.role !== 'human') return false;
      this.#injectedMessages.add(id);
      return true;
    }
    if (!this.#injectedMessages.has(id)) return false;
    if (shaped?.event === 'message-finish') this.#injectedMessages.delete(id);
    return true;
  }

  /**
   * `tools` 那一顆：先分類，再依事件補上 pump 知道的東西——`tool-finished` 套日誌的判定，
   * `tool-started` 把解不開的那顆的 `input` 換回原字串。
   */
  #toolData(namespace: readonly string[], data: unknown): unknown {
    const classified = classifyToolData(data);
    const shaped = classified as { event?: unknown; tool_call_id?: unknown } | null;
    if (typeof shaped?.tool_call_id !== 'string') return classified;
    if (shaped.event === 'tool-finished') {
      return this.#settleFinish(
        namespace,
        shaped.tool_call_id,
        classified as Record<string, unknown>,
      );
    }
    if (shaped.event !== 'tool-started') return classified;
    if (this.#current !== undefined) this.#bodyStarted.add(shaped.tool_call_id);
    // 從日誌開的卡已經帶著原字串（圍堵記的就是它），折疊器對重複的 `tool-started` 也不換 `input`；
    // 這一支留給沒接日誌、只有基座 frame 的組裝。
    const raw = this.#invalidArguments.get(shaped.tool_call_id);
    if (raw === undefined) return classified;
    this.#invalidArguments.delete(shaped.tool_call_id);
    return { ...shaped, input: raw };
  }

  /** 一顆 `tool-finished` 要轉發了：判定先到就套上；還沒到就記著，等它來了再對一次。 */
  #settleFinish(
    namespace: readonly string[],
    callId: string,
    raw: Record<string, unknown>,
  ): Record<string, unknown> {
    // **`output` 不上線**（#439）：它是序列化過的 `ToolMessage`，而且是基座搬移過的預覽——
    // 文字現在由 `message` 交出來，`output` 就只剩沒有上限的重複品，瀏覽器那側也從來沒有人讀它。
    const { output: _output, ...data } = raw;
    const verdict = this.#earlyVerdicts.get(callId);
    if (verdict !== undefined) {
      this.#earlyVerdicts.delete(callId);
      return applyVerdict(data, verdict);
    }
    if (this.#current !== undefined) this.#forwardedFinishes.set(callId, { namespace, data });
    return data;
  }

  /**
   * 日誌的訂閱者（#296、#297）。
   *
   * **這裡跑在寫日誌那一層的呼叫堆疊上**（圍堵的 `wrapToolCall`），而且在發佈期間——不能 `append`
   * （日誌的重入防護會拋），拋了也只換來一行 warn、判定就丟了。所以只動幾張表與下行的佇列。
   */
  #noteLogEvent(entry: SessionEntry, event: SessionEvent): void {
    // 會話累計（#574）：只收 root 的，同 dsh 的 `tokenUsage`／`sessionStats`；子代理是另一份日誌。值變了才送。
    if (entry.address.kind === 'root') {
      for (const data of this.#totals.apply(event)) this.#presentCustom(data);
    }
    if (event.type === 'tool/call') this.#openCard(entry.address, event.data);
    else if (event.type === 'tool/result') this.#noteVerdict(event);
    else if (event.type === 'deliverables/presented' && entry.address.kind === 'root') {
      this.#presentDeliverables(event.data, event.seq);
    } else if (event.type === 'workspace/changes' && entry.address.kind === 'root') {
      this.#presentCustom(workspaceChangesData(event.seq));
    } else if (event.type === 'model/usage' && entry.address.kind === 'root') {
      // 用量表（#528）：只收 root 的，同 dsh 的 `contextPressure`；子代理的呼叫不算進主對話的大小。
      this.#presentCustom(modelUsageData(event.data));
    } else if (event.type === 'context/measure' && entry.address.kind === 'root') {
      this.#presentCustom(contextMeasureData(event.data));
    } else if (event.type === 'todo/write' && entry.address.kind === 'root') {
      // 待辦清單（#575）：只收 root 的，同 dsh 的 `todos` 投影；子代理各寫各的那一份，不進面板。
      this.#presentCustom(todosData(event.data.todos));
    } else if (entry.address.kind === 'root' && isTodosReset(event)) {
      // 開新的一輪：清單回到 `null`。每一輪都送，不管之前有沒有清單——pump 不記清單的狀態。
      this.#presentCustom(todosData(null));
    }
  }

  /**
   * root 那一份記了一筆交付：合成一顆 `custom` frame（[#441](https://github.com/DemianLi/nexus-agent/issues/441)）。
   *
   * **只收 root 那一份**：歷史路由只讀 root（`conversation-history.ts`），子代理的交付即時送出去的話，
   * 重新整理之後就不見了。照 dsh 的所有權規則，子代理宣告的本來就歸子代理那個會話，主代理要交付得
   * 自己再叫一次 `present`。`data` 與歷史那一側共用 {@link deliverablesData}。
   */
  #presentDeliverables(presented: SessionEventMap['deliverables/presented'], seq: number): void {
    this.#presentCustom(deliverablesData(presented, seq));
  }

  /**
   * 送一顆從 root 日誌合成的 `custom` frame。一輪的改動紀錄（`workspace/changes`，
   * [#443](https://github.com/DemianLi/nexus-agent/issues/443)）也走這裡，`data` 與歷史那一側共用
   * {@link workspaceChangesData}。
   */
  #presentCustom(data: { readonly name: string; readonly payload: unknown }): void {
    this.#broadcast(
      this.#seal({
        type: 'event',
        method: 'custom',
        params: { namespace: [], timestamp: Date.now(), data },
      } as Event),
    );
  }

  /**
   * 圍堵記下一顆 `tool/call`：開卡，照 dsh 的 `rootCall`（#297）。
   *
   * **在 `handler` 之前**，所以等核准的、會被擋下的、基座找不到的都有卡；本體後來真的被呼叫到的話，
   * 基座那顆 `tool-started` 晚到，折疊器照 id 取代。`input` 是圍堵記的那一格——平常是參數物件序列化後
   * 的字串，解不開的那顆是模型吐的原字串。
   */
  #openCard(address: SessionAddress, call: SessionEventMap['tool/call']): void {
    if (this.#openCards.has(call.callId)) return;
    const namespace = cardNamespace(address);
    this.#openCards.set(call.callId, namespace);
    this.#broadcast(
      this.#seal({
        method: 'tools',
        params: {
          namespace,
          timestamp: Date.now(),
          data: {
            event: 'tool-started',
            tool_call_id: call.callId,
            tool_name: call.name,
            input: call.arguments,
          },
        },
      } as Event),
    );
  }

  /** 由 pump 自己收一張卡：合成一顆 `tool-finished`，掛在開卡時那個 namespace 上。 */
  #closeCard(callId: string, verdict: ToolVerdict): void {
    const namespace = this.#openCards.get(callId) ?? [];
    this.#openCards.delete(callId);
    this.#broadcast(
      this.#seal({
        method: 'tools',
        params: {
          namespace,
          timestamp: Date.now(),
          data: applyVerdict({ event: 'tool-finished', tool_call_id: callId }, verdict),
        },
      } as Event),
    );
  }

  /**
   * 一顆 `tool/result` 落定了：卡的終態以它為準。
   *
   * 三種情況：
   *
   * - 基座那顆 `tool-finished` **已經轉發**：跟它對一次，不同就補發一顆同 id 的更正（#296）。
   * - 基座那顆 `tool-started` 轉發過、`tool-finished` **還在路上**：記著，它來了再套上（#296）。
   * - **基座這一輪沒轉發過 `tool-started`**：本體沒被呼叫到，或它那顆還在串流上沒抽到——落定的這一刻
   *   分不出來（判定與 frame 誰先到 pump 因生產者而異）。**兩種都當場收卡**，並且照樣記著：真的晚到的
   *   `tool-started` 會把卡翻回執行中，緊接著的 `tool-finished` 再套上同一個判定，終態一樣（#297）。
   *
   * **只認這一輪裡的**：pump 自己也寫 `tool/result`（停在核准點時收回，#276），那時沒有 run，那幾張卡由
   * {@link ThreadPump.#withdraw} 就地收；在這裡記著的話，會被當成下一輪同 id 那顆的判定。
   *
   * **判定是雙向的**，照拍板「本體的 `status` 不再決定終態」：日誌說成功，本體自己標的 `failed` 也拿掉。
   * 今天樹上沒有「本體錯、日誌成功」的生產者（handler 之後改結果的只往錯誤那邊改；剪工具結果的那一層
   * 原樣帶 `status`），所以這一向目前只是對稱，沒有案例。
   */
  #noteVerdict(event: SessionEvent<'tool/result'>): void {
    if (this.#current === undefined) return;
    const { callId, isError, message, meta } = event.data;
    // 失敗的不帶由 `applyVerdict` 管（它只在成功那一支放 meta），這裡不再判一次。
    const capped = capToolResultMeta(meta, this.#toolTextMaxBytes);
    const verdict: ToolVerdict = {
      failed: isError,
      // **成功也帶文字**（#439）：dsh 的工具卡文字就是這一則的內容，`isError` 是另一個旗標。
      // 抽字的規則與重播那一條共用（`tool-result-text.ts`），兩邊不共用的話同一張卡會「即時
      // 一個樣、重新整理另一個樣」。meta 的上限同理。
      text: toolResultText(message, this.#toolTextMaxBytes),
      ...(capped === undefined ? {} : { meta: capped }),
    };
    const forwarded = this.#forwardedFinishes.get(callId);
    if (forwarded === undefined) {
      this.#earlyVerdicts.set(callId, verdict);
      if (this.#bodyStarted.has(callId)) this.#openCards.delete(callId);
      else this.#closeCard(callId, verdict);
      return;
    }
    this.#openCards.delete(callId);
    this.#forwardedFinishes.delete(callId);
    const settled = applyVerdict(forwarded.data, verdict);
    // **meta 也要比**（#617）：基座那顆從來不帶 meta，只差這一格的時候不補發，卡就永遠拿不到它。
    if (
      settled.failed === forwarded.data.failed &&
      settled.message === forwarded.data.message &&
      settled.meta === forwarded.data.meta
    ) {
      return;
    }
    // 同一個 `tool_call_id` 的第二顆 `tool-finished`：折疊器照 id 換掉那一格，帶著原本的 `output`。
    this.#broadcast(
      this.#seal({
        method: 'tools',
        params: { namespace: forwarded.namespace, timestamp: Date.now(), data: settled },
      } as Event),
    );
  }

  /** 蓋上這條 thread 自己的編號——**不是 run 的 `seq`**，那個每個 run 都從 0 重來。 */
  #seal(event: Event): Event {
    const seq = this.#seq++;
    return { ...event, type: 'event', seq, event_id: eventId(this.#threadId, seq) };
  }

  #broadcast(event: Event): void {
    const channel = channelOfMethod(event.method);
    for (const subscriber of this.#subscribers) {
      if (subscriber.done || channel === undefined || !subscriber.channels.includes(channel)) {
        continue;
      }
      subscriber.queue.push(event);
      subscriber.wake?.();
    }
  }
}

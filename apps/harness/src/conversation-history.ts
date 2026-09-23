/**
 * 一條 thread 的歷史，照日誌轉成畫面折得動的 frame（[#306](https://github.com/DemianLi/nexus-agent/issues/306)
 * 的畫面那一刀）。線上的形狀與分頁規則見 `@nexus/wire` 的 `historyPath`。
 *
 * ## 畫面照日誌事件折，不照推回模型的那一串
 *
 * `@nexus/core` 的 `replayConversation` 推的是**模型看得到的**：壓縮過就是摘要加之後的、沒配到結果的呼叫補一則
 * 合成的錯誤、格式 9 以前的日誌整串推不出來。畫面要的是**發生過什麼**——壓縮前那一段照樣在、合成的那則不是真的
 * 結果、舊日誌照樣有人打的字與工具卡。所以兩側共用的是**哪一種事件代表什麼**，不是同一個函式；照 dsh：模型那側是
 * `Session.deriveMessages()`，畫面那側是 client 的 `ConversationNodeAssembler` 逐顆認日誌事件，兩者本來就分開。
 *
 * | 日誌事件 | 畫面 |
 * | --- | --- |
 * | `turn/start`（`message`） | 人打的字（`message-start` `role: "human"`） |
 * | `turn/start`（任何一種） | `lifecycle running` |
 * | `assistant/message` | 模型的回覆，連同推理（#527）；`interrupted` 的那則不收尾，由那一輪的中止標成「已停止」 |
 * | `tool/call` ／ `tool/result` | 工具卡開、收；那則結果的文字成功失敗都帶（成功是輸出、失敗是紅字，[#439](https://github.com/DemianLi/nexus-agent/issues/439)） |
 * | `turn/end` ／ `turn/failed` | 那一輪收掉（中止、失敗、完成）；沒結果的卡照即時那條規則收成失敗 |
 * | `session/end-seed` | 上一個行程停在一輪中間的話，那一輪在這裡收掉 |
 * | `deliverables/presented` | `custom` frame，`data` 同即時（{@link deliverablesData}） |
 * | `workspace/changes` | `custom` frame，`data` 同即時（{@link workspaceChangesData}）；它指到的摘要可能已經不在 |
 * | `model/usage` ／ `context/measure` | 用量表（#528）：**一頁各一顆，是到這一頁結尾為止最新的那一筆**，`data` 同即時（{@link modelUsageData}、{@link contextMeasureData}） |
 *
 * | `todo/write` ／ `turn/start` | 待辦清單（#575）：**一頁一顆，是這一頁結尾時的清單**，是 `null` 就不送；`data` 同即時（{@link todosData}） |
 *
 * 用量表那兩種不是逐顆轉：web 只留最新那一筆，逐顆轉只會多出一串馬上被蓋掉的 frame。「到這一頁結尾為止」包括這一頁
 * 開頭之前的——最後一輪在第一次模型呼叫之前就失敗的話，這一頁自己沒有那兩種事件，而即時的畫面上用量表還在。見
 * {@link historyPage}。
 *
 * 其餘的（壓縮、外掛注入的 `user/message`、模型起訖、命令、模式、目標、回饋）即時的畫面也不畫，這裡也不畫。
 * **壓縮不畫是偏離**：dsh 的畫面由那顆 `user/message {surfaceOp: replace}` 把被壓掉的那一段換成摘要；我們沒有
 * surface 那一軸，即時的畫面從來沒換過，歷史跟著即時。
 *
 * ## 目標排的輪次不畫那一串字
 *
 * 即時的畫面只畫人送出去的那句（`appendHumanTurn`），目標排的那一輪的指示沒有人打過，畫面上沒有它。歷史照即時。
 */

import type {
  DeliverablesPresentedPayload,
  Event,
  ModelUsagePayload,
  TodosPayload,
  ThreadHistoryQuery,
  ThreadHistoryResult,
  WireContextMeasure,
  WorkspaceChangesPayload,
} from '@nexus/wire';
import {
  CONTEXT_MEASURE,
  DELIVERABLES_PRESENTED,
  HISTORY_PAGE_MAX_BYTES,
  HISTORY_PAGE_MESSAGES,
  MODEL_USAGE,
  TODOS,
  WORKSPACE_CHANGES,
} from '@nexus/wire';
import type { LoggedMessage, SessionEvent, SessionEventMap, UnreplayableReason } from '@nexus/core';
import { loggedMessageId, replayConversation } from '@nexus/core';

import { toolResultText } from './tool-result-text.js';
import { toolTextConfigSchema } from './settings/tool-text.js';
import type { ToolTextConfig } from './settings/tool-text.js';

/** 推不回模型的原因裡，說的是「這份日誌是格式 9 以前寫的」的那幾種。見 {@link historyPage}。 */
const LEGACY_REASONS: ReadonlySet<UnreplayableReason> = new Set([
  'reply-missing',
  'result-missing',
  'summary-missing',
]);

/** 參數不合規時拋的錯。wire 那側據它回 `invalid_argument`，不是 `unknown_error`。 */
export class HistoryQueryError extends Error {}

/** 一則訊息的文字：字串照原樣，區塊只取 `text` 那幾塊（推理另走 {@link reasoningOf}）。 */
function textOf(message: LoggedMessage | undefined): string {
  const content: unknown = message?.data.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block: unknown) => {
      const typed = block as { type?: unknown; text?: unknown } | null;
      return typed?.type === 'text' && typeof typed.text === 'string' ? typed.text : '';
    })
    .join('');
}

/**
 * 一則訊息的推理（[#527](https://github.com/DemianLi/nexus-agent/issues/527)）：content 陣列裡 `reasoning`
 * 那幾塊，照順序接起來。
 *
 * **只讀 content 區塊，不讀 `additional_kwargs.reasoning_content`**：即時那條看得到的是串流翻出來的
 * `reasoning-delta`，而串流那條落盤時推理就在 content 裡（標準區塊，`output_version: v1`）。非串流的
 * 那條（CLI 的 `_generate`）把推理放在 `additional_kwargs`，而那種日誌即時那條本來就沒畫過——
 * 讀了它，重新整理會比即時多出東西。`fromLoggedMessage` 還原後的 `contentBlocks` 也不會把
 * `additional_kwargs` 那一格翻成區塊（實測），所以兩條路本來就分得開。
 */
function reasoningOf(message: LoggedMessage | undefined): string {
  const content: unknown = message?.data.content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block: unknown) => {
      const typed = block as { type?: unknown; reasoning?: unknown } | null;
      return typed?.type === 'reasoning' && typeof typed.reasoning === 'string'
        ? typed.reasoning
        : '';
    })
    .join('');
}

/** 畫面上算一則的：人打的字、模型的回覆。分頁以它計數，同 dsh 以 `user/message`／`assistant/message` 計。 */
function isMessage(event: SessionEvent): boolean {
  return (
    (event.type === 'turn/start' && event.data.kind === 'message') ||
    event.type === 'assistant/message'
  );
}

/**
 * 一頁可以從這裡開始：一輪的開頭，**而且不是 `resume`**——`resume` 那一輪接著上一輪停在核准點的那幾顆呼叫
 * （同一個 `callId` 再記一次 `tool/call`），從它切的話同一張卡會一半在這頁、一半在前一頁，接起來畫面上長兩張。
 */
function isPageStart(event: SessionEvent): boolean {
  return event.type === 'turn/start' && event.data.kind !== 'resume';
}

/**
 * **不帶 `seq`**。帶了的話之後的即時 frame 全被當成重複丟掉，見 `@nexus/wire` 的 `historyPath`。namespace 一律
 * 是 root：讀的是 root 那份日誌，子代理的在它自己那份（列表也不列子代理，#302 決定 3）。
 */
function frame(method: string, time: number, data: Record<string, unknown>): Event {
  return { type: 'event', method, params: { namespace: [], timestamp: time, data } } as Event;
}

/**
 * 一筆交付在線上的 `custom` 事件 `data`。**即時（pump）與這裡共用這一個**，兩條路才產得出同一種 frame
 * （[#441](https://github.com/DemianLi/nexus-agent/issues/441)）。只收 root 那一份的：呼叫端自己篩。
 * **`seq` 是那顆事件在 root 日誌裡的位置**（[#452](https://github.com/DemianLi/nexus-agent/issues/452)）：
 * 配上檔案在 `files` 裡的位置，`(seq, index)` 就是讀檔路由的座標。同 {@link workspaceChangesData}——
 * 兩條 `custom` frame 用的是同一份日誌上的同一種座標。
 *
 * **兩條路各自傳 `seq` 進來，不從 `presented` 裡拿**：酬載是 plugin 寫的，`seq` 是日誌 append 當下
 * 才決定的，寫的人手上還沒有它。
 *
 * @param presented - 日誌裡那一顆的酬載。
 * @param seq - 那顆 `deliverables/presented` 的 `seq`。
 * @returns `{ name, payload }`，形狀見 `@nexus/wire` 的 `DeliverablesPresentedPayload`。
 */
export function deliverablesData(
  presented: SessionEventMap['deliverables/presented'],
  seq: number,
): {
  readonly name: typeof DELIVERABLES_PRESENTED;
  readonly payload: DeliverablesPresentedPayload;
} {
  const payload: DeliverablesPresentedPayload = {
    callId: presented.callId,
    seq,
    files: presented.files.map((file) => ({ ...file })),
  };
  return { name: DELIVERABLES_PRESENTED, payload };
}

/**
 * 一輪的改動紀錄在線上的 `custom` 事件 `data`（[#443](https://github.com/DemianLi/nexus-agent/issues/443)）。
 * 即時與這裡共用這一個，同 {@link deliverablesData}。**`seq` 是那顆事件在 root 日誌裡的位置**，web 拿它去
 * `changes/summary` 要摘要；從日誌重播出來的那幾顆，摘要多半已經不在了（只活到會話結束），路由回 404。
 * @param seq - 那顆 `workspace/changes` 的 `seq`。
 * @returns `{ name, payload }`，形狀見 `@nexus/wire` 的 `WorkspaceChangesPayload`。
 */
export function workspaceChangesData(seq: number): {
  readonly name: typeof WORKSPACE_CHANGES;
  readonly payload: WorkspaceChangesPayload;
} {
  return { name: WORKSPACE_CHANGES, payload: { seq } };
}

/**
 * root 一次模型呼叫報回的用量在線上的 `custom` 事件 `data`（[#528](https://github.com/DemianLi/nexus-agent/issues/528)）。
 * 即時與這裡共用，同 {@link deliverablesData}。**只送 `inputTokens`**：用量表只顯示「目前多大」，
 * 累計燒了多少是 #574 的事。
 *
 * @param usage - 日誌裡那一顆 `model/usage` 的酬載。
 * @returns `{ name, payload }`，形狀見 `@nexus/wire` 的 `ModelUsagePayload`。
 */
export function modelUsageData(usage: SessionEventMap['model/usage']): {
  readonly name: typeof MODEL_USAGE;
  readonly payload: ModelUsagePayload;
} {
  return { name: MODEL_USAGE, payload: { inputTokens: usage.inputTokens } };
}

/**
 * 摘要器量到的 root 一次模型呼叫在線上的 `custom` 事件 `data`（#528）。即時與這裡共用，同 {@link deliverablesData}。
 *
 * @param measure - 日誌裡那一顆 `context/measure` 的酬載。
 * @returns `{ name, payload }`，形狀見 `@nexus/wire` 的 `WireContextMeasure`。
 */
export function contextMeasureData(measure: SessionEventMap['context/measure']): {
  readonly name: typeof CONTEXT_MEASURE;
  readonly payload: WireContextMeasure;
} {
  return {
    name: CONTEXT_MEASURE,
    payload: {
      approxTokens: measure.approxTokens,
      messageCount: measure.messageCount,
      thresholds: measure.thresholds.map(({ type, value }) => ({ type, value })),
    },
  };
}

/**
 * root 的待辦清單在線上的 `custom` 事件 `data`（[#575](https://github.com/DemianLi/nexus-agent/issues/575)）：投影的
 * 整個值。即時與這裡共用，同 {@link deliverablesData}。規則見 `@nexus/wire` 的 `todos.ts`。
 *
 * @param todos - 整份清單，或 `null`（一輪剛開始）。
 * @returns `{ name, payload }`，形狀見 `@nexus/wire` 的 `TodosPayload`。
 */
export function todosData(todos: SessionEventMap['todo/write']['todos'] | null): {
  readonly name: typeof TODOS;
  readonly payload: TodosPayload;
} {
  return {
    name: TODOS,
    payload: {
      todos: todos === null ? null : todos.map(({ content, status }) => ({ content, status })),
    },
  };
}

/**
 * 這一顆會不會把待辦清單清成 `null`：開新的一輪，也就是不是 `resume` 的 `turn/start`（照 dsh 的 `todos` 投影）。
 * 「一輪開始」為什麼不含 `resume` 見 `@nexus/wire` 的 `todos.ts`。即時（pump）與這裡共用這一條。
 *
 * @param event - root 日誌的一顆事件。
 * @returns 會清空就是 `true`。
 */
export function isTodosReset(event: SessionEvent): boolean {
  return event.type === 'turn/start' && event.data.kind !== 'resume';
}

/** 用量表那兩種事件。見檔頭。 */
type PressureEvent = Extract<SessionEvent, { type: 'model/usage' | 'context/measure' }>;

/**
 * 一段日誌裡兩種用量表事件各自最新的那一顆，照日誌的順序。
 *
 * @param events - 要找的那一段。
 * @returns 零到兩顆。
 */
function latestPressureEvents(events: readonly SessionEvent[]): PressureEvent[] {
  let usage: PressureEvent | undefined;
  let measure: PressureEvent | undefined;
  for (
    let at = events.length - 1;
    at >= 0 && (usage === undefined || measure === undefined);
    at -= 1
  ) {
    const event = events[at]!;
    if (event.type === 'model/usage') usage ??= event;
    else if (event.type === 'context/measure') measure ??= event;
  }
  return [usage, measure]
    .filter((event): event is PressureEvent => event !== undefined)
    .sort((a, b) => a.seq - b.seq);
}

function pressureFrame(event: PressureEvent): Event {
  return frame(
    'custom',
    event.time,
    event.type === 'model/usage' ? modelUsageData(event.data) : contextMeasureData(event.data),
  );
}

function lifecycle(time: number, data: Record<string, unknown>): Event {
  return frame('lifecycle', time, { graph_name: 'root', ...data });
}

/**
 * 一則完整的訊息。`open` 的那則不送 `message-finish`，留給那一輪的收尾去標。
 *
 * **回覆的形狀同即時**（[#382](https://github.com/DemianLi/nexus-agent/issues/382)）：entry 的 key 放
 * `run_id`（`history-<seq>`），`message-start` 的 `id` 放日誌記的訊息 id——畫面據它評分，同即時那則的
 * `id`。日誌沒記 id 的就不帶，那則評不了。人那一則照舊只帶 `id`：它不是評分的目標。
 *
 * **推理（[#527](https://github.com/DemianLi/nexus-agent/issues/527)）也是同即時的形狀**：一顆
 * `reasoning-delta`，欄位叫 `reasoning`，不是 `text`。有推理才送，送在正文之前。
 */
function message(
  time: number,
  role: 'human' | 'ai',
  key: string,
  text: string,
  open = false,
  messageId?: string,
  reasoning = '',
): Event[] {
  const ids = role === 'ai' ? { run_id: key } : { id: key };
  return [
    frame('messages', time, {
      event: 'message-start',
      role,
      ...ids,
      ...(messageId !== undefined && { id: messageId }),
    }),
    ...(reasoning === ''
      ? []
      : [
          frame('messages', time, {
            event: 'content-block-delta',
            index: 1,
            delta: { type: 'reasoning-delta', reasoning },
            ...ids,
          }),
        ]),
    frame('messages', time, {
      event: 'content-block-delta',
      index: 0,
      delta: { type: 'text-delta', text },
      ...ids,
    }),
    ...(open ? [] : [frame('messages', time, { event: 'message-finish', reason: 'stop', ...ids })]),
  ];
}

/**
 * 這條 thread 現在還掛著中斷——同一個行程裡切回來。只有 pump 知道，見 `ThreadPump.pendings`。
 */
export interface AwaitingInput {
  /** 停在核准閘門上的工具名，所有掛著的中斷合起來。見 {@link historyFrames}。 */
  readonly gatedTools: ReadonlySet<string>;
}

/**
 * 一段日誌轉成 frame。
 *
 * ## 停下來等人的那一輪：兩種等法畫法不同，同即時
 *
 * 即時那條只把**本體拋了中斷**的那顆畫成「等你回答」（`thread-pump.ts` 的 `classifyToolData`）：問答。子代理照 dsh
 * 不停下來等人（#324），所以 `task` 不會停在這裡。停在核准閘門上的那顆本體沒被呼叫到，卡從日誌 `tool/call` 開，
 * 一直是「執行中」——照 dsh：它的工具卡沒有「等人」那一格，核准的等待由接管輸入框的核准面板表示（#317）。
 *
 * 日誌分不出這兩種：都只留一顆沒落定的 `tool/call` 與一顆只帶 id 的 `interrupt/raised`。分得出來的是 pump 手上
 * 掛著的酬載，所以由它交進來 {@link AwaitingInput.gatedTools}：名字在裡面的維持執行中，其餘的畫成「等你回答」。
 * **認的是名字不是 callId**（閘門的酬載沒有 callId）：同一輪一顆同名的工具停在閘門、另一顆由本體拋了中斷，
 * 後者會被畫成執行中。今天的產品路徑走不到——本體會拋中斷的只有問答，它不過閘門。
 *
 * @param events - 從一輪的開頭切下來的一段（見 {@link isPageStart}）。
 * @param awaitingInput - 有給就是這一段的最後一輪停下來等人，**而且這條 thread 現在還掛著那幾顆中斷**。那幾張卡
 *   照上面分兩種畫，都不收掉；卡本身（核准的按鈕）補不回來——中斷的酬載只在發出去的那一顆 frame 上。行程重開過的話
 *   中斷已經不在了（它在 checkpointer 裡），那幾張照即時那條規則收成失敗。
 */
export function historyFrames(
  events: readonly SessionEvent[],
  toolTextMaxBytes: number,
  awaitingInput?: AwaitingInput,
): Event[] {
  const frames: Event[] = [];
  let turnOpen = false;
  let interrupted = false;
  /**
   * 上一輪停在中斷上收了尾（`turn/end`），還不知道下一步是續接還是另起一輪。**先不收**：續接的話是同一輪，
   * 即時那條上它也沒收過（停在核准點不是收尾），畫面的「一輪收尾那則」才對得上即時（#382）。
   */
  let suspended = false;
  /** 這一輪記了 `tool/call`、還沒有 `tool/result` 的：callId → 工具名。 */
  const unsettled = new Map<string, string>();
  const last = events.at(-1);
  /**
   * 這一段結尾時的待辦清單（#575）。**從 `null` 起算不用往前補**：一頁一定從 seq 0 或一顆不是 `resume` 的
   * `turn/start` 開始（`historyPage` 在輪邊界上切），而那一顆本來就會把它清成 `null`。
   */
  let todos: {
    readonly time: number;
    readonly list: SessionEventMap['todo/write']['todos'];
  } | null = null;

  const close = (time: number, data: Record<string, unknown>) => {
    frames.push(lifecycle(time, data));
    turnOpen = false;
    interrupted = false;
    suspended = false;
    unsettled.clear();
  };

  for (const event of events) {
    if (isTodosReset(event)) todos = null;
    else if (event.type === 'todo/write') todos = { time: event.time, list: event.data.todos };
    switch (event.type) {
      case 'turn/start':
        if (suspended && event.data.kind === 'resume') {
          // 續接：同一輪接著跑。那幾張卡照舊開著，等這一輪的 `tool/call` 再記一次、`tool/result` 收掉。
          suspended = false;
          interrupted = false;
          turnOpen = true;
          break;
        }
        if (turnOpen || suspended) close(event.time, { event: 'completed' });
        frames.push(lifecycle(event.time, { event: 'running' }));
        turnOpen = true;
        if (event.data.kind === 'message') {
          frames.push(...message(event.time, 'human', `history-${event.seq}`, event.data.text));
        }
        break;
      case 'assistant/message': {
        const text = textOf(event.data.message);
        const reasoning = reasoningOf(event.data.message);
        // 只帶工具呼叫的那一次沒有字可畫。即時的畫面那時會長一則空的，歷史不跟著長。**只有推理的那一次
        // 有東西可畫**（#527）：模型只想、只呼叫工具的那幾步，即時那則帶著推理，歷史也要有。
        if (text !== '' || reasoning !== '') {
          frames.push(
            ...message(
              event.time,
              'ai',
              `history-${event.seq}`,
              text,
              event.data.interrupted,
              loggedMessageId(event.data.message),
              reasoning,
            ),
          );
        }
        break;
      }
      case 'tool/call':
        unsettled.set(event.data.callId, event.data.name);
        frames.push(
          frame('tools', event.time, {
            event: 'tool-started',
            tool_call_id: event.data.callId,
            tool_name: event.data.name,
            input: event.data.arguments,
          }),
        );
        break;
      case 'tool/result': {
        unsettled.delete(event.data.callId);
        // **成功也帶文字**（#439）：抽字的規則與即時那條共用（`tool-result-text.ts`），
        // 兩邊各寫一份的話，同一張卡會「即時一個樣、重新整理另一個樣」。
        const text = toolResultText(event.data.message, toolTextMaxBytes);
        // 格式 9 以前沒有 `message`：失敗的那張只剩錯誤碼可講，碼也沒有就交給折疊器說「未指名的錯誤」。
        const reason = text ?? (event.data.isError ? event.data.error?.code : undefined);
        frames.push(
          frame('tools', event.time, {
            event: 'tool-finished',
            tool_call_id: event.data.callId,
            failed: event.data.isError,
            ...(reason !== undefined ? { message: reason } : {}),
          }),
        );
        break;
      }
      case 'deliverables/presented':
        // 這裡讀的本來就只有 root 那一份，子代理的交付不在裡面——同即時那條規則。
        frames.push(frame('custom', event.time, deliverablesData(event.data, event.seq)));
        break;
      case 'workspace/changes':
        // 同上：只讀 root 那一份，而記錄器本來就只寫在 root。
        frames.push(frame('custom', event.time, workspaceChangesData(event.seq)));
        break;
      case 'interrupt/raised':
        interrupted = true;
        break;
      case 'turn/end':
        if (event.data.reason?.kind === 'aborted') {
          close(event.time, { event: 'failed', aborted: true });
        } else if (interrupted) {
          turnOpen = false;
          suspended = true;
        } else {
          close(event.time, { event: 'completed' });
        }
        break;
      case 'turn/failed':
        close(event.time, { event: 'failed', error: event.data.message });
        break;
      case 'session/end-seed':
        // 上一個行程死在一輪中間：那一輪沒有收尾，在這裡收，同 dsh 冷讀時補的合成收尾。
        if (turnOpen || suspended) close(event.time, { event: 'completed' });
        break;
      default:
        break;
    }
  }
  if (suspended && last !== undefined) {
    if (awaitingInput === undefined) {
      // 停在中斷上、之後沒有續接，而這條 thread 現在也沒掛著它（行程重開過，或這一頁不是最後一頁）：收掉。
      close(last.time, { event: 'completed' });
    } else {
      for (const [callId, name] of unsettled) {
        // 停在閘門上的那顆不發：`tool-started` 開的卡本來就是執行中，同即時。
        if (awaitingInput.gatedTools.has(name)) continue;
        frames.push(frame('tools', last.time, { event: 'tool-suspended', tool_call_id: callId }));
      }
      // 不收：那一輪在 server 上還停在那裡，畫面停在忙著，「停止」就是收回那幾顆（#265 的 Q7）。
    }
  }
  // 用量表：這一段裡各自最新的那一顆，放在最後——web 只留最新那一筆，放哪裡都一樣，放最後讀起來就是「到結尾為止」。
  frames.push(...latestPressureEvents(events).map(pressureFrame));
  if (todos !== null) frames.push(frame('custom', todos.time, todosData(todos.list)));
  return frames;
}

function checkIndex(name: string, value: number | undefined, minimum: number): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < minimum)) {
    throw new HistoryQueryError(`${name} 要是不小於 ${minimum} 的整數，收到 ${String(value)}`);
  }
}

/** 一段折出來的 frame 在線上有多重。判準是**序列化之後**的位元組，見 {@link fitBytes}。 */
function weigh(
  segment: readonly SessionEvent[],
  toolTextMaxBytes: number,
  awaitingInput?: AwaitingInput,
): number {
  return Buffer.byteLength(
    JSON.stringify(historyFrames(segment, toolTextMaxBytes, awaitingInput)),
    'utf8',
  );
}

/**
 * 把切點往後推到這一頁不超過 {@link HISTORY_PAGE_MAX_BYTES}（[#479](https://github.com/DemianLi/nexus-agent/issues/479)）。
 *
 * ## 只在輪邊界上推，而且**至少留一整輪**
 *
 * 位元組上限是軟的：輪邊界那條保證比它強（見 `@nexus/wire` 的 `ThreadHistoryResult.events`）。所以這裡
 * 走的是 `[messageCut, end)` 裡的 `isPageStart` 位置，從最後一段往回收，**最後那一段無條件收下**——
 * 於是「一頁至少一整輪」不是另外寫的一條保底規則，是這個迴圈的形狀本身；`firstSeq` 因此嚴格遞減，
 * 客戶端拿著同一個 `beforeSeq` 永遠不會原地打轉。
 *
 * ## 為什麼秤序列化後的，而不是把各段內容長度相加
 *
 * 相加會漏掉骨架。合成日誌量過（2026-09-20）：25 輪純對話的工具內容是 0，而線上是 31 KB——小頁整個量錯。
 * 內容一大時兩者才趨近（wire ≈ content × 1.01）。
 *
 * ## 這樣秤付得起嗎：量過才寫
 *
 * 每一段只序列化一次（O(n)），不是每個候選切點把整段重秤一次（O(n²)）。代價是累加值與「整段一次序列化」
 * 不完全相等——`historyFrames` 是有狀態的走訪器。實測三種跨量級的形狀（25 輪純對話／每輪 3 次小讀／
 * 每輪 10 次滿版讀）差的都是 **24 bytes，固定值、而且是高估**。高估的方向是安全的：拿它當判準只會讓頁
 * 略小，不會讓真的送出去的超過上限。
 *
 * **#528 之後那個「固定 24」不成立了，方向仍是高估**：用量表的 frame 每一段各送一份（那一段最新的兩顆），
 * 整頁只送一份，所以段數越多多估越多——每段最多兩顆、各一兩百位元組，量級跟 24 同一檔。反方向的那兩顆
 * （從切點之前補的，見 {@link historyPage}）不在這裡秤，由呼叫端加進撐破上限的判斷。
 *
 * @param window - `throughSeq` 以內的日誌。
 * @param messageCut - 則數上限算出來的切點，已經退到輪邊界。
 * @param end - 這一頁的結束位置（不含）。
 * @param awaitingInput - 最後一頁才有；秤最後一段時要帶上它。
 * @returns 新的切點（一定 `>= messageCut`），與秤到的位元組。**位元組一起回**是為了讓呼叫端不必為了
 *   知道這一頁多重而把整頁再序列化一次——一頁 12 MiB 的話那是實打實的第二次。
 */
function fitBytes(
  window: readonly SessionEvent[],
  messageCut: number,
  end: number,
  toolTextMaxBytes: number,
  awaitingInput?: AwaitingInput,
): { readonly cut: number; readonly bytes: number } {
  const starts: number[] = [];
  for (let at = messageCut; at < end; at += 1) {
    if (at === messageCut || isPageStart(window[at]!)) starts.push(at);
  }
  // 窗口裡一個輪邊界都沒有（整段是個片段）：沒有推得動的地方。
  if (starts.length === 0) {
    return {
      cut: messageCut,
      bytes: weigh(window.slice(messageCut, end), toolTextMaxBytes, awaitingInput),
    };
  }

  // **最後那一整輪無條件收下**，而且是在迴圈外收的——「一頁至少一整輪」就住在這兩行裡，不是迴圈裡一個
  // 可以被拿掉的條件。往回延伸的那幾段才問上限。
  const lastStart = starts[starts.length - 1]!;
  let cut = lastStart;
  let bytes = weigh(window.slice(lastStart, end), toolTextMaxBytes, awaitingInput);
  for (let i = starts.length - 2; i >= 0; i -= 1) {
    const from = starts[i]!;
    const size = weigh(window.slice(from, starts[i + 1]!), toolTextMaxBytes);
    if (bytes + size > HISTORY_PAGE_MAX_BYTES) break;
    bytes += size;
    cut = from;
  }
  return { cut, bytes };
}

/**
 * 一頁歷史。
 *
 * @param events - 這條 thread 的 root 日誌，全部。
 * @param query - 省略就是最後 {@link HISTORY_PAGE_MESSAGES} 則。
 * @param awaitingInput - 有給就是這條 thread 現在停下來等人。只作用在最後一頁，見 {@link historyFrames}。
 * @param onOversize - 這一頁撐破了 {@link HISTORY_PAGE_MAX_BYTES} 時叫一次，帶秤到的位元組。單獨一輪就
 *   超標時會發生（輪邊界比上限強，見 {@link fitBytes}），而那件事在線上一點痕跡都沒有。
 * @throws {@link HistoryQueryError} 參數不合規，或 `beforeSeq` 超出 `throughSeq` 之後。
 */
export function historyPage(
  events: readonly SessionEvent[],
  query: ThreadHistoryQuery = {},
  awaitingInput?: AwaitingInput,
  onOversize?: (bytes: number) => void,
  toolText?: ToolTextConfig,
): ThreadHistoryResult {
  // **這是這條路上唯一的退路**：呼叫端沒講就用 schema 的預設，同 `createWireHandler` 對
  // `deliverableLimits` 的做法（#536）。底下每一層都是必填轉發，所以「忘了傳」不會變成
  // 一個安靜的預設值。
  const toolTextMaxBytes = (toolText ?? toolTextConfigSchema.parse({})).maxBytes;
  const maxMessages = query.maxMessages ?? HISTORY_PAGE_MESSAGES;
  checkIndex('maxMessages', maxMessages, 1);
  checkIndex('beforeSeq', query.beforeSeq, 0);
  checkIndex('throughSeq', query.throughSeq, -1);
  const throughSeq = Math.min(query.throughSeq ?? events.length - 1, events.length - 1);
  const window = events.slice(0, throughSeq + 1);
  const end = query.beforeSeq ?? window.length;
  if (end > window.length) {
    throw new HistoryQueryError(`beforeSeq ${end} 在 throughSeq ${throughSeq} 之後`);
  }

  let cut = 0;
  let counted = 0;
  for (let at = end - 1; at >= 0; at -= 1) {
    if (!isMessage(window[at]!)) continue;
    counted += 1;
    if (counted < maxMessages) continue;
    cut = at;
    // 退到那一輪的開頭，一輪不拆兩頁。
    while (cut > 0 && !isPageStart(window[cut]!)) cut -= 1;
    break;
  }

  // **`awaitingInput` 只作用在最後一頁**，而它會多出 `tool-suspended` 那幾顆 frame。秤重時要用真的那一份，
  // 否則最後一段會被低估，而低估的方向正好是「真的送出去的比上限大」。
  const tail = end === events.length ? awaitingInput : undefined;
  const fitted = fitBytes(window, cut, end, toolTextMaxBytes, tail);
  cut = fitted.cut;
  // 用量表要「到這一頁結尾為止」最新的那一筆（見檔頭）：切點之前各自最新的那一顆補在最前面，`historyFrames` 只送
  // 最新的，這一頁自己有的就輪不到它。**切點不為它們讓位**（最多兩顆、各一兩百位元組），但撐破上限的判斷要算進去
  // ——那是低估的方向，正好是會讓送出去的超過上限的那一邊。
  const carried = latestPressureEvents(window.slice(0, cut));
  const bytes = fitted.bytes + (carried.length === 0 ? 0 : weigh(carried, toolTextMaxBytes));
  // 軟上限撐破了。**沒有人講的話這件事在線上完全看不見**——回應照樣是 200、畫面照樣對。
  if (bytes > HISTORY_PAGE_MAX_BYTES) onOversize?.(bytes);

  const replay = replayConversation(events);
  return {
    // **三種原因都是舊格式**：回覆、結果內容、摘要本文都是格式 9 才開始記的（#305），缺哪一樣都只可能出自 9 以前
    // 寫的那一段；哪一種先被撞到看的是日誌的順序（格式 8 的一輪，沒內容的結果落在收尾之前）。只認「沒有回覆」的話，
    // 真的 v8 日誌會被判成不是舊格式。切點對不上不算：畫面上不缺東西。
    events: historyFrames(
      [...carried, ...window.slice(cut, end)],
      toolTextMaxBytes,
      end === events.length ? awaitingInput : undefined,
    ),
    firstSeq: cut,
    throughSeq,
    hasMore: window.slice(0, cut).some(isMessage),
    legacy: replay.kind === 'unreplayable' && LEGACY_REASONS.has(replay.reason),
  };
}

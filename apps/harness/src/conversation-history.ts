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
 * | `assistant/message` | 模型的回覆；`interrupted` 的那則不收尾，由那一輪的中止標成「已停止」 |
 * | `tool/call` ／ `tool/result` | 工具卡開、收；那則結果的文字成功失敗都帶（成功是輸出、失敗是紅字，[#439](https://github.com/DemianLi/nexus-agent/issues/439)） |
 * | `turn/end` ／ `turn/failed` | 那一輪收掉（中止、失敗、完成）；沒結果的卡照即時那條規則收成失敗 |
 * | `session/end-seed` | 上一個行程停在一輪中間的話，那一輪在這裡收掉 |
 * | `deliverables/presented` | `custom` frame，`data` 同即時（{@link deliverablesData}） |
 * | `workspace/changes` | `custom` frame，`data` 同即時（{@link workspaceChangesData}）；它指到的摘要可能已經不在 |
 *
 * 其餘的（壓縮、外掛注入的 `user/message`、模型起訖、命令、模式、目標、todo、回饋）即時的畫面也不畫，這裡也不畫。
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
  ThreadHistoryQuery,
  ThreadHistoryResult,
  WorkspaceChangesPayload,
} from '@nexus/wire';
import {
  DELIVERABLES_PRESENTED,
  HISTORY_PAGE_MAX_BYTES,
  HISTORY_PAGE_MESSAGES,
  WORKSPACE_CHANGES,
} from '@nexus/wire';
import type { LoggedMessage, SessionEvent, SessionEventMap, UnreplayableReason } from '@nexus/core';
import { loggedMessageId, replayConversation } from '@nexus/core';

import { toolResultText } from './tool-result-text.js';

/** 推不回模型的原因裡，說的是「這份日誌是格式 9 以前寫的」的那幾種。見 {@link historyPage}。 */
const LEGACY_REASONS: ReadonlySet<UnreplayableReason> = new Set([
  'reply-missing',
  'result-missing',
  'summary-missing',
]);

/** 參數不合規時拋的錯。wire 那側據它回 `invalid_argument`，不是 `unknown_error`。 */
export class HistoryQueryError extends Error {}

/** 一則訊息的文字：字串照原樣，區塊只取 `text` 那幾塊（推理不畫，同即時）。 */
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
 * @param presented - 日誌裡那一顆的酬載。
 * @returns `{ name, payload }`，形狀見 `@nexus/wire` 的 `DeliverablesPresentedPayload`。
 */
export function deliverablesData(presented: SessionEventMap['deliverables/presented']): {
  readonly name: typeof DELIVERABLES_PRESENTED;
  readonly payload: DeliverablesPresentedPayload;
} {
  const payload: DeliverablesPresentedPayload = {
    callId: presented.callId,
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

function lifecycle(time: number, data: Record<string, unknown>): Event {
  return frame('lifecycle', time, { graph_name: 'root', ...data });
}

/**
 * 一則完整的訊息。`open` 的那則不送 `message-finish`，留給那一輪的收尾去標。
 *
 * **回覆的形狀同即時**（[#382](https://github.com/DemianLi/nexus-agent/issues/382)）：entry 的 key 放
 * `run_id`（`history-<seq>`），`message-start` 的 `id` 放日誌記的訊息 id——畫面據它評分，同即時那則的
 * `id`。日誌沒記 id 的就不帶，那則評不了。人那一則照舊只帶 `id`：它不是評分的目標。
 */
function message(
  time: number,
  role: 'human' | 'ai',
  key: string,
  text: string,
  open = false,
  messageId?: string,
): Event[] {
  const ids = role === 'ai' ? { run_id: key } : { id: key };
  return [
    frame('messages', time, {
      event: 'message-start',
      role,
      ...ids,
      ...(messageId !== undefined && { id: messageId }),
    }),
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

  const close = (time: number, data: Record<string, unknown>) => {
    frames.push(lifecycle(time, data));
    turnOpen = false;
    interrupted = false;
    suspended = false;
    unsettled.clear();
  };

  for (const event of events) {
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
        // 只帶工具呼叫的那一次沒有字可畫。即時的畫面那時會長一則空的，歷史不跟著長。
        if (text !== '') {
          frames.push(
            ...message(
              event.time,
              'ai',
              `history-${event.seq}`,
              text,
              event.data.interrupted,
              loggedMessageId(event.data.message),
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
        const text = toolResultText(event.data.message);
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
        frames.push(frame('custom', event.time, deliverablesData(event.data)));
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
  return frames;
}

function checkIndex(name: string, value: number | undefined, minimum: number): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < minimum)) {
    throw new HistoryQueryError(`${name} 要是不小於 ${minimum} 的整數，收到 ${String(value)}`);
  }
}

/** 一段折出來的 frame 在線上有多重。判準是**序列化之後**的位元組，見 {@link fitBytes}。 */
function weigh(segment: readonly SessionEvent[], awaitingInput?: AwaitingInput): number {
  return Buffer.byteLength(JSON.stringify(historyFrames(segment, awaitingInput)), 'utf8');
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
  awaitingInput?: AwaitingInput,
): { readonly cut: number; readonly bytes: number } {
  const starts: number[] = [];
  for (let at = messageCut; at < end; at += 1) {
    if (at === messageCut || isPageStart(window[at]!)) starts.push(at);
  }
  // 窗口裡一個輪邊界都沒有（整段是個片段）：沒有推得動的地方。
  if (starts.length === 0) {
    return { cut: messageCut, bytes: weigh(window.slice(messageCut, end), awaitingInput) };
  }

  // **最後那一整輪無條件收下**，而且是在迴圈外收的——「一頁至少一整輪」就住在這兩行裡，不是迴圈裡一個
  // 可以被拿掉的條件。往回延伸的那幾段才問上限。
  const lastStart = starts[starts.length - 1]!;
  let cut = lastStart;
  let bytes = weigh(window.slice(lastStart, end), awaitingInput);
  for (let i = starts.length - 2; i >= 0; i -= 1) {
    const from = starts[i]!;
    const size = weigh(window.slice(from, starts[i + 1]!));
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
): ThreadHistoryResult {
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
  const fitted = fitBytes(window, cut, end, tail);
  cut = fitted.cut;
  // 軟上限撐破了。**沒有人講的話這件事在線上完全看不見**——回應照樣是 200、畫面照樣對。
  if (fitted.bytes > HISTORY_PAGE_MAX_BYTES) onOversize?.(fitted.bytes);

  const replay = replayConversation(events);
  return {
    // **三種原因都是舊格式**：回覆、結果內容、摘要本文都是格式 9 才開始記的（#305），缺哪一樣都只可能出自 9 以前
    // 寫的那一段；哪一種先被撞到看的是日誌的順序（格式 8 的一輪，沒內容的結果落在收尾之前）。只認「沒有回覆」的話，
    // 真的 v8 日誌會被判成不是舊格式。切點對不上不算：畫面上不缺東西。
    events: historyFrames(
      window.slice(cut, end),
      end === events.length ? awaitingInput : undefined,
    ),
    firstSeq: cut,
    throughSeq,
    hasMore: window.slice(0, cut).some(isMessage),
    legacy: replay.kind === 'unreplayable' && LEGACY_REASONS.has(replay.reason),
  };
}

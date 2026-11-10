/**
 * 續接時把對話灌回模型（[#306](https://github.com/DemianLi/nexus-agent/issues/306)）。
 *
 * 照 dsh：日誌是對話的真相，模型歷史由日誌推出來（推的規則在 `@nexus/core` 的
 * {@link replayConversation}），**不是把 checkpointer 落盤**——所以門 B 照舊不開
 * （`session-resume-doors.test.ts` 的 `THE_ONLY_SAVER`）。#251 反對門 B 的理由是兩份耐久來源的寫入順序會
 * 分岔；這條路只有一份耐久來源，graph state 是從它推的。
 *
 * ## 時刻
 *
 * 建好 agent 之後、第一輪之前寫進 `messages`：`langgraph` 用 `updateState`（一條沒有 checkpoint 的 thread 也寫得進去，之後的第一輪
 * 照常接在後面，實測）；native 用 `seedThread`，那條 thread 在這個行程裡還沒有快取，對話只從日誌來。入口各叫一次：serve 碰到以前寫過的
 * thread（`serve-run.ts`）、CLI 的 `--resume`（`cli.ts`）、冷復活的背景子代理（`background-cold.ts`）。
 *
 * **只寫 `messages`，不帶切點。** 壓縮過的會話灌回去的是「摘要＋之後的」，那一串就是新 state 的原始訊息串。
 * 切點表（`@nexus/core` 的 `summary-cutoffs.ts`）上舊的條目對不上這一串（錨點那則已經被摘掉），等於沒有，下一次壓縮從這一串重新算起；
 * 帶著舊切點進去的話會拿它當上一次切點，切到別的地方去。
 *
 * **寫不進去就讓這條 thread 起不來**：推的一側把「續接時灌回去的那一串」當成之後壓縮切點的座標
 * （`conversation-replay.ts` 的 end-seed 那一段），灌失敗了還接著跑，下一次續接就會拿錯的座標切。
 *
 * ## 回不來的
 *
 * 虛擬檔案系統（沒給 `--workspace` 時的檔案）、
 * 摘要器的會話歷史檔（[#348](https://github.com/DemianLi/nexus-agent/issues/348)：灌回去的摘要仍寫著
 * 「完整歷史存在某某路徑」，那時讀不到）與停在核准點還沒答的那張卡都在 graph state 裡，而那一軸（`stateSchema`＋checkpointer）是我們偏離 dsh 的產物
 * （[#155](https://github.com/DemianLi/nexus-agent/issues/155)），日誌上沒有它們。沒答的那張卡推回來是一則補上的
 * 錯誤結果（dsh 的 `repair.ts`），見 `conversation-replay.ts`。
 *
 * **工具結果暫存回得來**（[#734](https://github.com/DemianLi/nexus-agent/issues/734)）：它存在主機的私有目錄、
 * 按會話分目錄（`tool-result-stash.ts`），不在 graph state 裡，所以這一條路灌回去的預覽指的路徑讀得到。
 */

import type { BaseMessage } from '@langchain/core/messages';
import {
  evictedToolResultText,
  nexusContent,
  parsesLoggedToolCalls,
  replayConversation,
  SESSION_EVENT_MAX_DEPTH,
  storedEventDepth,
  stringifyToolContent,
  toolResultEvictionPath as coreToolResultEvictionPath,
} from '@nexus/core';
import type {
  ConversationReplay,
  LoggedMessage,
  MessageContent,
  NexusMessage,
  SessionEvent,
  UnreplayableReason,
} from '@nexus/core';

import { CHECKPOINT_MAX_DEPTH, CheckpointDepthError, checkpointDepth } from './checkpoint-serde.js';
import { messageCheckpointDepth, vouchCheckpointDepth } from './pruned-memory-saver.js';

/** 這條 thread 的位址。 */
interface ThreadConfig {
  readonly configurable: { readonly thread_id: string };
}

/**
 * 灌得進去的 agent 那一面：`langgraph` 的圖寫 state（`updateState`），native agent 把推出來的對話放進還沒有快取的 thread
 * （`@nexus/core` 的 `NativeAgent.seedThread`）。
 */
export type RestorableAgent =
  | { updateState(config: ThreadConfig, values: Record<string, unknown>): Promise<unknown> }
  | { seedThread(config: ThreadConfig, messages: readonly BaseMessage[]): void };

/* -------------------------------------------------------------------------- */
/* 過大的工具結果：模型看到的是組裝點換過的預覽                               */
/* -------------------------------------------------------------------------- */
//
// 日誌記的是工具的輸出（`session-log.ts` 的 `tool/result`），模型看到的是組裝點那一格（core 的 `toolResultEvictionWrap`）
// 換過的那則：超過 80,000 字元的，換成一句「存在這個路徑、用 read_file 自己讀」加上頭尾預覽。推回去的要是模型看到的
// 那則，所以照同一條規則重算；規則在 core 的 `tool-result-eviction.ts`（[#2415](https://github.com/DemianLi/nexus-agent/issues/2415)）。
// `conversation-restore.test.ts` 比的是重算出來的與組裝點實際換上的那則；與基座逐字相同，由 core 的
// `tool-result-eviction.test.ts` 對著真的基座比。
//
// 預覽裡指的路徑**續接之後讀得到**（#734）：暫存在主機的私有目錄、按會話分目錄
// （`tool-result-stash.ts`），續接用同一個 run 目錄當鑰匙，找得到原來那個檔。重算的仍然是模型當時看到的字。

/**
 * 組裝點會把這則工具結果搬到哪個檔：沒過門檻或那顆工具不搬的回 undefined。
 *
 * 重播（{@link toolResultAsSeen}）與分叉讀繼承檔的路由（`fork-stash.ts`）共用這一份規則。
 *
 * @param message - 日誌裡記的那則（工具的輸出）：`ToolMessage`，或 nexus 訊息讀出來的同名三格。
 * @returns 搬去的虛擬路徑（`/large_tool_results/<呼叫編號>.txt`）；不搬就是 undefined。
 */
export function toolResultEvictionPath(message: {
  readonly name?: string;
  readonly content: MessageContent;
  readonly tool_call_id: string;
}): string | undefined {
  return coreToolResultEvictionPath(message);
}

/**
 * 一則工具結果在模型那一格長什麼樣：照 core 的搬移規則，過大的換成預覽。
 *
 * 換出來的那則帶齊 `ToolMessage` 建構子收的那幾格（轉的時候 `data` 原樣交給建構子），沒有 `additional_kwargs`／`response_metadata` 時補空物件，同建構子。
 *
 * @param message - 日誌裡記的那則（工具的輸出）。
 * @returns 沒過門檻或那顆工具不搬的原樣；過了的換成組裝點會換上的那則。
 */
export function toolResultAsSeen(message: NexusMessage): NexusMessage {
  const data = message.data as NexusMessage['data'] & {
    readonly artifact?: unknown;
    readonly status?: unknown;
    readonly metadata?: unknown;
  };
  const toolCallId = data.tool_call_id as string;
  const content = nexusContent(message);
  const filePath = toolResultEvictionPath({ name: data.name, content, tool_call_id: toolCallId });
  if (filePath === undefined) return message;
  const text = stringifyToolContent(content);
  return {
    type: 'tool',
    data: {
      content: evictedToolResultText(text, toolCallId, filePath),
      tool_call_id: toolCallId,
      name: data.name,
      id: data.id,
      artifact: data.artifact,
      status: data.status,
      metadata: data.metadata,
      additional_kwargs: data.additional_kwargs ?? {},
      response_metadata: data.response_metadata ?? {},
    } as NexusMessage['data'],
  };
}

/* -------------------------------------------------------------------------- */
/* 灌回去                                                                        */
/* -------------------------------------------------------------------------- */
//
// 讀盤共用過的事件（`storedEventDepth` 有值）推回時，巢狀的值與日誌共用（`shareStored`）。日誌那份整張深凍：下游就地改巢狀的值
// 當場拋，改不到日誌。推回到第一次存檔之間只換訊息頂層的欄位（`stampImageOrigin` 換 `additional_kwargs`，reducer 補 `id`），
// 不碰共用的值；第一次存檔時 `seal` 把訊息本身也凍起來。
//
// 這類事件讀盤時記下了層數；夠淺、建構子也不從字串解析新值的，推出的訊息登記給 `seal`（`vouchCheckpointDepth`），`seal` 不量。

/**
 * 事件不超過這個層數、建構子也不從字串解析新值（`parsesLoggedToolCalls`）的，推出來的訊息寫進存檔點一定在上限內，`seal` 不必量。
 *
 * 推出來的訊息在存檔點裡只比事件深固定幾層：日誌訊息的欄位在存檔點裡比在事件裡深 `CHECKPOINT_WRAPPER_DEPTH` 層
 * （`checkpoint-serde.ts`；四種事件都把訊息放在 `data` 底下同一層）；`turn/start` 的附件包進內容區塊多固定幾層；
 * `toJSON` 的跳脫（帶 `lc` 鍵的物件包一層 `__lc_escaped__`，包住的那顆裡面不再跳脫）最多多 1 層；建構子（`tool_call` 區塊、
 * v1 的 `contentBlocks`）與 {@link toolResultAsSeen} 在外面只包固定幾層。取上限的一半，餘裕遠大於這幾層。
 * 比這深的事件，與建構子會從字串解析的，`seal` 照常量。
 */
const VOUCHED_EVENT_DEPTH = SESSION_EVENT_MAX_DEPTH / 2;

/** 推出這則訊息的那一則日誌訊息；`turn/start` 推出的訊息不是從日誌訊息建的，沒有。 */
function loggedMessageOf(event: SessionEvent): LoggedMessage | undefined {
  if (event.type === 'compaction/summary') return event.data.summary;
  if (
    event.type === 'assistant/message' ||
    event.type === 'tool/result' ||
    event.type === 'user/message'
  ) {
    return event.data.message;
  }
  return undefined;
}

/** 這顆事件推出的訊息，寫進存檔點的層數是不是一定在上限內，見 {@link VOUCHED_EVENT_DEPTH}。 */
function depthBounded(event: SessionEvent): boolean {
  const depth = storedEventDepth(event);
  if (depth === undefined || depth > VOUCHED_EVENT_DEPTH) return false;
  const logged = loggedMessageOf(event);
  return logged === undefined || !parsesLoggedToolCalls(logged);
}

/**
 * 從日誌推出對話、灌回這條 thread 的 graph state。推不出來就不灌（#306 拍板 2），模型從空的開始。
 *
 * @param agent - 剛建好、還沒跑過任何一輪的 agent。
 * @param threadId - 這條 thread 的 id。
 * @param events - 續接讀回來的 root 日誌。
 * @returns 推的結果，給入口披露用。
 * @throws `updateState`／`seedThread` 拋錯——見檔頭「寫不進去就讓這條 thread 起不來」。存檔點太深（{@link CheckpointDepthError}，
 *   [#1658](https://github.com/DemianLi/nexus-agent/issues/1658)）時換成一顆帶 `seq` 的：最深的那一則出自日誌哪一顆事件。
 *   native 沒有存檔點，灌回之前用同一把尺量一次（`messageCheckpointDepth`），兩個 loop 拒同一份日誌：太深的訊息灌進去，下一輪在呼叫堆疊上爆
 *   （實測 5000 層是 `Maximum call stack size exceeded`），回的是認不得的錯。
 *   那一則不截斷、不改寫，要人看過再決定怎麼辦：上限之前寫下的舊日誌、或舊格式 `additional_kwargs.tool_calls`
 *   解析出來太深的，都會走到這裡。
 */
export async function restoreConversation(
  agent: RestorableAgent,
  threadId: string,
  events: readonly SessionEvent[],
): Promise<ConversationReplay> {
  const seqOf = new Map<BaseMessage, number>();
  const bounded = new Set<BaseMessage>();
  const replay = replayConversation(events, {
    toolResultAsSeen,
    shareStored: true,
    origin: (message, event) => {
      seqOf.set(message, event.seq);
      if (!depthBounded(event)) return;
      bounded.add(message);
      vouchCheckpointDepth(message);
    },
  });
  if (replay.kind === 'replayed' && replay.messages.length > 0) {
    const config = { configurable: { thread_id: threadId } };
    if ('seedThread' in agent) {
      for (const message of replay.messages as readonly BaseMessage[]) {
        if (bounded.has(message)) continue;
        const depth = messageCheckpointDepth(message);
        if (depth > CHECKPOINT_MAX_DEPTH) {
          throw new CheckpointDepthError(depth, CHECKPOINT_MAX_DEPTH, seqOf.get(message), 'thread');
        }
      }
      agent.seedThread(config, replay.messages as readonly BaseMessage[]);
      return replay;
    }
    try {
      await agent.updateState(config, { messages: [...replay.messages] as BaseMessage[] });
    } catch (error) {
      if (!(error instanceof CheckpointDepthError) || error.seq !== undefined) throw error;
      let deepest: BaseMessage | undefined;
      let most = -1;
      for (const message of replay.messages) {
        const depth = checkpointDepth(message);
        if (depth > most) [deepest, most] = [message, depth];
      }
      throw new CheckpointDepthError(error.depth, error.limit, deepest && seqOf.get(deepest));
    }
  }
  return replay;
}

const UNREPLAYABLE_TEXT: Readonly<Record<UnreplayableReason, string>> = {
  'reply-missing': '日誌裡有模型正常回來的呼叫，卻沒有記到回覆（多半是格式 9 以前寫的日誌）',
  'result-missing': '日誌裡少了工具結果的內容（格式 9 以前寫的日誌不記內容）',
  'summary-missing': '日誌裡少了壓縮的摘要（格式 9 以前寫的日誌不記摘要）',
  'compaction-misaligned': '壓縮的切點對不上推出來的對話，灌回去會切錯地方',
};

/**
 * 續接時「對話回來了沒有」那半句。
 *
 * @param replay - {@link restoreConversation} 的結果。
 * @returns 接在入口的續接披露裡。
 */
export function formatConversationRestore(replay: ConversationReplay): string {
  if (replay.kind === 'unreplayable') {
    return `對話從空的開始：${UNREPLAYABLE_TEXT[replay.reason]}`;
  }
  return replay.messages.length === 0
    ? '日誌裡還沒有對話'
    : `對話照日誌推回模型（${replay.messages.length} 則）`;
}

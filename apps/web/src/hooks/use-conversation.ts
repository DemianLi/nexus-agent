/**
 * 一條對話的接線：開下行、把 frame 折進狀態、把話送上行。
 *
 * **折疊本身不在這裡**，在 `@nexus/wire` 的 `reduceConversation`——那一層才驗得到
 * 真的 agent 跑出來的 frame（見 `@nexus/harness` 的 `conversation-wire.test.ts`）。
 * 這個 hook 只負責 React 那一半：連線的生命週期與送出的時機。
 */

import type {
  AnswerEntry,
  CommandOutcome,
  ConversationState,
  Event,
  GoalPauseResult,
  PromptAttachment,
  SubagentMention,
  SkillEntry,
  SlashDescriptor,
  QueueSteerAction,
  QueueUpdateAction,
  RunStartMode,
  SlashRunOutcome,
  UplinkResult,
  WireClient,
  WireFeedbackCategory,
  WireFeedbackItem,
  WireFeedbackRating,
} from '@nexus/wire';
import {
  answerResponse,
  appendAnswers,
  appendDecision,
  appendQuestionCancel,
  appendQuestionDecline,
  cancelResponse,
  declineResponse,
  emptyConversation,
  prependEntries,
  QUEUE_ITEM_NOT_FOUND,
  reduceAll,
  reduceConversation,
  STEER_UNAVAILABLE,
  uniformDecisions,
  WireProtocolError,
  WireRejectedError,
} from '@nexus/wire';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { createAgentClient } from '@/lib/agent';
import { sendRejectionText } from '@/lib/attachment-send';
import { resolvedClientTimeZone } from '@/lib/client-time-zone';
import { createConversationStore } from '@/lib/conversation-store';
import type { ConversationStore } from '@/lib/conversation-store';
import { FEEDBACK_COMMAND_LINE, FEEDBACK_COPY } from '@/lib/feedback';
import { FramePublisher, publicationOf } from '@/lib/frame-publisher';
import type { Publication } from '@/lib/frame-publisher';
import { RatingsController } from '@/lib/feedback-ratings';
import { goalPauseFailureText } from '@/lib/goal-bar';
import { PLAN_EXIT_LINE } from '@/lib/plan-chip';
import { commandArm, commandToken } from '@/lib/queue-view';
import { CommandDirectory } from '@/lib/command-directory';
import { submittedPlanOf } from '@/lib/plan-review';
import type { PlanScanOutcome } from '@/lib/plan-review';
import type { RatingsView } from '@/lib/feedback-ratings';
import { RECOVERED_NOTICE_MS, reconnectDelay } from '@/lib/reconnect';
import { mayHaveArrived, newRequestId } from '@/lib/request-id';
import { serverClosingText } from '@/lib/server-closing';
import { threadCapacityText } from '@/lib/thread-capacity';
import { threadHistoryTooDeepText } from '@/lib/thread-history-too-deep';
import {
  threadLogBudgetText,
  threadLogBusyText,
  threadLogTooLargeText,
} from '@/lib/thread-log-budget';
import { THREAD_REFUSED_TEXT } from '@/lib/thread-refused';
import { threadRootMismatchText } from '@/lib/thread-root-mismatch';
import { threadWriterHeldText } from '@/lib/thread-writer-held';
import {
  THREAD_PROTOCOL_ERROR_PAGE_TEXT,
  THREAD_PROTOCOL_ERROR_TEXT,
} from '@/lib/thread-protocol-error';
import { threadSubagentText } from '@/lib/thread-subagent';
import { randomUuid } from '@/lib/uuid';

/**
 * 命令清單抓不到時，開頭像命令的那一行退回的原因（[#1929](https://github.com/DemianLi/nexus-agent/issues/1929)）：送出當下
 * 重抓過一次還是失敗。分不出 `/plan` 是命令還是一句話，照 dsh 退回、不靜默降級成送給模型。
 */
export function commandsFailedText(message: string): string {
  return `命令清單沒有載入，分不出開頭的「/」是命令還是一句話，這一行沒有送出。（${message}）`;
}

/** `loadThrough` 每頁至少幾則，照 dsh 的 `JUMP_PAGE_MESSAGES`（`session.ts:57`）。 */
export const JUMP_PAGE_MESSAGES = 200;

/**
 * 往前讀歷史（`loadEarlier`、`loadThrough`、`findPlan`）拋錯時給畫面的那一句。伺服器送來看不懂的資料（`WireProtocolError`，
 * [#1866](https://github.com/DemianLi/nexus-agent/issues/1866)）：原文只進 `console.error`，照 dsh `Session.loadOlder`／`loadThrough`
 * （`packages/api/session-controller/src/client/sessions/session.ts:418-420`、`:466-468`）在這個位置的做法；畫面講固定的一句，可以再按一次。
 * 開線時停住那條（`halt`）是另一個位置：不再自動重連、等人按，用 `console.warn`。其他錯誤照舊回原因。
 */
function pagingFailureText(error: unknown): string {
  if (error instanceof WireProtocolError) {
    console.error(error);
    return THREAD_PROTOCOL_ERROR_PAGE_TEXT;
  }
  return error instanceof Error ? error.message : String(error);
}

/** 回饋對話框開給誰：一則回覆（按了讚或踩），或整個會話（只打了 `/feedback`）。 */
export type FeedbackTarget =
  | { readonly kind: 'session' }
  | { readonly kind: 'reply'; readonly messageId: string; readonly rating: WireFeedbackRating };

export interface FeedbackDialogState {
  readonly target: FeedbackTarget;
  readonly submitting: boolean;
  /** 上一次送出失敗的那句話。失敗時框留著（照 dsh）。 */
  readonly failure?: string;
}

export interface UseConversationOptions {
  /** 注入用；省略即連同源的 harness。 */
  readonly client?: WireClient;
  /** 省略即這一次載入自己開一條新的。 */
  readonly threadId?: string;
}

/** 畫面上那段歷史的現況（#306）。 */
/** 一句話伺服器沒收下（#645 Q4）。 */
export interface SendRejected {
  readonly message: string;
  /**
   * 不確定伺服器有沒有收到（#1335）：`run.start` 這一趟在網路層斷了，請求可能已經到了、只是回條沒回來。只有 `run.start`
   * 會設——它帶請求編號，原樣重送不會排兩次；斜線命令沒有編號，斷了也不設。
   */
  readonly uncertain?: true;
}

/**
 * 開頭像命令的那一行是不是命令（[#1929](https://github.com/DemianLi/nexus-agent/issues/1929)，dsh 送出狀態機的 `adjudicate`）：
 * `command` 是命令清單上的名字、`sentence` 是一句話；`failed` 是重抓過一次還是抓不到清單（原因講給人聽）；`released` 是等的時候
 * 這條 thread 的畫面卸載了，什麼都不必說（dsh 的 `onRelease` 不出聲）。
 */
export type Adjudication =
  /**
   * `detached`：沒宣告 `input`、整行只有 `/名字` 的命令（{@link commandArm}，#1971）：照 dsh 當場拿掉、背景執行，不進在途。
   * 在認完的那一刻、用認的那份清單判，呼叫端不必再讀自己手上可能較舊的清單。
   */
  | { readonly kind: 'command'; readonly detached: boolean }
  | { readonly kind: 'sentence' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'released' };

/**
 * 佇列的改、刪或改成插話沒收下。`gone` 是那一件已經不在隊裡：多半是剛開跑了，也可能是別的分頁刪的。`unavailable` 是
 * 改成插話時這一輪已經不收了（`steer_unavailable`，#710）。
 */
export interface QueueUpdateRejected {
  readonly gone: boolean;
  readonly unavailable: boolean;
  readonly message: string;
}

export interface HistoryView {
  /** 更早還有看得見的東西，「載入更早的對話」按得動。 */
  readonly hasMore: boolean;
  /** 舊格式的會話：模型的回覆沒有保存。見 `@nexus/wire` 的 `ThreadHistoryResult.legacy`。 */
  readonly legacy: boolean;
  /** 正在拿更早的那一頁。 */
  readonly loading: boolean;
  /**
   * 上一次往前翻拿不到的原因。**跟 {@link Conversation.historyError} 分開**：那一格是第一頁讀不到、畫在上方；
   * 這一格畫在按鈕旁邊，有它就不自動載入（`earlier-pager.tsx`）。再按一次就清掉。伺服器送來看不懂的資料時是固定的一句，
   * 不是原文（見 `pagingFailureText`）。
   */
  readonly error?: string;
  /** 最近一次往前翻接上了幾則（人打的字與模型的回覆各算一則，同 wire 一頁的單位），報讀用。 */
  readonly loaded?: number;
}

export interface Conversation {
  readonly state: ConversationState;
  /**
   * 同一份狀態的可訂閱版本（#1033），給右側欄的面板讀：身分穩定，面板只在看得見時訂閱。
   * 它跟 {@link Conversation.state} 在同一個發布回呼裡換，所以兩邊永遠是同一份。
   */
  readonly store: ConversationStore;
  /** 歷史拿到了沒、還有沒有更早的。**拿到之前是 `undefined`**，拿不到時看 {@link historyError}。 */
  readonly history?: HistoryView;
  /**
   * 第一頁歷史拿不回來的原因，連同伺服器給的錯誤碼（有的話）。對話照樣接得下去，只是之前說過的話不在畫面上。
   * 往前翻的失敗在 {@link HistoryView.error}。
   */
  readonly historyError?: { readonly message: string; readonly code?: string };
  /** 往前翻一頁，接在最前面。沒有更早的、或正在拿時什麼都不做。 */
  loadEarlier(): Promise<void>;
  /**
   * 往前一頁一頁載到日誌位置 `seq` 為止（#1601 `N1356`），給「在對話裡定位」用：目標還沒載入時先載到那一輪。
   * `seq` 是日誌位置，跟軌跡投影的 `turn.seq`、歷史游標 `firstSeq` 同一套。語意見實作。
   */
  loadThrough(seq: number): Promise<void>;
  /**
   * 計劃分頁的旁路掃描（#1798）：從已載入那一頁的游標往前一頁一頁讀，找 `callId` 相同的那一份計劃。**不動對話窗口**。語意見實作。
   */
  findPlan(callId: string, signal: AbortSignal): Promise<PlanScanOutcome>;
  /**
   * 下行開好了沒。**開好之前不能送**——這條線只補送還掛著的中斷（[#728](https://github.com/DemianLi/nexus-agent/issues/728)），
   * 其他的不重播，早送的那一輪會看不到。斷了就翻回 `false`。
   */
  readonly connected: boolean;
  /**
   * 這個分頁在這條上送出過一句話（#1600 `N1374`，dsh `Session.firstPromptPendingTurn`）：`run.start` 出門之前就翻，
   * 不等人話的 frame 折進來。伺服器明說不收、或確定沒出門時翻回來；斷在網路層、可能已經到了的那種不翻回來。
   * 斜線命令不翻：它不起一輪。
   */
  readonly attempted: boolean;
  /** 上一次開線失敗、或下行斷掉的原因。接回來就清掉。串流自己正常收掉時沒有原因可講，這一格不在。 */
  readonly connectionError?: string;
  /**
   * 下行被伺服器明說不收時，就是給使用者看的那一句；這時 {@link connectionError} 不在——server 的原文不往畫面送。
   * thread 數滿了（[#1478](https://github.com/DemianLi/nexus-agent/issues/1478)）是暫時的：重試照舊，接回來就清掉。
   * 沒有專用文案的碼（[#2222](https://github.com/DemianLi/nexus-agent/issues/2222)）也當暫時的，說同一句固定的話。
   * 子代理的會話（[#1708](https://github.com/DemianLi/nexus-agent/issues/1708)）、歷史太深、紀錄太大、開在別的 home 或工作區是永久的：不排重試，{@link reconnecting} 不在。
   * 伺服器送來看不懂的資料（#1601 `N0758`）也是這一格，{@link connectionError} 同樣不在：停止自動重連，{@link reconnecting} 照樣在，
   * 等人按 {@link reconnectNow}。
   */
  readonly refusal?: string;
  /**
   * 下行接上過幾次，第一次接上是 1。開頁時讀一次的那幾樣（`hooks/use-open-read.ts`）看它：暫時讀不到的，下一次接上時再讀
   * （[#1483](https://github.com/DemianLi/nexus-agent/issues/1483)）。
   */
  readonly connections: number;
  /**
   * 下行斷了（或第一次就沒開成），等著重接（[#593](https://github.com/DemianLi/nexus-agent/issues/593)）：多半是照退避自動重接；
   * 伺服器送來看不懂的資料時（#1601 `N0758`）停止自動重連，只等人按 {@link reconnectNow}，這時 {@link refusal} 有那一句。
   * `wasConnected` 分得出「連上過、中斷了」與「從沒連上」；`offline` 是瀏覽器說沒有網路，這時不排重試，
   * 回到線上才從頭算。
   */
  readonly reconnecting?: { readonly wasConnected: boolean; readonly offline: boolean };
  /** 剛重新接上：狀態列短暫講一句，{@link RECOVERED_NOTICE_MS} 後收掉。 */
  readonly recovered: boolean;
  /** 不等退避，立刻重接一次，退避從頭算；停止自動重連的（#1601）也從這裡重開。下行開著、或被永久拒絕時什麼都不做。 */
  reconnectNow(): void;
  /**
   * 上一個上行指令被拒的原因。
   *
   * **這條線的上行會拒絕東西**（停在核准點時的 `run.start`、對不上的 `interrupt_id`、
   * 筆數不對的決定），而拒絕是 200 ＋ error 封包。不看回應等於把它們靜靜吞掉——
   * 那正是這一版在 server 端拒絕動作要避免的事。
   */
  readonly commandError?: string;
  /**
   * 這條 thread 打得出哪些斜線命令：`/` 選單的命令組，也是送出時認命令的那份（#1929）。
   * dsh 的 `CommandDirectory`（epoch guard、single-flight）是另一張卡。
   */
  readonly slashCommands: readonly SlashDescriptor[];
  /**
   * 這條 thread 用 `/名字` 叫得出的技能（#1929）：`/` 選單的技能組。抓不到（伺服器沒掛技能、被拒、拋錯）就是空的，
   * 只少了那一組。
   */
  readonly skills: readonly SkillEntry[];
  /**
   * 上一個斜線命令自己失敗的原因，或那一行不是認得的命令。
   *
   * **跟 {@link Conversation.commandError} 是兩件事**：那個是這條線拒絕發派
   * （停在核准點、正在跑），這個是發派成功之後命令自己講的話。混在一起的那一刻，
   * 「這條 thread 正在跑」就會被顯示成「這個命令壞了」。
   */
  readonly slashError?: string;
  /**
   * 上一個斜線命令成功時要說的話。**命令的結果不進 transcript**——命令是人對工具說的
   * 話，不是對模型說的話，而 transcript 折的是線上的 `Event`。CLI 那邊的對應是
   * `printer.log`。
   */
  readonly slashNotice?: string;
  /**
   * 送一行進去。**開頭那個字是命令清單上的名字才走 `slash.run`**，其餘走 `run.start`
   * （[#1929](https://github.com/DemianLi/nexus-agent/issues/1929)，#1574 Q2 (a)，照 dsh）：技能的 `/deploy 今天`、打錯的
   * `/plna` 都是一句話，送給模型。這推翻了 [#123](https://github.com/DemianLi/nexus-agent/issues/123) 的「認不得的命令是
   * 錯誤」；「不認得這個命令」只剩清單上有、伺服器卻說不認得的那一種。開頭像命令的那一行要等到這條線的命令清單才分得出來
   * （照 dsh 的 strong-wait，`lib/command-directory.ts`）：清單在途就等它；之前抓失敗就當場重抓一次；等到的還是失敗才回
   * {@link SendRejected}（{@link commandsFailedText}），不靜默送給模型；等的時候畫面卸載就靜靜回 `undefined`。認的那一道同
   * {@link Conversation.adjudicate}，畫面要在等的期間擋住下一次送出，先自己叫那一個，再把結果帶進 `route`，這裡就不再認。
   *
   * **一句話送出去不畫任何東西**（#645）：伺服器收下就進送出佇列，開跑那一刻才由 `inbox` 的 `claimed` 畫人的泡泡。
   * 伺服器沒收下（回錯誤或這一趟就斷了）時回 {@link SendRejected}，呼叫端把草稿放回去並說出原因；斜線命令與
   * `/feedback` 各自報自己的結果，回 `undefined`——**帶了附件的斜線命令除外**（#733）：命令沒收下（不收附件、被拒、
   * 不認得）時回 {@link SendRejected}，草稿與附件留著。
   *
   * `mode` 是 `steer` 時送插話（#710）：跑著的這一輪下一步就送進模型，被領走時由 `inbox` 的 `claimedNextStep` 畫人的
   * 泡泡。斜線命令不看它。省略就是排隊。
   *
   * `attachments` 是已經準備好的附件（圖內嵌、檔案是收據，`lib/attachment-send.ts`），放進 `run.start`；斜線命令則放進
   * `slash.run`（命令有宣告收附件才收，否則伺服器回錯誤）。
   * 文字可以是空的，只要附件至少一個（只有附件的一句話）。
   * 伺服器不收（`not_supported`）或目前的模型不收圖（`model_does_not_support_images`）時回 {@link SendRejected}，
   * 訊息是講給人聽的話。
   *
   * `mention` 是這一句點名派的子代理（#328 第 2 項），放進 `run.start`；斜線命令不看它。伺服器不收（`not_supported`）
   * 或名字不在清單上（`invalid_argument`）時同樣回 {@link SendRejected}，草稿與標記由呼叫端留著。
   *
   * `requestId` 是這一句的請求編號（#1335，`lib/request-id.ts`）：**每一次 `run.start` 都帶**，沒給就這一次現產一個。
   * 草稿沒送出去時呼叫端要留著它，原樣重送同一句時傳回來——第一次其實已經到了的話，伺服器認得、不再排。斜線命令不看它
   * （`slash.run` 沒有編號，見 `docs/operations.md`）。
   */
  send(
    text: string,
    mode?: RunStartMode,
    attachments?: readonly PromptAttachment[],
    mention?: SubagentMention,
    requestId?: string,
    route?: 'command' | 'sentence',
  ): Promise<SendRejected | undefined>;
  /**
   * 退出計劃模式（#900）：送 `/plan off`，走跟打字送出同一條 `slash.run`。**結果由呼叫端自己畫**——回 `undefined` 是
   * 命令成功（標籤等線上的值翻回關著才消失），回字串是失敗的原因（被拒、不認得、命令回錯誤）。不碰
   * {@link Conversation.slashNotice} 與 {@link Conversation.slashError}：那兩格是狀態列的，標籤的失敗講在標籤旁邊。
   */
  exitPlanMode(): Promise<string | undefined>;
  /**
   * 執行一行**呼叫端確定是命令**的斜線命令（權限座的 `/permission <組名>`），直接走 `slash.run`，不經過 {@link Conversation.send}
   * 認命令的那一道（#1929）：命令清單抓失敗時那一道會退回，座位的切換就靜靜沒了。結果照斜線命令那一套顯示。
   */
  runCommand(line: string): Promise<void>;
  /**
   * 認開頭像命令的這一行（{@link Adjudication}）：等到這條線的命令清單才答——在途就等、之前失敗就重抓一次（照 dsh 的
   * `CommandDirectory.ensureReady`）。呼叫端在等的期間不再送任何一行、草稿不動（dsh 的 `adjudicating`）。
   */
  adjudicate(line: string): Promise<Adjudication>;
  /**
   * 暫停目標（`goal.pause`，[#1517](https://github.com/DemianLi/nexus-agent/issues/1517)）：帶**畫面上當時那份**目標的身分與修訂。
   * 一輪跑著時 server 當場停掉那一輪，停下來的事實走下行（跟按停止一樣）；相位翻成 `paused` 也走下行，這裡不自己改狀態。
   * 結果同 {@link Conversation.exitPlanMode}：回 `undefined` 是收下了，回字串是講給人聽的失敗原因（目標剛被改過、已經不在進行、
   * 伺服器不支援、這條線收不了）。
   */
  pauseGoal(goalId: string, revision: number): Promise<string | undefined>;
  /**
   * 改或刪送出佇列裡的一件（`queue.update`，#637）。**只回有沒有收下**：清單的新樣子走下行的 `inbox`，
   * 不拿回條改本地的東西。
   */
  updateQueue(
    itemId: string,
    action: QueueUpdateAction | QueueSteerAction,
  ): Promise<QueueUpdateRejected | undefined>;
  /**
   * 回答**指名的那一顆**核准請求。
   *
   * 一個決定套到那顆中斷的整批 `actionRequests` 上——逐筆按在基座那側分不出來
   * （見 `ApprovalCard`）。**但不會套到同一輪的其他中斷上**：`interruptId` 就是
   * 那道分界，基座據它逐 task 派送（[#232](https://github.com/DemianLi/nexus-agent/issues/232)）。
   * 認不得那顆 id 時什麼都不做。
   */
  respond(interruptId: string, decision: string): Promise<void>;
  /**
   * 回答**指名的那一顆**問答請求。
   *
   * 與 {@link Conversation.respond} 是兩個方法不是一個加寬的：送出的形狀不同
   * （`{answers:[…]}` 對 `{decisions:[…]}`），而型別上分開才擋得住「把答案送給核准
   * 那條路」。認不得那顆 id、或那顆不是問答時，什麼都不做。
   */
  answer(interruptId: string, answers: AnswerEntry['answers']): Promise<void>;
  /**
   * **關掉**指名的那一顆問答請求（送 `cancelled`，dsh 的 `ASK_CANCELLED`）：不回答，這一輪不停。計劃審核的「要求
   * 修改」走這一條（#654）——模型收到「停在這裡等使用者的訊息」，人接著在輸入框打意見。
   *
   * 一般提問面板的 ❌ **不走這條**，它停止這一輪（§4.3 寫明的例外）。認不得那顆 id、或那顆不是問答時，什麼都不做。
   */
  dismissQuestion(interruptId: string): Promise<void>;
  /**
   * **拒絕**指名的那一顆問答請求（送 `declined`，[#1098](https://github.com/DemianLi/nexus-agent/issues/1098)）：只有 MCP server
   * 的反問有這個動作——明確說不給，與 {@link Conversation.dismissQuestion}（先不回答）、作答是 MCP 的 `decline`／`cancel`／`accept` 三種。
   * 這一輪不停。認不得那顆 id、或那顆不是問答時，什麼都不做。
   */
  declineQuestion(interruptId: string): Promise<void>;
  /**
   * 按停止（`run.cancel`，[#276](https://github.com/DemianLi/nexus-agent/issues/276)）。
   *
   * **只送出、不等停穩，也不自己改狀態**：停下來的事實走下行，折疊器把狀態翻成 `stopped`。
   * 停在核准點時按它就是收回那幾張卡，收回的結果由伺服器那側寫。
   */
  cancel(): Promise<void>;
  /**
   * 這條 thread 目前的評分，以訊息 id（`AiEntry.messageId`）為鍵（[#382](https://github.com/DemianLi/nexus-agent/issues/382)）。
   * **第一次 {@link seedRatings} 之前是空的**，照 dsh。
   */
  readonly ratings: ReadonlyMap<string, WireFeedbackItem>;
  /** 讀回評分失敗了（dsh 的 `error.load`）。下一次滑過或按下去會再試。 */
  readonly ratingsLoadFailed: boolean;
  /**
   * 這台伺服器不收評分（`not_supported`，[#1849](https://github.com/DemianLi/nexus-agent/issues/1849)）：讚踩停用、講原因，按下去不開對話框。
   * 重連之後重讀，讀得到就恢復。評語（只打 `/feedback`）不受影響。
   */
  readonly ratingsUnsupported: boolean;
  /** 讀回這條 thread 的評分，讀過就不再讀。畫面掛在讚踩的第一次滑過或聚焦上。 */
  seedRatings(): void;
  readonly feedbackDialog?: FeedbackDialogState;
  /**
   * 按了一則回覆的讚或踩。**再點已選的那顆是收回**，另一顆開對話框，送出之後才記（照 dsh）。
   * 先等讀回評分：還沒滑過就直接按的話，看到的也是存著的那一筆。
   */
  rate(messageId: string, rating: WireFeedbackRating): Promise<void>;
  /** 送出回饋對話框。可以空著送。 */
  submitFeedback(draft: {
    readonly category?: WireFeedbackCategory;
    readonly text: string;
  }): Promise<void>;
  dismissFeedback(): void;
}

export function useConversation(options: UseConversationOptions = {}): Conversation {
  const client = useMemo(() => options.client ?? createAgentClient(), [options.client]);
  const threadId = useMemo(() => options.threadId ?? randomUuid(), [options.threadId]);

  const [state, setState] = useState<ConversationState>(emptyConversation);
  // 右側欄的面板讀對話走這一條（#1033）：跟交給 React 的同一刻、同一份，所以放在發布回呼裡，不另外排。
  const [store] = useState(() => createConversationStore(state));
  // 串流的逐字片段按動畫幀合併交給 React（`FramePublisher`，#527 Q8）。它手上的那份永遠是最新的。
  const [publisher] = useState(
    () =>
      new FramePublisher(state, (published) => {
        store.set(published);
        setState(published);
      }),
  );
  useEffect(() => () => publisher.cancel(), [publisher]);
  /** 所有改對話狀態的地方都走這裡。 */
  const advance = useCallback(
    (step: (previous: ConversationState) => ConversationState, publication?: Publication) => {
      publisher.apply(step, publication);
    },
    [publisher],
  );
  const [ratingsView, setRatingsView] = useState<RatingsView>(() => ({
    status: 'cold',
    items: new Map(),
  }));
  // **一條 thread 一個**：換 thread 時整個 view 重掛（`App.tsx` 的 `key`），不會拿著上一條的評分。
  const ratingsController = useMemo(
    () =>
      new RatingsController(
        {
          list: () => client.feedbackList(threadId),
          put: (params) => client.feedbackPut(threadId, params),
          delete: (params) => client.feedbackDelete(threadId, params),
        },
        setRatingsView,
      ),
    [client, threadId],
  );
  const [feedbackDialog, setFeedbackDialog] = useState<FeedbackDialogState | undefined>(undefined);
  const [connected, setConnected] = useState(false);
  const [connectionError, setConnectionError] = useState<string | undefined>(undefined);
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  const [connections, setConnections] = useState(0);
  const [reconnecting, setReconnecting] = useState<Conversation['reconnecting']>(undefined);
  const [recovered, setRecovered] = useState(false);
  /** 每加一就重開一次下行（#593）：自動重試與「立刻重連」都走這一格。 */
  const [generation, setGeneration] = useState(0);
  /**
   * 重接的帳。**放 ref 不放 state**：計時器與 `online` 事件在 effect 外面讀寫它，不需要為它重畫。
   * `attempt` 是連續第幾次重試（接上就歸零）；`lost` 是下行現在斷著；`everConnected` 分「中斷」與「從沒連上」；
   * `halted` 是最後一次失敗是伺服器送來看不懂的資料、停了自動重連（#1601 `N0758`）：「立刻重連」、接上、一般的斷線都清掉它。
   */
  const retry = useRef<{
    attempt: number;
    lost: boolean;
    everConnected: boolean;
    halted: boolean;
    timer?: ReturnType<typeof setTimeout>;
    recoveredTimer?: ReturnType<typeof setTimeout>;
  }>({ attempt: 0, lost: false, everConnected: false, halted: false });
  const [commandError, setCommandError] = useState<string | undefined>(undefined);
  const [attempted, setAttempted] = useState(false);
  const [slashCommands, setSlashCommands] = useState<readonly SlashDescriptor[]>([]);
  /**
   * 送出時認命令用的那份清單（#1929），照 dsh 的 `CommandDirectory`：每次開線丟掉重抓、抓失敗清空、送出時等到有一份才認。
   * 能用的那份換了就畫進 {@link Conversation.slashCommands}（選單、送出鈕）。
   */
  const commandDirectory = useMemo(
    () =>
      new CommandDirectory(async () => {
        const listed = await client.slashList(threadId);
        if (listed.kind === 'ok') return listed.commands;
        throw new Error(listed.message);
      }, setSlashCommands),
    [client, threadId],
  );
  /** 這條 thread 的畫面卸載就中止還在等命令清單的送出（dsh 送出狀態機的 `onRelease`）。 */
  const released = useRef(new AbortController());
  useEffect(() => {
    const controller = new AbortController();
    released.current = controller;
    return () => controller.abort();
  }, [commandDirectory]);
  const [skills, setSkills] = useState<readonly SkillEntry[]>([]);
  const [slashError, setSlashError] = useState<string | undefined>(undefined);
  const [slashNotice, setSlashNotice] = useState<string | undefined>(undefined);
  /** 這條會話開跑過幾輪（`status` 變成 `running` 的次數）。命令回應靠它認得「發出命令之後有輪開跑了」。 */
  const turnsStarted = useRef(0);
  // 命令回應只在「沒有輪跑著」的時候畫，所以一輪開跑就是它退場的時刻——不分人送的還是伺服器自己排的
  // （目標續行，#947）。只靠人的動作收，伺服器排的那一輪跑完它又冒出來，蓋掉「就緒」「已停止」。
  useEffect(() => {
    if (state.status !== 'running') return;
    turnsStarted.current += 1;
    setSlashNotice(undefined);
  }, [state.status]);
  /** 往前翻要帶回去的兩格，跟畫面要的那三格放一起。 */
  const [history, setHistory] = useState<
    (HistoryView & { readonly firstSeq: number; readonly throughSeq: number }) | undefined
  >(undefined);
  const [historyError, setHistoryError] = useState<
    { readonly message: string; readonly code?: string } | undefined
  >(undefined);
  const historyRef = useRef(history);
  historyRef.current = history;
  /**
   * 歷史換過幾次（#1601 `N1372`）：開線或重連的那一頁**換上去的那一刻**加一，往前翻的請求回來時代數不同就整份丟掉。
   * 照 dsh `Session.loadThrough` 的 `openGeneration`。**不拿 `generation` 那格**：它在重試計時器到點時就加一，比新的一頁
   * 換上來早；兩者之間按下的「載入更早的」帶的是舊游標，卻記到新的代數，回來時檢查照樣會過。
   */
  const historyEpoch = useRef(0);
  /**
   * 往前翻的忙碌旗標（`loadEarlier` 與 `loadThrough` 共用，照 dsh 的 `loadingOlder`）。**放 ref**：`history.loading` 要等下一次
   * 畫面才換，連按兩下擋不住。
   */
  const paging = useRef(false);
  /** 正在跑的 `loadThrough`：目標（重複呼叫壓到最低）與它的 promise。 */
  const jump = useRef<{ target: number; promise: Promise<void> } | undefined>(undefined);
  const clientRef = useRef(client);
  clientRef.current = client;
  const dialogRef = useRef(feedbackDialog);
  dialogRef.current = feedbackDialog;

  /** 排下一次重試。瀏覽器說離線就不排，等 `online`（照 dsh 的 `setNetworkAvailable`）。 */
  const scheduleRetry = useCallback(() => {
    const book = retry.current;
    clearTimeout(book.timer);
    book.timer = undefined;
    const offline = typeof navigator !== 'undefined' && !navigator.onLine;
    setReconnecting({ wasConnected: book.everConnected, offline });
    if (offline) return;
    book.attempt += 1;
    book.timer = setTimeout(() => {
      book.timer = undefined;
      setGeneration((current) => current + 1);
    }, reconnectDelay(book.attempt));
  }, []);

  const reconnectNow = useCallback(() => {
    const book = retry.current;
    if (!book.lost) return;
    clearTimeout(book.timer);
    book.timer = undefined;
    book.attempt = 0;
    book.halted = false;
    setGeneration((current) => current + 1);
  }, []);

  // 網路回來時退避從頭算，離開時停掉排著的那一次（同 dsh：`online` 後照樣先等第 1 次的退避，不是當場接）。
  // 停了自動重連的（`halted`）兩個事件都不管：網路回來不代表伺服器的資料變對了，同 dsh 只有載體斷線才續接。
  useEffect(() => {
    const onOnline = () => {
      if (!retry.current.lost || retry.current.halted) return;
      retry.current.attempt = 0;
      scheduleRetry();
    };
    const onOffline = () => {
      if (!retry.current.lost || retry.current.halted) return;
      scheduleRetry();
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [scheduleRetry]);

  // 卸載（換 thread 時整個 view 重掛）就把兩個計時器收掉：不能對已經離開的 thread 重接。
  useEffect(() => {
    const book = retry.current;
    return () => {
      clearTimeout(book.timer);
      clearTimeout(book.recoveredTimer);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    /**
     * 這條下行斷了：翻回沒連上、講原因、排下一次（#593）。串流正常收掉也算——server 不會無故收線。
     * `refused` 是伺服器明說不收時給使用者看的那一句（#1478）；**每次都重設**，上一次被拒的話不會留到下一次斷線。
     */
    const lose = (reason: string | undefined, refused?: string) => {
      const book = retry.current;
      book.lost = true;
      // 這次是一般的斷線：`halted` 只講「最後一次失敗是看不懂的資料」，在路上那次停住過也不算數（#1601）。
      book.halted = false;
      clearTimeout(book.recoveredTimer);
      setRecovered(false);
      setConnected(false);
      setConnectionError(reason);
      setRefusal(refused);
      scheduleRetry();
    };
    /**
     * 伺服器說這條**永遠**開不了（子代理的會話，#1708）：講原因、不排重試。`lost` 留在 false，所以「立刻重連」與
     * `online` 都不會再去開它——重試幾次，server 的答案都一樣。
     */
    const refuse = (refused: string) => {
      const book = retry.current;
      book.lost = false;
      clearTimeout(book.timer);
      book.timer = undefined;
      clearTimeout(book.recoveredTimer);
      setRecovered(false);
      setConnected(false);
      setConnectionError(undefined);
      setRefusal(refused);
      setReconnecting(undefined);
    };
    /**
     * 伺服器送來看不懂的資料（`WireProtocolError`，#1601 `N0758`）：下行的一顆、或歷史頁（頁欄位與每一筆）。**不排重試**：
     * 歷史裡的壞資料每次重連都抓到同一份，照 dsh 的錯誤分類（`packages/api/session-controller/README.md:54`）協定錯誤終止串流。
     * `lost` 照設，「立刻重連」按得到；`halted` 擋掉 `online`／`offline` 的自動重排。原文只進 `console.warn`，不進畫面。
     */
    const halt = (error: WireProtocolError) => {
      console.warn(error);
      const book = retry.current;
      book.lost = true;
      book.halted = true;
      clearTimeout(book.timer);
      book.timer = undefined;
      clearTimeout(book.recoveredTimer);
      setRecovered(false);
      setConnected(false);
      setConnectionError(undefined);
      setRefusal(THREAD_PROTOCOL_ERROR_TEXT);
      setReconnecting({ wasConnected: book.everConnected, offline: false });
    };

    void (async () => {
      try {
        const events = await client.openEvents(threadId, { signal: controller.signal });
        if (cancelled) {
          return;
        }
        // **歷史排在開線之後、放行送出之前**（#306），照 dsh 的「先訂閱、再拿 snapshot」：反過來的話，兩者
        // 之間發生的事兩邊都沒有。拿歷史時抽下行的迴圈還沒開始，這中間來的 frame 在線上排著，折完歷史才折
        // 它們，所以順序是對的。**`connected` 等歷史折完才翻**：早翻的話先送出去的那一句會排在歷史前面。
        const page = await client.threadHistory(threadId);
        if (cancelled) {
          return;
        }
        // **從空的重折，不接在現有的後面**（#593）：重接時傳輸 seq 可能從 0 重算（serve 重開過），折疊器又丟掉
        // `seq <= lastSeq` 的 frame，沿用舊的那份的話，新來的會全被當成重複。重接等於重新打開這一頁，只存在
        // 本地的東西（例如「已核准：X」）跟重新整理一樣不在了。第一次開線時現有的那份本來就是空的。
        // **還掛著的中斷也靠這一條回來**（#728）：歷史折不出它，伺服器在下行接上時補送原本那一顆、號也是原本的，
        // 排在線上等這裡折完才抽。沿用舊的那份的話，它的號比斷線前看到的小，面板就在重接那一刻不見。
        historyEpoch.current += 1;
        paging.current = false;
        jump.current = undefined;
        if (page.kind === 'ok') {
          const { events: frames, ...cursor } = page.result;
          advance(() => reduceAll(emptyConversation(), frames));
          setHistory({ ...cursor, loading: false });
          setHistoryError(undefined);
        } else {
          // **重連時歷史被拒，保留畫面**（#1601 `N1345`），照 dsh `journal-stream` 重連期間保留已發佈的視窗：關掉落盤的組裝
          // （#613）歷史一律被拒，網路一閃就整份清空。**`lastSeq` 照樣歸零**，理由同上一段 #593：serve 重開過的話傳輸號從 0
          // 起算，留著舊水位之後的即時幀全被當成重複丟掉。還掛著的中斷清掉，由伺服器接上時補送（#728）。第一次開線照舊從空的開始。
          // **代價**：落盤關掉又碰上 serve 重開時，畫面留著伺服器已經沒有的那份對話，旁邊有歷史錯誤那一句；斷線時那一輪若還在跑，
          // 狀態也可能停在跑著，等下一顆幀或重新整理才收。
          if (retry.current.everConnected) {
            advance((previous) => ({ ...previous, lastSeq: -1, pendings: [] }));
          } else {
            advance(() => emptyConversation());
          }
          setHistory(undefined);
          setHistoryError({
            message: page.message,
            ...(page.code === undefined ? {} : { code: page.code }),
          });
        }
        const book = retry.current;
        const wasLost = book.lost && book.everConnected;
        book.lost = false;
        // 計時器排的那次到點、還沒換上新的一輪時，在路上那次可能才停住（#1601）：接上了就不算停著。
        book.halted = false;
        book.attempt = 0;
        book.everConnected = true;
        setConnected(true);
        setConnections((count) => count + 1);
        setConnectionError(undefined);
        setRefusal(undefined);
        setReconnecting(undefined);
        if (wasLost) {
          setRecovered(true);
          clearTimeout(book.recoveredTimer);
          book.recoveredTimer = setTimeout(() => setRecovered(false), RECOVERED_NOTICE_MS);
        }
        // **讀過的評分重讀一次**（#772），照 dsh 的 `connection/reset`：每次連上都發、第一次也算，評分外掛只重讀
        // 不是 `cold` 的那份，冷的等人滑過再讀。斷線期間別的分頁可能改過；走 `resync` 排在路上的修改後面，
        // 晚回來的舊清單才不會蓋掉剛寫進去的版本。
        if (ratingsController.view.status !== 'cold') void ratingsController.resync();
        // **抓清單排在開線之後**，跟送話同一條規則：這條線除了還掛著的中斷不重播，所有的上行都等
        // 下行開好。清單本身不需要重播，但兩套順序規則比一套容易記錯。
        // 兩份清單都不等，事件照常往下收（#1929）。
        // 命令清單：每次連上都丟掉重抓（dsh `resetConnected`）——另一條線上的伺服器可能換了組裝。抓失敗照舊在狀態列說出來；
        // 送出時認命令那一道會再抓一次。
        void commandDirectory.resetConnected().then((outcome) => {
          if (!cancelled && outcome.kind === 'failed') setSlashError(outcome.message);
        });
        // 技能清單：同樣先清掉再抓（dsh `ui-skill` 重連時丟掉快取）。被拒、拋錯（含看不懂的資料）都只是 `/` 選單少了
        // 技能那一組，不停這條線。
        setSkills([]);
        void Promise.resolve()
          .then(() => client.skillList(threadId))
          .then(
            (outcome) => {
              if (!cancelled && outcome.kind === 'ok') setSkills(outcome.skills);
            },
            () => undefined,
          );
        for await (const event of events) {
          if (cancelled) {
            return;
          }
          advance((previous) => reduceConversation(previous, event), publicationOf(event));
        }
        if (!cancelled) lose(undefined);
      } catch (error) {
        if (!cancelled) {
          if (error instanceof WireProtocolError) {
            halt(error);
            return;
          }
          // 認的是型別錯誤上的碼，不解析訊息（#1481）。`message` 與 `serverMessage` 都是給管理者的原文，不往畫面送。
          // 永久的拒絕：子代理的會話（#1708）、歷史太深灌不回去（#1753）、紀錄太大讀不進來（#2203）、開在別的 home 或工作區（#2222）。
          const permanent =
            error instanceof WireRejectedError
              ? (threadSubagentText(error.code) ??
                threadHistoryTooDeepText(error.code) ??
                threadLogTooLargeText(error.code) ??
                threadRootMismatchText(error.code))
              : undefined;
          if (permanent !== undefined) {
            refuse(permanent);
            return;
          }
          const refused =
            error instanceof WireRejectedError
              ? (threadCapacityText(error.code) ??
                threadLogBusyText(error.code) ??
                threadWriterHeldText(error.code) ??
                THREAD_REFUSED_TEXT)
              : undefined;
          lose(
            refused !== undefined
              ? undefined
              : error instanceof Error
                ? error.message
                : String(error),
            refused,
          );
        }
      }
    })();

    return () => {
      // **收的是這條線，不是 agent。** server 端不會因為瀏覽器離開就停掉 run。
      cancelled = true;
      controller.abort();
      setConnected(false);
    };
  }, [client, threadId, advance, generation, scheduleRetry, ratingsController, commandDirectory]);

  /** 收下上行的回條：被拒就說出來，成功就把上一次的抱怨收掉。 */
  const note = useCallback((result: UplinkResult) => {
    setCommandError(result.type === 'error' ? result.message : undefined);
  }, []);

  /**
   * 斜線命令那一半。命令不進模型，也就不進 transcript。
   *
   * 命令沒收下（被拒、不認得、命令回錯誤、拋錯）回 {@link SendRejected}，狀態列照舊畫同一句。「收下」只有命令成功那一種，
   * 同 dsh `facade.ts:903` 的 `ok: outcome.kind === 'success'`。帶了附件時呼叫端把草稿放回去、附件留著（#733）；沒帶附件時
   * 呼叫端在途期間沒動草稿，沒收下就照樣不動、收下才清（[#1941](https://github.com/DemianLi/nexus-agent/issues/1941)）。
   */
  const runSlash = useCallback(
    async (
      line: string,
      attachments?: readonly PromptAttachment[],
    ): Promise<SendRejected | undefined> => {
      setSlashError(undefined);
      setSlashNotice(undefined);
      const turnsBefore = turnsStarted.current;
      const kept = attachments !== undefined && attachments.length > 0;
      const refuse = (message: string): SendRejected => ({ message });
      let outcome: SlashRunOutcome;
      try {
        outcome = await clientRef.current.slashRun(threadId, line, kept ? attachments : undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setSlashError(message);
        return refuse(message);
      }
      if (outcome.kind === 'rejected') {
        // 這條線拒絕發派，不是命令自己失敗，所以走 commandError，不走 slashError。
        const message =
          serverClosingText(outcome.code) ??
          threadLogBudgetText(outcome.code) ??
          threadWriterHeldText(outcome.code) ??
          threadRootMismatchText(outcome.code) ??
          outcome.message;
        setCommandError(message);
        return refuse(message);
      }
      setCommandError(undefined);
      if (outcome.kind === 'unknown') {
        const message = `不認得這個命令：${line}`;
        setSlashError(message);
        return refuse(message);
      }
      if (outcome.kind === 'error') {
        setSlashError(outcome.text);
        return refuse(outcome.text);
      }
      // 命令回來之前伺服器已經排了一輪開跑（`/goal` 建好就自己續行）：那一輪的結果才是現況，回應晚到
      // 也不畫，否則它在那一輪收尾後留在狀態列（#947）。
      if (turnsStarted.current !== turnsBefore) return undefined;
      // 成功而沒話說時什麼都不顯示，跟 CLI 一樣（`result.text` 是選配的）。
      setSlashNotice(outcome.text);
      return undefined;
    },
    [threadId],
  );

  const runCommand = useCallback(
    async (line: string): Promise<void> => {
      await runSlash(line.trim());
    },
    [runSlash],
  );

  const exitPlanMode = useCallback(async (): Promise<string | undefined> => {
    let outcome: SlashRunOutcome;
    try {
      outcome = await clientRef.current.slashRun(threadId, PLAN_EXIT_LINE);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    switch (outcome.kind) {
      case 'rejected':
        return outcome.message;
      case 'unknown':
        return `不認得這個命令：${PLAN_EXIT_LINE}`;
      case 'error':
        return outcome.text;
      default:
        return undefined;
    }
  }, [threadId]);

  const pauseGoal = useCallback(
    async (goalId: string, revision: number): Promise<string | undefined> => {
      let outcome: CommandOutcome<GoalPauseResult>;
      try {
        outcome = await clientRef.current.goalPause(threadId, { goalId, revision });
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      return goalPauseFailureText(outcome);
    },
    [threadId],
  );

  const adjudicate = useCallback(
    async (line: string): Promise<Adjudication> => {
      const signal = released.current.signal;
      let commands: readonly SlashDescriptor[];
      try {
        commands = await commandDirectory.ensureReady(signal);
      } catch (error) {
        if (signal.aborted) return { kind: 'released' };
        return {
          kind: 'failed',
          message: commandsFailedText(error instanceof Error ? error.message : String(error)),
        };
      }
      const arm = commandArm(commands, line);
      return arm === undefined
        ? { kind: 'sentence' }
        : { kind: 'command', detached: arm === 'detached' };
    },
    [commandDirectory],
  );

  const send = useCallback(
    async (
      text: string,
      mode?: RunStartMode,
      attachments?: readonly PromptAttachment[],
      mention?: SubagentMention,
      requestId?: string,
      route?: 'command' | 'sentence',
    ): Promise<SendRejected | undefined> => {
      const trimmed = text.trim();
      const hasAttachments = attachments !== undefined && attachments.length > 0;
      // 文字或附件至少一個；只有附件時文字是空字串，照樣送。
      if (trimmed === '' && !hasAttachments) {
        return undefined;
      }
      if (trimmed === FEEDBACK_COMMAND_LINE) {
        // **只打 `/feedback` 開對話框**，照 dsh 的 `/feedback` 裝飾：送出的是 `feedback.record`，
        // 跑著也收。帶了文字的 `/feedback 很慢` 照舊走 `slash.run`（#267 的 Q2）。
        setSlashError(undefined);
        setSlashNotice(undefined);
        setFeedbackDialog({ target: { kind: 'session' }, submitting: false });
        return undefined;
      }
      // 開頭那個字是命令清單上的名字才是命令（#1929，#1574 Q2 (a)），其餘整行走 `run.start`：技能的 `/deploy 今天`、
      // 打錯的 `/plna`、沒宣告 input 卻帶了字的 `/compact 留下三輪`（#1971，dsh `matchEnter` `:361`）都送給模型。
      // 分得出來之前照 dsh 等（`matchEnter` 的 strong-wait）：清單在途就等它、之前失敗就重抓；等到的還是失敗才退回、
      // 說出原因，草稿與附件原樣留著（「never a silent downgrade」）。
      if (commandToken(trimmed) !== undefined) {
        // 呼叫端已經認過（`route`）就照它，不再認第二次：兩次之間剛好重連的話，結果可能跟呼叫端決定標記時不同。
        const verdict: Adjudication | { readonly kind: 'command' | 'sentence' } =
          route === undefined ? await adjudicate(trimmed) : { kind: route };
        if (verdict.kind === 'released') return undefined;
        if (verdict.kind === 'failed') return { message: verdict.message };
        if (verdict.kind === 'command') {
          return runSlash(trimmed, hasAttachments ? attachments : undefined);
        }
      }
      setSlashError(undefined);
      setSlashNotice(undefined);
      // 在第一個 `await` 之前翻（dsh `session.ts:262-266`）：回音折進來之前按「新對話」，也要算這條講過了。
      setAttempted(true);
      let result: UplinkResult;
      try {
        // 排隊不帶 `mode`、沒有附件不帶 `attachments`：都是預設。編號每一次都帶（#1335）。
        // 時區每一次都在送出當下取（#1630，照 dsh）：拿不到就拋，落在下面的 catch，這一句退回、請求沒出門。
        result = await clientRef.current.runStart(threadId, trimmed, {
          requestId: requestId ?? newRequestId(),
          clientTimeZone: resolvedClientTimeZone(),
          ...(mode === 'steer' ? { mode } : {}),
          ...(attachments === undefined || attachments.length === 0 ? {} : { attachments }),
          ...(mention === undefined ? {} : { mention }),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // 請求可能已經到了（網路層斷了、閘道 502／504）就標不確定；伺服器明說不收的照舊（#1335）。
        if (mayHaveArrived(error)) return { message, uncertain: true };
        setAttempted(false);
        return { message };
      }
      if (result.type === 'error') {
        // 被拒仍是空白（dsh `session.ts:302-307`）。
        setAttempted(false);
        return {
          message:
            threadCapacityText(result.error) ??
            serverClosingText(result.error) ??
            threadHistoryTooDeepText(result.error) ??
            threadLogBudgetText(result.error) ??
            threadWriterHeldText(result.error) ??
            threadRootMismatchText(result.error) ??
            sendRejectionText(result.error, hasAttachments, mention !== undefined) ??
            result.message,
        };
      }
      setCommandError(undefined);
      return undefined;
    },
    [threadId, runSlash, adjudicate],
  );

  const updateQueue = useCallback(
    async (
      itemId: string,
      action: QueueUpdateAction | QueueSteerAction,
    ): Promise<QueueUpdateRejected | undefined> => {
      let result: UplinkResult;
      try {
        result = await clientRef.current.queueUpdate(threadId, { item_id: itemId, action });
      } catch (error) {
        return {
          gone: false,
          unavailable: false,
          message: error instanceof Error ? error.message : String(error),
        };
      }
      if (result.type !== 'error') return undefined;
      return {
        gone: result.error === QUEUE_ITEM_NOT_FOUND,
        unavailable: result.error === STEER_UNAVAILABLE,
        message: result.message,
      };
    },
    [threadId],
  );

  const respond = useCallback(
    async (interruptId: string, decision: string) => {
      // 送出的那一刻要讀的是**當下**的 pending：不是這次 render 閉包起來的那份，也不是 React 手上可能落後幾幀的那份。
      const pending = publisher.current.pendings.find(
        (candidate) => candidate.interruptId === interruptId,
      );
      // 問答那一顆不收——它的送出形狀是 `{answers:[…]}`，送 `{decisions:[…]}` 過去
      // 會讓工具當場拋，而人只會看到一張永遠不動的卡。
      if (pending === undefined || pending.kind !== 'approval') {
        return;
      }
      // **決定在線上沒有回聲**——拒絕掉的那一批連一顆 frame 都不會有（實測），
      // 所以跟使用者那句話一樣，在送出的那一刻自己寫進去。
      advance((previous) => appendDecision(previous, interruptId, decision));
      note(
        await clientRef.current.inputRespond(threadId, {
          namespace: [...pending.namespace],
          interrupt_id: pending.interruptId,
          response: uniformDecisions(pending, decision),
        }),
      );
    },
    [threadId, note, advance],
  );

  const answer = useCallback(
    async (interruptId: string, answers: AnswerEntry['answers']) => {
      // 送出的那一刻要讀的是**當下**的 pending：不是這次 render 閉包起來的那份，也不是 React 手上可能落後幾幀的那份。
      const pending = publisher.current.pendings.find(
        (candidate) => candidate.interruptId === interruptId,
      );
      if (pending === undefined || pending.kind !== 'question') {
        return;
      }
      // 同 `respond`：線上不回聲，所以送出的那一刻自己寫進去。
      advance((previous) => appendAnswers(previous, interruptId, answers));
      note(
        await clientRef.current.inputRespond(threadId, {
          namespace: [...pending.namespace],
          interrupt_id: pending.interruptId,
          response: answerResponse(answers),
        }),
      );
    },
    [threadId, note, advance],
  );

  const dismissQuestion = useCallback(
    async (interruptId: string) => {
      const pending = publisher.current.pendings.find(
        (candidate) => candidate.interruptId === interruptId,
      );
      if (pending === undefined || pending.kind !== 'question') {
        return;
      }
      // 同 `answer`：線上不回聲，送出的那一刻自己寫進去。
      advance((previous) => appendQuestionCancel(previous, interruptId));
      note(
        await clientRef.current.inputRespond(threadId, {
          namespace: [...pending.namespace],
          interrupt_id: pending.interruptId,
          response: cancelResponse(),
        }),
      );
    },
    [threadId, note, advance],
  );

  const declineQuestion = useCallback(
    async (interruptId: string) => {
      const pending = publisher.current.pendings.find(
        (candidate) => candidate.interruptId === interruptId,
      );
      if (pending === undefined || pending.kind !== 'question') {
        return;
      }
      // 同 `dismissQuestion`：線上不回聲，送出的那一刻自己寫進去。
      advance((previous) => appendQuestionDecline(previous, interruptId));
      note(
        await clientRef.current.inputRespond(threadId, {
          namespace: [...pending.namespace],
          interrupt_id: pending.interruptId,
          response: declineResponse(),
        }),
      );
    },
    [threadId, note, advance],
  );

  const cancel = useCallback(async () => {
    note(await clientRef.current.runCancel(threadId));
  }, [threadId, note]);

  const loadEarlier = useCallback(async () => {
    const current = historyRef.current;
    if (current === undefined || !current.hasMore || current.loading || paging.current) return;
    paging.current = true;
    const epoch = historyEpoch.current;
    // 上一次的錯誤與報讀在按下去的當下清掉：旁邊那一句不留著，按鈕的字由 `useSettledLabel` 記住。報讀那一格先清空再寫，
    // 連續兩頁都是 50 則時第二次才唸得到（文字沒變的話 DOM 不動，polite 區不會再唸）。
    const { error: _previousError, loaded: _previousLoaded, ...rest } = current;
    setHistory({ ...rest, loading: true });
    let page;
    try {
      page = await clientRef.current.threadHistory(threadId, {
        beforeSeq: current.firstSeq,
        throughSeq: current.throughSeq,
      });
    } catch (error) {
      if (epoch !== historyEpoch.current) return;
      paging.current = false;
      setHistory({ ...rest, loading: false, error: pagingFailureText(error) });
      return;
    }
    // **換代就整份丟掉**（#1601 `N1372`）：回應到之前重連換上了新的一頁，這一頁是接在舊游標前面的，接上去會留下補不回來的
    // 空洞、`firstSeq` 也被改回舊值。三條路（拋錯、被拒、成功）都用舊的 `rest` 寫，所以三條都要擋。
    if (epoch !== historyEpoch.current) return;
    paging.current = false;
    if (page.kind === 'rejected') {
      setHistory({ ...rest, loading: false, error: page.message });
      return;
    }
    // 更早那一頁自己從空的折，再接在前面：折進現在這一份的話，它的收尾會把現在的狀態蓋掉。
    const earlier = reduceAll(emptyConversation(), page.result.events);
    advance((previous) => prependEntries(previous, earlier));
    setHistory({
      ...rest,
      firstSeq: page.result.firstSeq,
      hasMore: page.result.hasMore,
      loading: false,
      loaded: earlier.entries.filter((entry) => entry.kind === 'human' || entry.kind === 'ai')
        .length,
    });
  }, [threadId, advance]);

  /**
   * 照 dsh `Session.loadThrough`（`session.ts:427-481`）：每頁至少 {@link JUMP_PAGE_MESSAGES} 則一頁一頁往前，**成功的頁私下留著、
   * 結束時一次接在前面**，畫面只變一次。
   *
   * - 跳轉正在跑時再叫：目標壓到最低，回同一個 promise。
   * - 單頁的「載入更早的」正在跑：直接回，不排在它後面（呼叫端等它收完再按）。
   * - 某一頁沒有進展（`firstSeq` 沒變小）就停，不空轉。那一頁照 dsh 照樣收下（harness 的切點不會落在游標之後，
   *   沒進展的那一頁裡沒有訊息）。
   * - 中途被拒或拋錯：已經拿到的頁照樣接上，錯誤寫進 `history.error`。
   * - 換代（重連換上了新的一頁，見 `historyEpoch`）：整份丟掉，迴圈也停。
   */
  const loadThrough = useCallback(
    (seq: number): Promise<void> => {
      const current = historyRef.current;
      if (current === undefined || !current.hasMore || current.firstSeq <= seq) {
        return Promise.resolve();
      }
      const running = jump.current;
      if (running !== undefined) {
        running.target = Math.min(running.target, seq);
        return running.promise;
      }
      if (paging.current) return Promise.resolve();
      paging.current = true;
      const epoch = historyEpoch.current;
      const { error: _previousError, loaded: _previousLoaded, ...rest } = current;
      setHistory({ ...rest, loading: true });
      const book: { target: number; promise: Promise<void> } = {
        target: seq,
        promise: Promise.resolve(),
      };
      // 先登記再開跑：`threadHistory` 同步拋的話 `finally` 在這一格裡就跑完，晚登記會留下一個永遠不收的跳轉。
      jump.current = book;
      book.promise = (async () => {
        const pages: (readonly Event[])[] = [];
        let beforeSeq = current.firstSeq;
        let hasMore = current.hasMore;
        let failure: string | undefined;
        try {
          while (hasMore && beforeSeq > book.target) {
            if (epoch !== historyEpoch.current) return;
            const page = await clientRef.current.threadHistory(threadId, {
              beforeSeq,
              throughSeq: current.throughSeq,
              maxMessages: JUMP_PAGE_MESSAGES,
            });
            if (page.kind === 'rejected') {
              failure = page.message;
              return;
            }
            const before = beforeSeq;
            pages.push(page.result.events);
            beforeSeq = page.result.firstSeq;
            hasMore = page.result.hasMore;
            if (beforeSeq >= before) return;
          }
        } catch (error) {
          failure = pagingFailureText(error);
        } finally {
          if (jump.current === book) jump.current = undefined;
          if (epoch === historyEpoch.current) {
            paging.current = false;
            // 頁是由新往舊拿的，倒過來才是日誌的順序；接起來從空的折一次，同 `loadEarlier` 的理由。
            const earlier = reduceAll(emptyConversation(), pages.reverse().flat());
            if (pages.length > 0) advance((previous) => prependEntries(previous, earlier));
            setHistory({
              ...rest,
              firstSeq: beforeSeq,
              hasMore,
              loading: false,
              ...(failure === undefined ? {} : { error: failure }),
              ...(pages.length === 0
                ? {}
                : {
                    loaded: earlier.entries.filter(
                      (entry) => entry.kind === 'human' || entry.kind === 'ai',
                    ).length,
                  }),
            });
          }
        }
      })();
      return book.promise;
    },
    [threadId, advance],
  );

  /**
   * 照 dsh `planResourceProvider`（`ui-plan/src/client/plan-resource.ts:49-73`）：`throughSeq` 固定成同一個切點，`beforeSeq` 一頁接
   * 一頁往前，每頁自己從空的折，找 `exit_plan_mode` 而且 `callId` 相同的那一份（`submittedPlanOf`，同 dsh 的 `submittedPlan`）。
   *
   * - **不移動對話窗口**：不碰 `paging`／`jump`／`history`，拿到的頁也不接進條目。
   * - **起點沿用已載入那一頁的游標**：dsh 從 follow 的 snapshot 開始，那份 snapshot 的條目就是對話窗口，計劃庫已經看過了，
   *   不必再拿一次。頁的大小同 `loadEarlier` 不指定（dsh 的 `remote.page` 也不帶，用伺服器的預設）。
   * - 照 dsh **不設上限**，只看 `signal`（`threadHistory` 不收 signal，所以在每次請求前後看）。某一頁沒有進展就停，同 `loadThrough`。
   * - 換代（`historyEpoch`）回 `stale`：這一份是接在舊游標前面讀的，整份丟掉，由呼叫端從新的游標重掃。
   */
  const findPlan = useCallback(
    async (callId: string, signal: AbortSignal): Promise<PlanScanOutcome> => {
      const current = historyRef.current;
      if (current === undefined) return { kind: 'stale' };
      const epoch = historyEpoch.current;
      let beforeSeq = current.firstSeq;
      let hasMore = current.hasMore;
      try {
        while (hasMore) {
          if (signal.aborted) return { kind: 'aborted' };
          const page = await clientRef.current.threadHistory(threadId, {
            beforeSeq,
            throughSeq: current.throughSeq,
          });
          if (signal.aborted) return { kind: 'aborted' };
          if (epoch !== historyEpoch.current) return { kind: 'stale' };
          if (page.kind === 'rejected') return { kind: 'failed', message: page.message };
          for (const entry of reduceAll(emptyConversation(), page.result.events).entries) {
            if (entry.kind !== 'tool' || entry.callId !== callId) continue;
            const plan = submittedPlanOf(entry);
            if (plan !== undefined) return { kind: 'found', plan, firstSeq: page.result.firstSeq };
          }
          const before = beforeSeq;
          beforeSeq = page.result.firstSeq;
          hasMore = page.result.hasMore;
          if (beforeSeq >= before) break;
        }
      } catch (error) {
        if (signal.aborted) return { kind: 'aborted' };
        if (epoch !== historyEpoch.current) return { kind: 'stale' };
        return { kind: 'failed', message: pagingFailureText(error) };
      }
      return { kind: 'not-found' };
    },
    [threadId],
  );

  const seedRatings = useCallback(() => {
    void ratingsController.ensure();
  }, [ratingsController]);

  const rate = useCallback(
    async (messageId: string, rating: WireFeedbackRating) => {
      const loaded = await ratingsController.ensure();
      // 伺服器不收評分（#1849）：不開對話框，免得填完送出才報錯。畫面那側已經停用了，這裡是保險（滑過與按下是同一下的觸控）。
      if (ratingsController.view.status === 'unsupported') return;
      if (!loaded.ok || ratingsController.view.items.get(messageId)?.rating !== rating) {
        setFeedbackDialog({ target: { kind: 'reply', messageId, rating }, submitting: false });
        return;
      }
      // 再點一次已選的那顆：收回。結果不走對話框，失敗的話跟命令的失敗講在同一行。
      setSlashError(undefined);
      setSlashNotice(undefined);
      const result = await ratingsController.retract(messageId, rating);
      if (!result.ok) setSlashError(result.failure);
    },
    [ratingsController],
  );

  const submitFeedback = useCallback(
    async (draft: { readonly category?: WireFeedbackCategory; readonly text: string }) => {
      const open = dialogRef.current;
      if (open === undefined || open.submitting) return;
      setFeedbackDialog({ target: open.target, submitting: true });
      const fail = (failure: string): void => {
        setFeedbackDialog((current) =>
          current === undefined ? current : { target: current.target, submitting: false, failure },
        );
      };
      const text = draft.text.trim();
      const category = draft.category === undefined ? {} : { category: draft.category };
      try {
        if (open.target.kind === 'session') {
          const outcome = await clientRef.current.feedbackRecord(threadId, {
            ...(text === '' ? {} : { text }),
            ...category,
          });
          if (outcome.kind === 'rejected') {
            fail(`${FEEDBACK_COPY.generic}：${outcome.message}`);
            return;
          }
        } else {
          const { messageId, rating } = open.target;
          const result = await ratingsController.rate(messageId, rating, {
            ...(text === '' ? {} : { note: text }),
            ...category,
          });
          if (!result.ok) {
            fail(result.failure);
            return;
          }
        }
      } catch (error) {
        fail(`${FEEDBACK_COPY.generic}：${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      setFeedbackDialog(undefined);
      setSlashError(undefined);
      // 送出之後的那句謝謝跟命令的結果講在同一行：兩者都是「這一側要說的話」，不進 transcript。
      setSlashNotice(FEEDBACK_COPY.recorded);
    },
    [threadId, ratingsController],
  );

  const dismissFeedback = useCallback(() => {
    setFeedbackDialog(undefined);
  }, []);

  return {
    state,
    store,
    connected,
    attempted,
    recovered,
    reconnectNow,
    ...(reconnecting === undefined ? {} : { reconnecting }),
    loadEarlier,
    loadThrough,
    findPlan,
    ...(history === undefined
      ? {}
      : {
          history: {
            hasMore: history.hasMore,
            legacy: history.legacy,
            loading: history.loading,
            ...(history.error === undefined ? {} : { error: history.error }),
            ...(history.loaded === undefined ? {} : { loaded: history.loaded }),
          },
        }),
    ...(historyError === undefined ? {} : { historyError }),
    slashCommands,
    skills,
    send,
    exitPlanMode,
    runCommand,
    adjudicate,
    pauseGoal,
    updateQueue,
    respond,
    answer,
    dismissQuestion,
    declineQuestion,
    cancel,
    ratings: ratingsView.items,
    ratingsLoadFailed: ratingsView.status === 'failed',
    ratingsUnsupported: ratingsView.status === 'unsupported',
    seedRatings,
    rate,
    submitFeedback,
    dismissFeedback,
    ...(feedbackDialog === undefined ? {} : { feedbackDialog }),
    ...(connectionError === undefined ? {} : { connectionError }),
    ...(refusal === undefined ? {} : { refusal }),
    connections,
    ...(commandError === undefined ? {} : { commandError }),
    ...(slashError === undefined ? {} : { slashError }),
    ...(slashNotice === undefined ? {} : { slashNotice }),
  };
}

/**
 * 觀測分頁（[#1033](https://github.com/DemianLi/nexus-agent/issues/1033)、[#1034](https://github.com/DemianLi/nexus-agent/issues/1034)
 * 觀測那一半）怎麼把對話投成「一輪一組、依序一列一列」。UI/UX 以 shadcn＋Tailwind 為基底、Libraries.dev 為模仿對象，
 * **不是照 dsh 的 `ui-trajectory` 畫時間線**（AGENTS.md「不在這條範圍內的」）。
 *
 * ## 兩種模式
 *
 * - **結構化**：有軌跡投影（#1027，`projections.trajectory`，閘門見 `trajectory-view.ts`）時，輪界、模型呼叫、重試、重複呼叫
 *   提醒、時刻與耗時都讀它。**條目（`entries`）仍是內文的來源**，投影只帶結構、不帶內文，用鍵指回來。
 * - **第 0 版**：沒有投影（舊伺服器、插件關了、拋過、版本不認得）時完全照 #1033 的做法：只有順序、以人那一句切輪，
 *   四條限制全寫在畫面上。
 *
 * ## 結構化模式怎麼把條目歸到輪（探針量過，即時與重新整理後各一次）
 *
 * | 條目 | 鍵 |
 * | --- | --- |
 * | 工具 | `tool-<callId>`（**不是** `callId` 本身） |
 * | 模型回覆 | `AiEntry.messageId` 等於投影的 `reply.messageId`；歷史的條目 id 另外是 `history-<reply.seq>` |
 * | 人的話 | **沒有鍵**：即時是 `inbox:<runId>`、歷史是 `history-<seq>`，而且 `turn.seq` 是 `turn/start` 的位置、不是人話的位置 |
 *
 * 所以**輪界由成員決定，不由人那一格決定**：先用鍵把工具與回覆歸進 `(輪, 呼叫)`，沒有鍵的「開輪條目」（人的話、結算通知、
 * 子代理來信）歸給**它後面第一個歸得進去的條目**所在的輪——**目標自己排的輪沒有人話，第一個成員就開了那一輪**，#1033 的
 * 限制 1 因此拿掉。其餘沒有鍵的（還在吐字的回覆、決定、壓縮、子代理自己的列）沿用前一個條目的位置：子代理的列照出現
 * 的先後交錯，跟第 0 版一樣（背景的子代理在別的輪之間冒出來是它們實際發生的順序，不硬搬回發起它的那一輪）。
 *
 * 兩個方向的對不上都有去處，不丟列：
 *
 * - **窗口之前的條目**（投影只帶最近幾輪）：已載入但不在任何一輪裡，照第 0 版以人那一句切成組，標「沒有結構資料」。
 * - **投影有、條目沒載入**的輪或呼叫：照樣畫輪的標題與呼叫段落，只是沒有內文可展開、也沒有定位鈕，並說明原因。
 *   窗口更早的輪只剩 `digests` 的計數，畫成只有數字的摘要列；人要看（或「看這一輪」落在那裡）時向伺服器按需拉那一輪的細節
 *   （`lib/trajectory-pull.ts`），拉回來的併進去、原位取代那一列摘要。
 *
 * ## 事實讀投影，不讀條目
 *
 * 呼叫的起訖與耗時、工具的耗時取自投影：重新整理後條目上模型回覆的 `startedAt` 等於 `settledAt`（#1048），算出來是錯的。
 * 缺席的欄位寫 `—`，不補 0。
 *
 * **子代理自己的軌跡今天沒有**：插件沒有宣告 `children`，`subagentProjections` 裡沒有它的值。子代理的列照舊以歸屬標籤
 * 夾在主對話的列之間，要看它內部的呼叫結構得先有 harness 那一側的投影。
 *
 * ## 第 0 版的切輪靠「人那一格」，而這會錯
 *
 * 沿用畫面按輪歸位的老規矩（`startsTurn`：人的話、背景子代理的結算通知與來信）。目標自己排的輪次沒有人話
 * （`apps/harness/src/conversation-history.ts`），那一輪的列會黏在前一輪後面；折疊器也沒有輪 id。
 *
 * ## 哪些條目長列、哪些不長
 *
 * | 條目 | 列 |
 * | --- | --- |
 * | 人的話、結算通知、子代理來信 | `input`／`notice`／`agent-message`，開一輪 |
 * | 模型回覆的推理、正文 | `thinking`、`reply`（空白的正文與推理都不長列，同對話區 `Entry` 的判準） |
 * | 回覆被打斷、撞輸出上限、出錯 | `ending` |
 * | 工具呼叫 | `tool`（`exit_plan_mode` 帶計劃結果；提問帶答案） |
 * | 核准的決定 | `decision` |
 * | 人答的提問 | **配得到提問卡的併進那一列**（答案優先讀工具結果文字，`AnswerEntry` 只是退路，同 `ToolCard`）；配不到的（放棄整組、舊日誌）才自己長一列 |
 * | 壓縮標記 | `compaction` |
 * | **交付檔（`deliverables`）與改動紀錄（`workspace-changes`）** | **不長列**：卡上沒列它們；交付由那顆 `present` 工具列看得到，改動紀錄只是指標。有測試釘住，免得被當成漏掉 |
 *
 * 結構化模式另外長三種不是條目的列：`call`（模型呼叫段落）、`retry`（重試）、`signal`（重複呼叫提醒、目標、計劃模式、
 * 待辦、停下來等人）。投影裡的壓縮不長列，因為對話裡那一則壓縮標記已經有一列。
 *
 * 輪的收尾（停止／失敗）除了回覆上的旗標，也讀最後一輪的 `status`：停在工具執行中被按停止的那一輪沒有「講到一半」的回覆，
 * 旗標標不到。**只有最新那一輪看得到這一格**——狀態是「現在」的事，更早的輪只剩工具卡上的失敗碼。
 *
 * @module
 */

import type {
  AgentMessageEntry,
  AiEntry,
  AnswerEntry,
  Attribution,
  CompactionEntry,
  ConversationEntry,
  ConversationState,
  DecisionEntry,
  HumanEntry,
  NoticeEntry,
  ToolEntry,
  RequestSnapshotsView,
  TrajectoryCall,
  TrajectoryDigest,
  TrajectoryEnd,
  TrajectoryTool,
  TrajectoryTurn,
  TrajectoryTurnKind,
  TrajectoryView,
} from '@nexus/wire';
import { isApprovalPending, isQuestionPending } from '@nexus/wire';

import { decisionText } from '@/lib/decision-view';
import { MAX_TOKENS_NOTICE } from '@/lib/max-tokens-view';
import { planOutcomeOf, submittedPlanOf } from '@/lib/plan-review';
import type { PlanOutcome } from '@/lib/plan-review';
import {
  ASK_USER_QUESTION,
  answersOfText,
  pairAnswers,
  questionsOf,
  questionSummary,
} from '@/lib/question-view';
import { settledNoticeText } from '@/lib/queue-view';
import { mentionDisplayText } from '@/lib/session-mention';
import { agentMessageCaption, subagentLabel, subagentNames } from '@/lib/subagent-view';
import { TODO_WRITE, todosOf, todoSummary } from '@/lib/todo-view';
import { firstLine, toolSummary, toolTitle } from '@/lib/tool-view';
import { mergePulled } from '@/lib/trajectory-pull';
import type { PulledTurn } from '@/lib/trajectory-pull';
import { ABSENT, signalText, snapshotsOf, trajectoryOf } from '@/lib/trajectory-view';
import type { SignalKind } from '@/lib/trajectory-view';
import { startsTurn } from '@/lib/turn-start';

/** 第 0 版（沒有軌跡投影）的標語與限制，**全部寫在畫面上**（卡上「必須寫在畫面上的限制」）。 */
export const TRACE_HEADLINE = '第 0 版：只有順序，沒有時間';

/** 結構化模式（有軌跡投影）的標語。 */
export const TRACE_STRUCTURED_HEADLINE = '第 1 版：照軌跡投影，帶時刻與模型呼叫';

export const TRACE_LIMITS = {
  /** 限制 1：切輪靠人那一格。 */
  turns:
    '一輪是從人說的那一句（或背景子代理的通知與來信）切開的。目標自己排的輪次沒有人話，會黏在前一輪後面；回覆的收尾標記也只認有文字的回覆。',
  /** 限制 2：決定只存本地。**測試釘住**，免得之後被當成 bug 默默「修掉」。 */
  decisions: '核准或拒絕的決定只記在這個分頁：重新整理之後看不到你當時按了什麼，只剩被拒的工具卡。',
  /** 限制 3：只看得到已載入的那幾頁。 */
  loaded: '只列出已載入的對話：更早的在對話區往上捲、載入之後才會出現在這裡。',
  /** 限制 4：今天不上線的東西。 */
  absent: '重複呼叫的提醒、重試與限流、模型每次呼叫的起訖，今天不上線，這裡看不到。',
} as const;

/**
 * 結構化模式的限制。切輪那一條拿掉；決定那一條改寫（核准的問與答已落成日誌事件，重新整理後仍在）；其餘兩條照現況改寫。
 * 鍵與第 0 版相同，所以畫面與測試用同一個 `data-limit`。
 */
export const TRACE_STRUCTURED_LIMITS = {
  decisions:
    '核准的結局（允許一次、已拒絕、已取消、無法回答）與等了多久來自軌跡，重新整理後仍在，但只有拿到細節的輪看得到（更早的輪只剩摘要，按「載入這一輪的細節」才有）；沒有結局的核准是還沒回答、或停在那裡就關掉了。問答與計劃審核的回答不在軌跡裡，政策或沒有管道擋下的核准只看得到那張工具卡的錯誤碼。',
  loaded:
    '內文只列出已載入的對話。軌跡直接帶的只有最近幾輪的逐次呼叫結構，更早的輪只剩一行摘要，按「載入這一輪的細節」向伺服器要；已載入但落在軌跡之前的對話，仍以人說的那一句切開。',
  absent:
    '時刻、模型呼叫的起訖、重試與重複呼叫的提醒來自軌跡投影，記錄它們之前的舊會話沒有這些，標「—」。子代理自己的呼叫結構在派它的那顆工具底下，展開才載入，只有結構、沒有內文；重新整理後，子代理自己的工具卡與回覆（即時串流的畫面）不在對話裡。',
} as const;

/** 找不到那一則時（沒載入、或那一則畫不出來）。說法沿用計劃分頁（`PLAN_TAB_MISSING_TEXT`）。 */
export const TRACE_TARGET_MISSING_TEXT =
  '這一則不在目前載入的對話裡。往上捲載入更早的對話，再從這裡定位。';

/** 投影有、條目沒載入的呼叫段落底下那一句。 */
/** 一次模型呼叫沒有正常回來的說法：拋錯，或使用者按了停止。 */
export const CALL_OUTCOME_LABEL = { error: '失敗', aborted: '已中止' } as const;

export const TRACE_CALL_UNLOADED_TEXT = '這次呼叫的內文不在目前載入的對話裡。';

export type EndingReason = 'stopped' | 'max-tokens' | 'blocked' | 'failed';

export const ENDING_LABEL: Readonly<Record<EndingReason, string>> = {
  stopped: '已停止',
  'max-tokens': '輸出上限',
  /** 封存的會話收到話：這一輪開了又立刻收尾，沒有送給模型（#633）。不是失敗，不畫紅。 */
  blocked: '已擋下（會話已封存）',
  failed: '失敗',
};

interface RowBase {
  /** React key；同一則條目的幾列靠後綴分開。 */
  readonly key: string;
  /**
   * 「在對話裡定位」要找的那一格：對話區 `MessageScrollerItem` 的 `messageId`，也就是條目 id。**沒有就是沒有地方可定位**
   * （配不到提問卡的答案：它自己在對話區沒有一格；投影裡的重試、提醒也沒有），那一列不畫定位鈕。
   */
  readonly target: string | undefined;
  /** 子代理那幾列帶歸屬；root 的沒有。 */
  readonly attribution?: Attribution;
}

/** 一份請求快照在這次呼叫上的狀態：呼叫沒記指向哪一份、指到的已不保留、或還在。 */
export type SnapshotState = 'none' | 'gone' | 'kept';

/** 這份快照為什麼被記：第一次記，或內容變了（`request/system`、`request/header` 的 `reason`）。 */
export type SnapshotReason = 'initial' | 'change';

export type TraceRow =
  | (RowBase & { readonly kind: 'input'; readonly entry: HumanEntry; readonly summary: string })
  | (RowBase & { readonly kind: 'notice'; readonly entry: NoticeEntry; readonly summary: string })
  | (RowBase & {
      readonly kind: 'agent-message';
      readonly entry: AgentMessageEntry;
      readonly caption: string;
      readonly summary: string;
    })
  | (RowBase & { readonly kind: 'thinking'; readonly entry: AiEntry; readonly text: string })
  | (RowBase & { readonly kind: 'reply'; readonly entry: AiEntry; readonly summary: string })
  | (RowBase & {
      readonly kind: 'tool';
      readonly entry: ToolEntry;
      readonly title: string;
      readonly summary: string;
      /** 交出計劃那一顆的審核結果；別的工具、還在等、或沒走審核的沒有。 */
      readonly outcome?: PlanOutcome;
      /** 配到這張提問卡的本地答案（`pairAnswers`），展開的那張卡要讀它當退路。 */
      readonly answer?: AnswerEntry;
      /** 結構化模式才有：`tool/call` 的時刻與配對結果的耗時（取自投影，不取條目）。 */
      readonly time?: number;
      readonly durationMs?: number;
      /** 這顆工具派出的子代理（`runId`）：展開它的呼叫結構要用。 */
      readonly subagentRunId?: string;
    })
  | (RowBase & {
      readonly kind: 'decision';
      readonly entry: DecisionEntry;
      readonly summary: string;
    })
  | (RowBase & { readonly kind: 'answer'; readonly entry: AnswerEntry; readonly summary: string })
  | (RowBase & { readonly kind: 'compaction'; readonly entry: CompactionEntry })
  | (RowBase & {
      readonly kind: 'ending';
      readonly reason: EndingReason;
      readonly summary: string;
    })
  /**
   * 模型呼叫段落（結構化模式）。**只放原始值**：投影每顆事件都整份換掉，列要是抓著 view 裡的物件，`sameRow` 每個 frame 都會
   * 判成不同、整個分頁每顆事件重畫一次。
   */
  | (RowBase & {
      readonly kind: 'call';
      /** 這一輪裡第幾次呼叫（1 起，含被摺掉的）。 */
      readonly n: number;
      readonly time: number;
      readonly endTime?: number;
      readonly durationMs?: number;
      readonly model?: string;
      readonly inputTokens?: number;
      readonly outputTokens?: number;
      /** 快取分桶（#724）；缺席＝沒記，投影沒給這幾格（舊 server）整組缺席。 */
      readonly uncachedInputTokens?: number;
      readonly cacheReadTokens?: number;
      readonly cacheWriteTokens?: number;
      readonly toolCount: number;
      readonly retryCount: number;
      /** 這次呼叫沒有正常回來的方式（投影的 `TrajectoryCall.outcome`）；沒有這一格 ＝ 正常回來，或舊日誌。 */
      readonly outcome?: 'error' | 'aborted';
      readonly system: SnapshotState;
      readonly systemChars?: number;
      readonly systemTruncated?: boolean;
      readonly header: SnapshotState;
      readonly headerTools?: number;
      /** 展開要看的內容。**都是字串**：列只放原始值（見上），投影的物件每個 frame 都是新的。 */
      readonly systemText?: string;
      readonly systemReason?: SnapshotReason;
      /** 設定與工具清單（`request/header` 的 `header`）整份轉成 JSON；展開時才解析。 */
      readonly headerJson?: string;
      readonly headerReason?: SnapshotReason;
      /** 這份工具清單相對上一份留著的快照，多了哪些、少了哪些；沒有上一份、或沒變就沒有這一格。 */
      readonly toolsDiff?: string;
      /** 投影說這次呼叫有東西可看：回覆有字、有推理，或叫了工具。 */
      readonly hasContent: boolean;
      /** 有沒有任何條目歸在這次呼叫上。`hasContent` 而沒有 `loaded`，就是內文沒載入。 */
      readonly loaded: boolean;
    })
  | (RowBase & {
      readonly kind: 'retry';
      readonly retry: number;
      readonly maxRetries: number;
      readonly time: number;
      readonly code: string;
      readonly status?: number;
      readonly waitedMs?: number;
    })
  | (RowBase & {
      readonly kind: 'signal';
      readonly signal: SignalKind;
      readonly time: number;
      readonly summary: string;
    });

/** 一輪的標題。取自投影，只放原始值。 */
export interface TurnHead {
  /**
   * 第幾個**邏輯輪**（1 起）：核准後續接的 `resume` 併回它接著的那一輪、不另外編號，與 #1028 的用量折疊同一套（兩個分頁的輪才對得上）。
   * 投影的 `index` 把每顆 `turn/start` 都算進去、含 `resume`，所以不能直接拿來當編號。`omitted` 裡看不到的輪當成都是邏輯輪，
   * 超過窗口與摘要（約 200 輪）的長會話裡，編號可能比實際大一點（被省略的續接輪無從得知）。
   */
  readonly number: number;
  readonly kind: TrajectoryTurnKind;
  readonly time: number;
  readonly end?: TrajectoryEnd;
  /**
   * `end` 是 `failed` 時，日誌帶了哪一類失敗碼（`TrajectoryDigest.failureCode`，#1121）。**缺席就是「沒記」**（舊日誌的 `turn/failed`
   * 沒有 `error`），標頭只寫「失敗」，不補成「原因不明」。
   */
  readonly failureCode?: string;
  /** 這一輪（含併進來的續接）收尾的時刻；還沒結束沒有。 */
  readonly endTime?: number;
  /** 牆鐘：第一顆 `turn/start` 到最後收尾，**含停在核准點等人的時間**（同 #1028）。 */
  readonly durationMs?: number;
  readonly callCount: number;
  readonly toolCount: number;
  readonly toolErrors: number;
  /** 這一輪（含併進來的續接）派出幾個子代理。 */
  readonly subagentCount: number;
  readonly retryCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /**
   * 快取分桶的加總（#724），規則同 `TrajectoryDigest`：缺席＝沒記。**併續接時兩段都有才相加**，只一段有的數字當成總數，
   * 命中率的分母會是錯的。
   */
  readonly uncachedInputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  /** 單輪上限摺掉的呼叫與工具數；沒摺過沒有這兩格。計數仍含它們。 */
  readonly elidedCalls?: number;
  readonly elidedTools?: number;
  /**
   * 這一輪現在停在等人：掛著核准（`approval`）或問答（`question`）。**只有最後一組、而且收尾還是 `completed`（或還沒收）時才有。**
   * 停在中斷點的那個實體輪，日誌上是照常 `turn/end`（`completed`）收的，標頭照著寫「完成」、聊天區卻寫「等待核准」（成本分頁的用量投影早有 `paused` 這一格，寫「停在核准點」），
   * 讀的人會以為這一輪做完了。續接之後核准有了結局、併回同一組，這一格就沒了，標頭照常。
   */
  readonly waiting?: 'approval' | 'question';
}

/** 窗口外那些輪只剩的一行摘要。 */
export interface TraceDigest extends TurnHead {
  readonly key: string;
  /** 開這一輪的 `turn/start` 的 `seq`（`resume` 併進來之後仍是第一段的）；成本分頁的「看這一輪」靠它找。 */
  readonly seq: number;
}

export interface TraceTurn {
  /** 這一輪第一列的 key，換對話狀態時穩定。 */
  readonly key: string;
  readonly rows: readonly TraceRow[];
  /** 結構化模式裡投影認得的輪才有；沒有結構資料的組（窗口之前、投影還沒跟上的最新條目）沒有。 */
  readonly head?: TurnHead;
  /** 這一組是以人那一句切的（第 0 版的做法），不是投影的輪界。 */
  readonly legacy: boolean;
  /** 開這一輪的 `turn/start` 的 `seq`（等於 `TokenMeterTurn.seq`）；沒有結構資料的組沒有。 */
  readonly seq?: number;
  /**
   * 這一組只有摘要的計數、沒有逐呼叫的結構：它前面有一輪的細節被拉了回來，時間順序要接得上，所以這一輪補成一組放在原位
   * （按需拉的細節見 `lib/trajectory-pull.ts`）。畫面在這一組放「載入這一輪的細節」。
   */
  readonly summaryOnly?: true;
}

export interface TraceModel {
  /** 有沒有用上軌跡投影。 */
  readonly structured: boolean;
  readonly turns: readonly TraceTurn[];
  /** 窗口外的輪，舊的在前；只剩計數。 */
  readonly digests: readonly TraceDigest[];
  /** 比 `digests` 更早、連摘要都沒留下的輪數。 */
  readonly omitted: number;
}

/** 第一個有字的那一行。人的話與回覆常以空行開頭；`firstLine` 自己會把過長的行收在 500 字元。 */
function leadLine(text: string): string {
  return firstLine(text.trimStart()).trim();
}

function attributed(attribution: Attribution): { readonly attribution?: Attribution } {
  return attribution.kind === 'root' ? {} : { attribution };
}

function toolRowText(
  entry: ToolEntry,
  answer: AnswerEntry | undefined,
): { readonly summary: string; readonly outcome?: PlanOutcome } {
  const outcome = planOutcomeOf(entry);
  if (entry.name === ASK_USER_QUESTION) {
    const questions = questionsOf(entry.input);
    if (questions !== undefined) {
      const given = answersOfText(entry.text) ?? answer?.answers;
      return { summary: questionSummary(questions, entry.status === 'done', given) };
    }
  }
  const plan = submittedPlanOf(entry);
  if (plan !== undefined) {
    return { summary: plan.title, ...(outcome === undefined ? {} : { outcome }) };
  }
  if (entry.name === TODO_WRITE) {
    const todos = todosOf(entry.input);
    if (todos !== undefined) {
      const { text, extra } = todoSummary(todos);
      return { summary: extra > 0 ? `${text}（另有 ${extra} 項進行中）` : text };
    }
  }
  return { summary: toolSummary(entry.name, entry.input) };
}

function endingRow(
  id: string,
  reason: EndingReason,
  summary: string,
  base: { readonly target: string; readonly attribution?: Attribution },
): TraceRow {
  return { kind: 'ending', key: `${id}:${reason}`, reason, summary, ...base };
}

/** 一則條目長出來的列（可能是零列），與它是不是開輪的條目。 */
interface Item {
  readonly entry: ConversationEntry;
  readonly opens: boolean;
  readonly rows: TraceRow[];
}

/** 每則條目各自長出的列。**不看投影**：第 0 版與結構化模式共用，內文永遠從條目來。 */
function itemsOf(state: ConversationState): Item[] {
  const { entries } = state;
  const answers = pairAnswers(entries);
  const consumed = new Set<AnswerEntry>(answers.values());
  const names = subagentNames(entries);
  return entries.map((entry): Item => {
    const rows: TraceRow[] = [];
    if (entry.kind === 'human') {
      rows.push({
        kind: 'input',
        key: entry.id,
        target: entry.id,
        entry,
        summary: leadLine(mentionDisplayText(entry.text)),
      });
      // 被準入閘門擋下（封存的會話，#633）：這一輪開了又立刻收，沒有模型呼叫，軌跡上就只有這句話和這一列收尾。
      if (entry.blocked === true) {
        rows.push(endingRow(entry.id, 'blocked', ENDING_LABEL.blocked, { target: entry.id }));
      }
    } else if (entry.kind === 'notice') {
      rows.push({
        kind: 'notice',
        key: entry.id,
        target: entry.id,
        entry,
        summary: settledNoticeText(entry.reason),
      });
    } else if (entry.kind === 'agent-message') {
      rows.push({
        kind: 'agent-message',
        key: entry.id,
        target: entry.id,
        entry,
        caption: agentMessageCaption(subagentLabel(names, entry.runId)),
        summary: leadLine(entry.text),
      });
    } else if (entry.kind === 'ai') {
      const base = { target: entry.id, ...attributed(entry.attribution) };
      const thinking = entry.reasoning;
      if (thinking !== undefined && thinking.trim() !== '') {
        rows.push({
          kind: 'thinking',
          key: `${entry.id}:thinking`,
          entry,
          text: thinking,
          ...base,
        });
      }
      if (entry.text.trim() !== '') {
        rows.push({
          kind: 'reply',
          key: `${entry.id}:reply`,
          entry,
          summary: leadLine(entry.text),
          ...base,
        });
      }
      if (entry.stopped === true) {
        rows.push(endingRow(entry.id, 'stopped', ENDING_LABEL.stopped, base));
      }
      if (entry.maxTokens === true) {
        rows.push(endingRow(entry.id, 'max-tokens', MAX_TOKENS_NOTICE, base));
      }
      if (entry.error !== undefined) {
        rows.push(endingRow(entry.id, 'failed', entry.error, base));
      }
    } else if (entry.kind === 'tool') {
      const answer = answers.get(entry.id);
      const { summary, outcome } = toolRowText(entry, answer);
      rows.push({
        kind: 'tool',
        key: entry.id,
        target: entry.id,
        entry,
        title: toolTitle(entry.name),
        summary,
        ...(outcome === undefined ? {} : { outcome }),
        ...(answer === undefined ? {} : { answer }),
        ...attributed(entry.attribution),
      });
    } else if (entry.kind === 'decision') {
      rows.push({
        kind: 'decision',
        key: entry.id,
        target: entry.id,
        entry,
        summary: decisionText(entry),
      });
    } else if (entry.kind === 'answer') {
      if (!consumed.has(entry)) {
        rows.push({
          kind: 'answer',
          key: entry.id,
          target: undefined,
          entry,
          summary:
            entry.declined === true
              ? '拒絕回答這些問題'
              : entry.cancelled === true
                ? '放棄回答這些問題'
                : `已回答 ${entry.answers.length} 題`,
        });
      }
    } else if (entry.kind === 'compaction') {
      rows.push({ kind: 'compaction', key: entry.id, target: entry.id, entry });
    }
    // `deliverables`、`workspace-changes`：不長列，見檔頭的表。
    return { entry, opens: startsTurn(entry), rows };
  });
}

/** 第 0 版的切法：以人那一格（`startsTurn`）切成組。 */
function legacyGroups(items: readonly Item[]): TraceTurn[] {
  const groups: { key: string; rows: TraceRow[] }[] = [];
  let current: { key: string; rows: TraceRow[] } | undefined;
  for (const item of items) {
    const [first] = item.rows;
    if (first === undefined) continue;
    if (item.opens || current === undefined) {
      current = { key: first.key, rows: [] };
      groups.push(current);
    }
    current.rows.push(...item.rows);
  }
  return groups.map((group) => ({ ...group, legacy: true }));
}

/** 投影裡一個條目歸在哪一輪、哪一次呼叫（`call` 缺席＝歸不到呼叫，投影的 `looseTools` 就是這樣）。 */
interface Slot {
  readonly turn: number;
  readonly call: number | undefined;
}

interface ToolFact {
  readonly time: number;
  readonly durationMs: number | undefined;
  readonly subagentRunId: string | undefined;
}

interface ViewIndex {
  readonly slots: ReadonlyMap<string, Slot>;
  readonly tools: ReadonlyMap<string, ToolFact>;
}

/** 條目鍵 → 位置。鍵的形狀見檔頭的表。 */
function toolFact(tool: TrajectoryTool): ToolFact {
  return {
    time: tool.time,
    durationMs: tool.durationMs,
    subagentRunId: tool.subagent?.runId,
  };
}

function indexView(view: TrajectoryView): ViewIndex {
  const slots = new Map<string, Slot>();
  const tools = new Map<string, ToolFact>();
  view.turns.forEach((turn, t) => {
    turn.calls.forEach((call, c) => {
      const { reply } = call;
      if (reply !== undefined) {
        if (reply.messageId !== undefined)
          slots.set(`message:${reply.messageId}`, { turn: t, call: c });
        slots.set(`history-${reply.seq}`, { turn: t, call: c });
      }
      for (const tool of call.tools) {
        slots.set(`tool-${tool.callId}`, { turn: t, call: c });
        tools.set(`tool-${tool.callId}`, toolFact(tool));
      }
    });
    for (const tool of turn.looseTools) {
      slots.set(`tool-${tool.callId}`, { turn: t, call: undefined });
      tools.set(`tool-${tool.callId}`, toolFact(tool));
    }
  });
  return { slots, tools };
}

function directSlot(entry: ConversationEntry, index: ViewIndex): Slot | undefined {
  if (entry.kind === 'tool') return index.slots.get(entry.id);
  if (entry.kind === 'ai') {
    const byMessage =
      entry.messageId === undefined ? undefined : index.slots.get(`message:${entry.messageId}`);
    return byMessage ?? index.slots.get(entry.id);
  }
  return undefined;
}

/**
 * 每則條目歸到哪一輪、哪一次呼叫。`undefined` ＝ 不在投影的任何一輪裡（窗口之前，或投影還沒跟上的最新條目），
 * 由第 0 版的切法接手。規則見檔頭。
 */
function assignSlots(
  entries: readonly ConversationEntry[],
  view: TrajectoryView,
  index: ViewIndex,
): (Slot | undefined)[] {
  const direct = entries.map((entry) => directSlot(entry, index));
  const unmappedContent = (entry: ConversationEntry) =>
    (entry.kind === 'ai' || entry.kind === 'tool') && entry.attribution.kind === 'root';
  // 每則條目「後面第一個歸得進去的條目」在哪一輪。**中間隔著歸不進去的 root 回覆或工具，就不算**：那幾則自己屬於別的組
  // （窗口之前的舊對話：人話後面跟著一串不在投影裡的回覆），不能把人話硬拉進後面那一輪。
  const nextTurn: (number | undefined)[] = new Array<number | undefined>(entries.length);
  let upcoming: number | undefined;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    nextTurn[i] = upcoming;
    const slot = direct[i];
    if (slot !== undefined) upcoming = slot.turn;
    else if (unmappedContent(entries[i]!)) upcoming = undefined;
  }
  const lastTurn = view.turns.length - 1;
  const lastTurnHasMember = direct.some((slot) => slot?.turn === lastTurn);
  const lastDirect = direct.findLastIndex((slot) => slot !== undefined);
  const lastOpener = entries.findLastIndex(startsTurn);
  /**
   * 投影還沒跟上的最新一句：最新那一輪已開（`turn/start` 先於人話之外的任何事進日誌）、還沒有成員、還沒結束，而且這一句
   * 是整份對話最後一個開輪條目、排在所有歸得進去的條目之後。**只有最後那一句**能認領：更早的沒有鍵的人話是窗口之前的舊對話。
   */
  const claimable =
    lastTurn >= 0 &&
    view.turns[lastTurn]?.end === undefined &&
    !lastTurnHasMember &&
    lastOpener > lastDirect;
  /** 還在跑的那次呼叫：這一輪最後一次、而且回覆還沒進日誌。 */
  const inFlight = (turn: number): number | undefined => {
    const calls = view.turns[turn]?.calls ?? [];
    const last = calls.length - 1;
    return last >= 0 && calls[last]?.reply === undefined ? last : undefined;
  };
  const out: (Slot | undefined)[] = [];
  let current: Slot | undefined;
  entries.forEach((entry, i) => {
    const slot = direct[i];
    if (slot !== undefined) {
      current = slot;
    } else if (startsTurn(entry)) {
      const next = nextTurn[i];
      if (next !== undefined) {
        // 同一輪裡插進來的（人插話、子代理來信）留在原位，不退回那一輪的開頭。
        if (current?.turn !== next) current = { turn: next, call: undefined };
      } else if (claimable && i === lastOpener) {
        current = { turn: lastTurn, call: undefined };
      } else {
        current = undefined;
      }
    } else if (
      current !== undefined &&
      (entry.kind === 'ai' || entry.kind === 'tool') &&
      entry.attribution.kind === 'root'
    ) {
      // 還在吐字的回覆、還在跑的工具：歸給這一輪還在進行的那次呼叫（不只是第一次），免得回覆落地時列從段落上方跳到下方。
      const call = inFlight(current.turn);
      if (call !== undefined && (current.call === undefined || call > current.call)) {
        current = { turn: current.turn, call };
      }
    }
    out.push(current);
  });
  return out;
}

/** 投影的 turn/start seq → 第幾個邏輯輪，見 {@link TurnHead.number}。 */
function logicalNumbers(view: TrajectoryView): ReadonlyMap<number, number> {
  const numbers = new Map<number, number>();
  let count = view.omitted;
  for (const item of [...view.digests, ...view.turns]) {
    if (item.logical) count += 1;
    numbers.set(item.seq, Math.max(count, 1));
  }
  return numbers;
}

interface BucketFields {
  readonly uncachedInputTokens?: number | undefined;
  readonly cacheReadTokens?: number | undefined;
  readonly cacheWriteTokens?: number | undefined;
}

/** 三格快取分桶：缺席的不放進去（列只放有的原始值，`sameRow` 逐欄 `===`）。 */
function bucketFields(source: BucketFields): BucketFields {
  return {
    ...(source.uncachedInputTokens === undefined
      ? {}
      : { uncachedInputTokens: source.uncachedInputTokens }),
    ...(source.cacheReadTokens === undefined ? {} : { cacheReadTokens: source.cacheReadTokens }),
    ...(source.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: source.cacheWriteTokens }),
  };
}

/** 併續接時的桶：兩段都有才加，缺一段就是沒記。 */
function addBucket(left: number | undefined, right: number | undefined): number | undefined {
  return left === undefined || right === undefined ? undefined : left + right;
}

function headOf(digest: TrajectoryDigest, number: number): TurnHead {
  return {
    number,
    kind: digest.kind,
    time: digest.time,
    callCount: digest.callCount,
    toolCount: digest.toolCount,
    toolErrors: digest.toolErrors,
    subagentCount: digest.subagentCount,
    retryCount: digest.retryCount,
    inputTokens: digest.inputTokens,
    outputTokens: digest.outputTokens,
    ...bucketFields(digest),
    ...(digest.end === undefined ? {} : { end: digest.end }),
    ...(digest.failureCode === undefined ? {} : { failureCode: digest.failureCode }),
    ...(digest.endTime === undefined ? {} : { endTime: digest.endTime }),
    ...(digest.durationMs === undefined ? {} : { durationMs: digest.durationMs }),
  };
}

/** 把接在後面的 `resume` 併進它接著的那一輪：計數相加，收尾取最後一段，牆鐘從第一段開始算（含等人核准）。 */
function mergeHead(first: TurnHead, resume: TurnHead): TurnHead {
  const elidedCalls = (first.elidedCalls ?? 0) + (resume.elidedCalls ?? 0);
  const elidedTools = (first.elidedTools ?? 0) + (resume.elidedTools ?? 0);
  return {
    number: first.number,
    kind: first.kind,
    time: first.time,
    callCount: first.callCount + resume.callCount,
    toolCount: first.toolCount + resume.toolCount,
    toolErrors: first.toolErrors + resume.toolErrors,
    subagentCount: first.subagentCount + resume.subagentCount,
    retryCount: first.retryCount + resume.retryCount,
    inputTokens: first.inputTokens + resume.inputTokens,
    outputTokens: first.outputTokens + resume.outputTokens,
    ...bucketFields({
      uncachedInputTokens: addBucket(first.uncachedInputTokens, resume.uncachedInputTokens),
      cacheReadTokens: addBucket(first.cacheReadTokens, resume.cacheReadTokens),
      cacheWriteTokens: addBucket(first.cacheWriteTokens, resume.cacheWriteTokens),
    }),
    ...(resume.end === undefined ? {} : { end: resume.end }),
    ...(resume.failureCode === undefined ? {} : { failureCode: resume.failureCode }),
    ...(resume.endTime === undefined
      ? {}
      : { endTime: resume.endTime, durationMs: resume.endTime - first.time }),
    ...(elidedCalls > 0 ? { elidedCalls } : {}),
    ...(elidedTools > 0 ? { elidedTools } : {}),
  };
}

/** 摘要或輪的標題清單：`resume` 併回前一項（清單第一項若是 `resume`，它的前一輪在清單之外，原樣留著）。 */
function foldResumes<T extends { readonly head: TurnHead; readonly logical: boolean }>(
  items: readonly T[],
): T[] {
  const out: T[] = [];
  for (const item of items) {
    const previous = out.at(-1);
    if (!item.logical && previous !== undefined) {
      out[out.length - 1] = { ...previous, head: mergeHead(previous.head, item.head) };
    } else {
      out.push(item);
    }
  }
  return out;
}

type SnapshotParts = Pick<
  Extract<TraceRow, { kind: 'call' }>,
  | 'system'
  | 'systemChars'
  | 'systemTruncated'
  | 'systemText'
  | 'systemReason'
  | 'header'
  | 'headerTools'
  | 'headerJson'
  | 'headerReason'
  | 'toolsDiff'
>;

function toolNamesOf(header: unknown): string[] | undefined {
  if (typeof header !== 'object' || header === null) return undefined;
  const { tools } = header as { tools?: unknown };
  if (!Array.isArray(tools)) return undefined;
  return tools.map((tool) =>
    typeof tool === 'object' &&
    tool !== null &&
    typeof (tool as { name?: unknown }).name === 'string'
      ? (tool as { name: string }).name
      : ABSENT,
  );
}

/** 「新增 a、b；移除 c」；兩份的名字集合相同就是 `undefined`。 */
function toolsDiffText(before: readonly string[], after: readonly string[]): string | undefined {
  const added = after.filter((name) => !before.includes(name));
  const removed = before.filter((name) => !after.includes(name));
  if (added.length === 0 && removed.length === 0) return undefined;
  return [
    added.length === 0 ? undefined : `新增 ${added.join('、')}`,
    removed.length === 0 ? undefined : `移除 ${removed.join('、')}`,
  ]
    .filter((part) => part !== undefined)
    .join('；');
}

/**
 * 呼叫列上的請求快照部分的產生器。**一份快照在一次建模型裡只轉一次 JSON**（一輪可以有幾十次呼叫，它們指到同一份）：
 * 整份清單帶每個工具的說明與參數，常有二十幾 KB。
 */
function snapshotPartsOf(
  snapshots: ReturnType<typeof snapshotsOf>,
): (call: TrajectoryView['turns'][number]['calls'][number]) => SnapshotParts {
  const json = new Map<number, string>();
  const jsonOf = (seq: number, header: unknown): string => {
    let text = json.get(seq);
    if (text === undefined) {
      text = JSON.stringify(header) ?? 'null';
      json.set(seq, text);
    }
    return text;
  };
  return (call) => {
    const system =
      call.system === undefined ? undefined : snapshots?.system.find((s) => s.seq === call.system);
    const header =
      call.header === undefined ? undefined : snapshots?.header.find((s) => s.seq === call.header);
    const tools = toolNamesOf(header?.header);
    const previous =
      header === undefined ? undefined : snapshots?.header.filter((s) => s.seq < header.seq).at(-1);
    const before = previous === undefined ? undefined : toolNamesOf(previous.header);
    const diff =
      tools === undefined || before === undefined ? undefined : toolsDiffText(before, tools);
    return {
      system: call.system === undefined ? 'none' : system === undefined ? 'gone' : 'kept',
      header: call.header === undefined ? 'none' : header === undefined ? 'gone' : 'kept',
      ...(system === undefined ? {} : { systemChars: system.chars }),
      ...(system?.truncated === true ? { systemTruncated: true } : {}),
      ...(system === undefined ? {} : { systemText: system.text, systemReason: system.reason }),
      ...(tools === undefined ? {} : { headerTools: tools.length }),
      ...(header === undefined
        ? {}
        : { headerJson: jsonOf(header.seq, header.header), headerReason: header.reason }),
      ...(diff === undefined ? {} : { toolsDiff: diff }),
    };
  };
}

/** 一次模型呼叫的段落列。root 的與子代理的共用：`loaded` 是「有沒有條目歸在這次呼叫上」。 */
function callRowOf(
  call: TrajectoryCall,
  options: {
    readonly n: number;
    readonly target: string | undefined;
    readonly loaded: boolean;
    readonly snapshotParts: (call: TrajectoryCall) => SnapshotParts;
  },
): Extract<TraceRow, { kind: 'call' }> {
  return {
    kind: 'call',
    key: `call-${call.id}`,
    target: options.target,
    n: options.n,
    time: call.time,
    toolCount: call.tools.length,
    retryCount: call.retries.length,
    loaded: options.loaded,
    hasContent:
      call.tools.length > 0 ||
      (call.reply !== undefined && call.reply.textChars + call.reply.reasoningChars > 0),
    ...(call.endTime === undefined ? {} : { endTime: call.endTime }),
    ...(call.durationMs === undefined ? {} : { durationMs: call.durationMs }),
    ...(call.outcome === undefined ? {} : { outcome: call.outcome }),
    ...(call.model === undefined ? {} : { model: call.model }),
    ...(call.usage === undefined
      ? {}
      : {
          inputTokens: call.usage.inputTokens,
          outputTokens: call.usage.outputTokens,
          ...bucketFields(call.usage),
        }),
    ...options.snapshotParts(call),
  };
}

/** 子代理一輪的摘要（還沒拉細節）的標題。 */
export function subagentDigestHead(digest: TrajectoryDigest): TurnHead {
  return headOf(digest, 1);
}

/** 子代理的一次呼叫：呼叫段落列、它的重試、它叫的工具（只有結構，沒有內文）。 */
export interface SubagentCallView {
  readonly row: Extract<TraceRow, { kind: 'call' }>;
  readonly retries: readonly Extract<TraceRow, { kind: 'retry' }>[];
  readonly tools: readonly SubagentToolView[];
}

export interface SubagentToolView {
  readonly key: string;
  readonly name: string;
  readonly status: TrajectoryTool['status'];
  readonly time: number;
  readonly durationMs?: number;
  readonly code?: string;
}

/** 子代理的一輪（或一份前景子代理的整段執行）：標題與逐次呼叫。 */
export interface SubagentTurnView {
  readonly seq: number;
  readonly head: TurnHead;
  /** 單輪上限摺掉的呼叫數；沒摺過沒有這一格。 */
  readonly elidedCalls?: number;
  readonly calls: readonly SubagentCallView[];
}

/**
 * 一個子代理的一輪轉成畫面要的形狀。**只放原始值**（理由同 `call` 那一列）；快照讀子代理自己的 `request-snapshots`
 * （`system`／`header` 指的是它自己日誌的位置）。呼叫的 `loaded` 一律是真的：子代理的內文不在這條路上，沒有「內文沒載入」可講。
 */
export function subagentTurnView(
  turn: TrajectoryTurn,
  snapshots: RequestSnapshotsView | undefined,
): SubagentTurnView {
  const snapshotParts = snapshotPartsOf(snapshots);
  const skipped = turn.elided?.calls ?? 0;
  return {
    seq: turn.seq,
    head: headOf(turn, 1),
    ...(skipped === 0 ? {} : { elidedCalls: skipped }),
    calls: turn.calls.map((call, c) => ({
      row: callRowOf(call, { n: skipped + c + 1, target: undefined, loaded: true, snapshotParts }),
      retries: call.retries.map((retry) => ({
        kind: 'retry' as const,
        key: `retry-${call.id}-${retry.retry}`,
        target: undefined,
        retry: retry.retry,
        maxRetries: retry.maxRetries,
        time: retry.time,
        code: retry.code,
        ...(retry.status === undefined ? {} : { status: retry.status }),
        ...(retry.waitedMs === undefined ? {} : { waitedMs: retry.waitedMs }),
      })),
      tools: call.tools.map((tool) => ({
        key: tool.callId,
        name: tool.name,
        status: tool.status,
        time: tool.time,
        ...(tool.durationMs === undefined ? {} : { durationMs: tool.durationMs }),
        ...(tool.code === undefined ? {} : { code: tool.code }),
      })),
    })),
  };
}

/** 結構化模式：條目歸進投影的輪與呼叫，再把投影的結構列（呼叫、重試、提醒）照順序插進去。 */
function structuredTurns(
  state: ConversationState,
  allItems: readonly Item[],
  view: TrajectoryView,
  placeholders: ReadonlySet<number>,
): TraceModel {
  const answered = answeredApprovals(view);
  // 軌跡已經有這顆核准的結局（工具名、結局、等多久）：本地那一列說的是同一件事，留著就是同一個決定出現兩次。
  // 只擋「一個動作」的決定：一顆中斷若同時問了好幾個動作，軌跡那一格只有一個工具名，本地那一列才說得全。
  const items = allItems.filter(
    ({ entry }) =>
      !(entry.kind === 'decision' && entry.actions.length === 1 && answered.has(entry.id)),
  );
  const index = indexView(view);
  const snapshotParts = snapshotPartsOf(snapshotsOf(state));
  const slots = assignSlots(
    items.map((item) => item.entry),
    view,
    index,
  );

  // 歸位：每輪一個「開頭」袋（呼叫之前的列）、每次呼叫一個袋。
  const pre = view.turns.map(() => [] as TraceRow[]);
  const byCall = view.turns.map((turn) => turn.calls.map(() => [] as TraceRow[]));
  const callTarget = view.turns.map((turn) => turn.calls.map((): string | undefined => undefined));
  const leading: Item[] = [];
  const trailing: Item[] = [];
  let seenSlot = false;
  const anyMapped = slots.some((slot) => slot !== undefined);
  items.forEach((item, i) => {
    const slot = slots[i];
    if (slot === undefined) {
      // 一則都歸不進去時，已載入的是最新的幾頁、比投影的窗口新（投影還沒跟上），所以算在後面。
      (seenSlot || !anyMapped ? trailing : leading).push(item);
      return;
    }
    seenSlot = true;
    const rows = item.rows.map((row) => withToolFact(row, index));
    const bag = slot.call === undefined ? pre[slot.turn] : byCall[slot.turn]?.[slot.call];
    bag?.push(...rows);
    if (slot.call !== undefined && item.entry.kind === 'ai') {
      const targets = callTarget[slot.turn];
      if (targets !== undefined && targets[slot.call] === undefined)
        targets[slot.call] = item.entry.id;
    }
  });

  const numbers = logicalNumbers(view);
  const groups: {
    key: string;
    seq: number;
    rows: TraceRow[];
    head: TurnHead;
    summaryOnly: boolean;
  }[] = [];
  view.turns.forEach((turn, t) => {
    // `resume`（核准後續接）併回前一個邏輯輪：同一輪、同一組，編號不加。
    const previous = groups.at(-1);
    const merging = !turn.logical && previous !== undefined;
    const callBase = merging ? previous.head.callCount : 0;
    const rows: TraceRow[] = [...(pre[t] ?? [])];
    const skipped = turn.elided?.calls ?? 0;
    const decisions = turn.decisions.filter((d) => d.kind !== 'compaction');
    let next = 0;
    const flushSignals = (before: number) => {
      while (next < decisions.length && (decisions[next]?.seq ?? 0) < before) {
        const decision = decisions[next];
        next += 1;
        if (decision === undefined) continue;
        rows.push({
          kind: 'signal',
          key: `signal-${decision.seq}`,
          target: undefined,
          signal: decision.kind,
          time: decision.time,
          summary: signalText(decision),
        });
      }
    };
    turn.calls.forEach((call, c) => {
      flushSignals(call.id);
      const loadedRows = byCall[t]?.[c] ?? [];
      rows.push(
        callRowOf(call, {
          n: callBase + skipped + c + 1,
          target: callTarget[t]?.[c],
          loaded: loadedRows.length > 0,
          snapshotParts,
        }),
      );
      for (const retry of call.retries) {
        rows.push({
          kind: 'retry',
          key: `retry-${call.id}-${retry.retry}`,
          target: undefined,
          retry: retry.retry,
          maxRetries: retry.maxRetries,
          time: retry.time,
          code: retry.code,
          ...(retry.status === undefined ? {} : { status: retry.status }),
          ...(retry.waitedMs === undefined ? {} : { waitedMs: retry.waitedMs }),
        });
      }
      for (const row of loadedRows) {
        // 人的核准、人的答案是對「停下來等人」的回答：把還沒排進去的那幾顆停下來的提醒先放在它前面。
        if (row.kind === 'decision' || row.kind === 'answer') {
          const lastInterrupt = decisions.findLastIndex(
            (d, i) => i >= next && d.kind === 'interrupt',
          );
          if (lastInterrupt >= 0) flushSignals((decisions[lastInterrupt]?.seq ?? 0) + 1);
        }
        rows.push(row);
      }
    });
    flushSignals(Number.POSITIVE_INFINITY);
    const elidedTools = turn.elided?.tools;
    const head: TurnHead = {
      ...headOf(turn, numbers.get(turn.seq) ?? 1),
      ...(skipped > 0 ? { elidedCalls: skipped } : {}),
      ...(elidedTools !== undefined && elidedTools > 0 ? { elidedTools } : {}),
    };
    const summaryOnly = placeholders.has(turn.seq);
    if (merging) {
      previous.rows.push(...rows);
      previous.head = mergeHead(previous.head, head);
      previous.summaryOnly = previous.summaryOnly && summaryOnly;
    } else {
      groups.push({ key: `turn-${turn.seq}`, seq: turn.seq, rows, head, summaryOnly });
    }
  });
  const turns: TraceTurn[] = groups.map(({ summaryOnly, ...group }) => ({
    ...group,
    legacy: false,
    ...(summaryOnly ? { summaryOnly: true as const } : {}),
  }));

  return {
    structured: true,
    turns: [...legacyGroups(leading), ...turns, ...legacyGroups(trailing)],
    digests: foldResumes(
      view.digests.map((digest) => ({
        head: headOf(digest, numbers.get(digest.seq) ?? 1),
        logical: digest.logical,
        key: `digest-${digest.index}`,
        seq: digest.seq,
      })),
    ).map(({ head, key, seq }) => ({ ...head, key, seq })),
    omitted: view.omitted,
  };
}

/** 軌跡裡已經有結局的核准中斷，換算成本地決定列的 id（`decision-<中斷 id>`）。 */
function answeredApprovals(view: TrajectoryView): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const turn of view.turns)
    for (const decision of turn.decisions)
      if (
        decision.kind === 'interrupt' &&
        decision.id !== undefined &&
        decision.approval?.outcome !== undefined
      )
        ids.add(`decision-${decision.id}`);
  return ids;
}

function withToolFact(row: TraceRow, index: ViewIndex): TraceRow {
  if (row.kind !== 'tool') return row;
  const fact = index.tools.get(row.entry.id);
  if (fact === undefined) return row;
  return {
    ...row,
    time: fact.time,
    ...(fact.durationMs === undefined ? {} : { durationMs: fact.durationMs }),
    ...(fact.subagentRunId === undefined ? {} : { subagentRunId: fact.subagentRunId }),
  };
}

/** 最新那一組的收尾：回覆上的旗標標不到的（停在工具執行中被停止、整輪失敗）讀 `status`。 */
function closeWithStatus(rows: TraceRow[], state: ConversationState): void {
  const reason: EndingReason | undefined =
    state.status === 'stopped' ? 'stopped' : state.status === 'failed' ? 'failed' : undefined;
  const lastRow = rows.at(-1);
  if (reason === undefined || lastRow === undefined) return;
  if (rows.some((row) => row.kind === 'ending' && row.reason === reason)) return;
  rows.push({
    kind: 'ending',
    key: `status:${reason}`,
    target: lastRow.target,
    reason,
    summary: reason === 'failed' && state.error !== undefined ? state.error : ENDING_LABEL[reason],
  });
}

/**
 * 對話投成一輪一組的列，以及（結構化模式）窗口外那些輪的摘要。純函式，只看 `state` 與選配的、按需拉回來的輪（`lib/trajectory-pull.ts`）。
 *
 * 子代理的歸屬原樣帶著（`attribution`）；同一輪裡主對話與子代理的列照出現的先後交錯。
 */
export function traceModel(
  state: ConversationState,
  pulled?: ReadonlyMap<number, PulledTurn>,
): TraceModel {
  const items = itemsOf(state);
  const pushed = trajectoryOf(state);
  const merged =
    pushed === undefined
      ? undefined
      : pulled === undefined
        ? { view: pushed, placeholders: new Set<number>() }
        : mergePulled(pushed, pulled);
  const model: TraceModel =
    merged === undefined
      ? { structured: false, turns: legacyGroups(items), digests: [], omitted: 0 }
      : structuredTurns(state, items, merged.view, merged.placeholders);
  const last = model.turns.at(-1);
  if (last !== undefined) {
    const rows = [...last.rows];
    closeWithStatus(rows, state);
    const waiting = last.head === undefined ? undefined : waitingOf(state, last.head);
    if (rows.length !== last.rows.length || waiting !== undefined) {
      const next = {
        ...last,
        rows,
        ...(waiting === undefined || last.head === undefined
          ? {}
          : { head: { ...last.head, waiting } }),
      };
      return { ...model, turns: [...model.turns.slice(0, -1), next] };
    }
  }
  return model;
}

/**
 * 最後一組現在是不是停在等人：掛著中斷，而且這一組的收尾是 `completed` 或還沒收。`aborted`、`failed` 那些是真的結束了，
 * 不會還在等。核准優先於問答：兩種同時掛著時，狀態列也是先講核准。
 */
function waitingOf(state: ConversationState, head: TurnHead): TurnHead['waiting'] {
  if (head.end !== undefined && head.end !== 'completed') return undefined;
  if (state.pendings.some(isApprovalPending)) return 'approval';
  if (state.pendings.some(isQuestionPending)) return 'question';
  return undefined;
}

/**
 * 一則回覆（訊息 id）落在哪一輪：回那一組的 `seq`（`TokenMeterTurn.seq`、`reveal` 的鍵）。
 * 答不出就 `undefined`：條目不在這份對話裡、那一則歸不進投影的輪（窗口之前、投影還沒跟上）、或沒有軌跡投影（第 0 版的組沒有 `seq`）。
 * 續接併回前一輪的組，所以續接之後那一則的答案是併起來那一組。
 */
export function turnSeqOfMessage(
  model: TraceModel,
  entries: readonly ConversationEntry[],
  messageId: string,
): number | undefined {
  const entry = entries.find((e) => e.kind === 'ai' && e.messageId === messageId);
  if (entry === undefined) return undefined;
  return model.turns.find(
    (turn) => turn.seq !== undefined && turn.rows.some((row) => row.target === entry.id),
  )?.seq;
}

/** {@link traceModel} 的輪。 */
export function traceTurns(state: ConversationState): readonly TraceTurn[] {
  return traceModel(state).turns;
}

/**
 * 兩列畫出來會一樣嗎：每個欄位 `===`。條目沒變時折疊器留著同一個參照，所以沒動的列判得出來——串流中每一格只有正在長的
 * 那幾列要重畫，其餘的 `memo` 擋掉。投影的列只放原始值，理由見 `call` 那一列。
 */
export function sameRow(a: TraceRow, b: TraceRow): boolean {
  const left = a as unknown as Record<string, unknown>;
  const right = b as unknown as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}

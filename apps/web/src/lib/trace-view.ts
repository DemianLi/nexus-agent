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
 *   窗口更早的輪只剩 `digests` 的計數，畫成只有數字的摘要列。
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
  TrajectoryDigest,
  TrajectoryEnd,
  TrajectoryTurnKind,
  TrajectoryView,
} from '@nexus/wire';

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
import { signalText, snapshotsOf, trajectoryOf } from '@/lib/trajectory-view';
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
 * 結構化模式的限制。**決定那一條原樣留著**（#1029 還沒合，行為沒變，測試仍釘住它）；切輪那一條拿掉；其餘兩條照現況改寫。
 * 鍵與第 0 版相同，所以畫面與測試用同一個 `data-limit`。
 */
export const TRACE_STRUCTURED_LIMITS = {
  decisions: TRACE_LIMITS.decisions,
  loaded:
    '內文只列出已載入的對話。軌跡只帶最近幾輪的逐次呼叫結構，更早的輪只剩一行摘要；已載入但落在窗口之前的對話，仍以人說的那一句切開。',
  absent:
    '時刻、模型呼叫的起訖、重試與重複呼叫的提醒來自軌跡投影，記錄它們之前的舊會話沒有這些，標「—」。子代理自己的呼叫結構今天沒有。',
} as const;

/** 找不到那一則時（沒載入、或那一則畫不出來）。說法沿用計劃分頁（`PLAN_TAB_MISSING_TEXT`）。 */
export const TRACE_TARGET_MISSING_TEXT =
  '這一則不在目前載入的對話裡。往上捲載入更早的對話，再從這裡定位。';

/** 投影有、條目沒載入的呼叫段落底下那一句。 */
export const TRACE_CALL_UNLOADED_TEXT = '這次呼叫的內文不在目前載入的對話裡。';

export type EndingReason = 'stopped' | 'max-tokens' | 'failed';

export const ENDING_LABEL: Readonly<Record<EndingReason, string>> = {
  stopped: '已停止',
  'max-tokens': '輸出上限',
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
      readonly toolCount: number;
      readonly retryCount: number;
      readonly system: SnapshotState;
      readonly systemChars?: number;
      readonly systemTruncated?: boolean;
      readonly header: SnapshotState;
      readonly headerTools?: number;
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
  /** 這一輪（含併進來的續接）收尾的時刻；還沒結束沒有。 */
  readonly endTime?: number;
  /** 牆鐘：第一顆 `turn/start` 到最後收尾，**含停在核准點等人的時間**（同 #1028）。 */
  readonly durationMs?: number;
  readonly callCount: number;
  readonly toolCount: number;
  readonly toolErrors: number;
  readonly retryCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** 單輪上限摺掉的呼叫與工具數；沒摺過沒有這兩格。計數仍含它們。 */
  readonly elidedCalls?: number;
  readonly elidedTools?: number;
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
            entry.cancelled === true ? '放棄回答這些問題' : `已回答 ${entry.answers.length} 題`,
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
}

interface ViewIndex {
  readonly slots: ReadonlyMap<string, Slot>;
  readonly tools: ReadonlyMap<string, ToolFact>;
}

/** 條目鍵 → 位置。鍵的形狀見檔頭的表。 */
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
        tools.set(`tool-${tool.callId}`, { time: tool.time, durationMs: tool.durationMs });
      }
    });
    for (const tool of turn.looseTools) {
      slots.set(`tool-${tool.callId}`, { turn: t, call: undefined });
      tools.set(`tool-${tool.callId}`, { time: tool.time, durationMs: tool.durationMs });
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

function headOf(digest: TrajectoryDigest, number: number): TurnHead {
  return {
    number,
    kind: digest.kind,
    time: digest.time,
    callCount: digest.callCount,
    toolCount: digest.toolCount,
    toolErrors: digest.toolErrors,
    retryCount: digest.retryCount,
    inputTokens: digest.inputTokens,
    outputTokens: digest.outputTokens,
    ...(digest.end === undefined ? {} : { end: digest.end }),
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
    retryCount: first.retryCount + resume.retryCount,
    inputTokens: first.inputTokens + resume.inputTokens,
    outputTokens: first.outputTokens + resume.outputTokens,
    ...(resume.end === undefined ? {} : { end: resume.end }),
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

function snapshotRowParts(
  call: TrajectoryView['turns'][number]['calls'][number],
  snapshots: ReturnType<typeof snapshotsOf>,
): Pick<
  Extract<TraceRow, { kind: 'call' }>,
  'system' | 'systemChars' | 'systemTruncated' | 'header' | 'headerTools'
> {
  const system =
    call.system === undefined ? undefined : snapshots?.system.find((s) => s.seq === call.system);
  const header =
    call.header === undefined ? undefined : snapshots?.header.find((s) => s.seq === call.header);
  const tools =
    header !== undefined &&
    typeof header.header === 'object' &&
    header.header !== null &&
    Array.isArray((header.header as { tools?: unknown }).tools)
      ? (header.header as { tools: unknown[] }).tools.length
      : undefined;
  return {
    system: call.system === undefined ? 'none' : system === undefined ? 'gone' : 'kept',
    header: call.header === undefined ? 'none' : header === undefined ? 'gone' : 'kept',
    ...(system === undefined ? {} : { systemChars: system.chars }),
    ...(system?.truncated === true ? { systemTruncated: true } : {}),
    ...(tools === undefined ? {} : { headerTools: tools }),
  };
}

/** 結構化模式：條目歸進投影的輪與呼叫，再把投影的結構列（呼叫、重試、提醒）照順序插進去。 */
function structuredTurns(
  state: ConversationState,
  items: readonly Item[],
  view: TrajectoryView,
): TraceModel {
  const index = indexView(view);
  const snapshots = snapshotsOf(state);
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
  const groups: { key: string; seq: number; rows: TraceRow[]; head: TurnHead }[] = [];
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
      rows.push({
        kind: 'call',
        key: `call-${call.id}`,
        target: callTarget[t]?.[c],
        n: callBase + skipped + c + 1,
        time: call.time,
        toolCount: call.tools.length,
        retryCount: call.retries.length,
        loaded: loadedRows.length > 0,
        hasContent:
          call.tools.length > 0 ||
          (call.reply !== undefined && call.reply.textChars + call.reply.reasoningChars > 0),
        ...(call.endTime === undefined ? {} : { endTime: call.endTime }),
        ...(call.durationMs === undefined ? {} : { durationMs: call.durationMs }),
        ...(call.model === undefined ? {} : { model: call.model }),
        ...(call.usage === undefined
          ? {}
          : { inputTokens: call.usage.inputTokens, outputTokens: call.usage.outputTokens }),
        ...snapshotRowParts(call, snapshots),
      });
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
    if (merging) {
      previous.rows.push(...rows);
      previous.head = mergeHead(previous.head, head);
    } else {
      groups.push({ key: `turn-${turn.seq}`, seq: turn.seq, rows, head });
    }
  });
  const turns: TraceTurn[] = groups.map((group) => ({ ...group, legacy: false }));

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

function withToolFact(row: TraceRow, index: ViewIndex): TraceRow {
  if (row.kind !== 'tool') return row;
  const fact = index.tools.get(row.entry.id);
  if (fact === undefined) return row;
  return {
    ...row,
    time: fact.time,
    ...(fact.durationMs === undefined ? {} : { durationMs: fact.durationMs }),
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
 * 對話投成一輪一組的列，以及（結構化模式）窗口外那些輪的摘要。純函式，只看 `state`。
 *
 * 子代理的歸屬原樣帶著（`attribution`）；同一輪裡主對話與子代理的列照出現的先後交錯。
 */
export function traceModel(state: ConversationState): TraceModel {
  const items = itemsOf(state);
  const view = trajectoryOf(state);
  const model: TraceModel =
    view === undefined
      ? { structured: false, turns: legacyGroups(items), digests: [], omitted: 0 }
      : structuredTurns(state, items, view);
  const last = model.turns.at(-1);
  if (last !== undefined) {
    const rows = [...last.rows];
    closeWithStatus(rows, state);
    if (rows.length !== last.rows.length) {
      return { ...model, turns: [...model.turns.slice(0, -1), { ...last, rows }] };
    }
  }
  return model;
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

/**
 * 觀測分頁（[#1033](https://github.com/DemianLi/nexus-agent/issues/1033)）怎麼把對話投成「一輪一組、依序一列一列」。
 *
 * **第 0 版只用折疊器現有的資料：只有順序，沒有時間。** 時刻、模型呼叫的起訖、重試、重複呼叫提醒要等 harness 補
 * （#1034）。UI/UX 以 shadcn＋Tailwind 為基底、Libraries.dev 為模仿對象，**不是照 dsh 的 `ui-trajectory` 畫時間線**
 * （AGENTS.md「不在這條範圍內的」）。
 *
 * ## 切輪靠「人那一格」，而這會錯
 *
 * 沿用畫面按輪歸位的老規矩（`startsTurn`：人的話、背景子代理的結算通知與來信）。**目標自己排的輪次沒有人話**
 * （`apps/harness/src/conversation-history.ts`），那一輪的列會黏在前一輪後面；折疊器也沒有輪 id。這個限制寫在畫面上
 * （{@link TRACE_LIMITS}），不假裝切得準。
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
  ConversationState,
  DecisionEntry,
  HumanEntry,
  NoticeEntry,
  ToolEntry,
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
import { startsTurn } from '@/lib/turn-start';

/** 這一版的限制，**全部寫在畫面上**（卡上「必須寫在畫面上的限制」）。 */
export const TRACE_HEADLINE = '第 0 版：只有順序，沒有時間';

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

/** 找不到那一則時（沒載入、或那一則畫不出來）。說法沿用計劃分頁（`PLAN_TAB_MISSING_TEXT`）。 */
export const TRACE_TARGET_MISSING_TEXT =
  '這一則不在目前載入的對話裡。往上捲載入更早的對話，再從這裡定位。';

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
   * （配不到提問卡的答案：它自己在對話區沒有一格），那一列不畫定位鈕。
   */
  readonly target: string | undefined;
  /** 子代理那幾列帶歸屬；root 的沒有。 */
  readonly attribution?: Attribution;
}

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
    });

export interface TraceTurn {
  /** 這一輪第一列的 key，換對話狀態時穩定。 */
  readonly key: string;
  readonly rows: readonly TraceRow[];
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

/**
 * 對話投成一輪一組的列。純函式，只看 `state.entries` 與 `status`／`error`。
 *
 * 子代理的歸屬原樣帶著（`attribution`）；同一輪裡主對話與子代理的列照出現的先後交錯。
 */
export function traceTurns(state: ConversationState): TraceTurn[] {
  const { entries } = state;
  const answers = pairAnswers(entries);
  const consumed = new Set<AnswerEntry>(answers.values());
  const names = subagentNames(entries);
  const turns: { key: string; rows: TraceRow[] }[] = [];
  let current: { key: string; rows: TraceRow[] } | undefined;

  const push = (row: TraceRow, startsNew: boolean) => {
    if (startsNew || current === undefined) {
      current = { key: row.key, rows: [] };
      turns.push(current);
    }
    current.rows.push(row);
  };

  for (const entry of entries) {
    const opens = startsTurn(entry);
    if (entry.kind === 'human') {
      push(
        {
          kind: 'input',
          key: entry.id,
          target: entry.id,
          entry,
          summary: leadLine(mentionDisplayText(entry.text)),
        },
        opens,
      );
    } else if (entry.kind === 'notice') {
      push(
        {
          kind: 'notice',
          key: entry.id,
          target: entry.id,
          entry,
          summary: settledNoticeText(entry.reason),
        },
        opens,
      );
    } else if (entry.kind === 'agent-message') {
      push(
        {
          kind: 'agent-message',
          key: entry.id,
          target: entry.id,
          entry,
          caption: agentMessageCaption(subagentLabel(names, entry.runId)),
          summary: leadLine(entry.text),
        },
        opens,
      );
    } else if (entry.kind === 'ai') {
      const base = { target: entry.id, ...attributed(entry.attribution) };
      const thinking = entry.reasoning;
      if (thinking !== undefined && thinking.trim() !== '') {
        push(
          { kind: 'thinking', key: `${entry.id}:thinking`, entry, text: thinking, ...base },
          false,
        );
      }
      if (entry.text.trim() !== '') {
        push(
          {
            kind: 'reply',
            key: `${entry.id}:reply`,
            entry,
            summary: leadLine(entry.text),
            ...base,
          },
          false,
        );
      }
      if (entry.stopped === true) {
        push(endingRow(entry.id, 'stopped', ENDING_LABEL.stopped, base), false);
      }
      if (entry.maxTokens === true) {
        push(endingRow(entry.id, 'max-tokens', MAX_TOKENS_NOTICE, base), false);
      }
      if (entry.error !== undefined) {
        push(endingRow(entry.id, 'failed', entry.error, base), false);
      }
    } else if (entry.kind === 'tool') {
      const answer = answers.get(entry.id);
      const { summary, outcome } = toolRowText(entry, answer);
      push(
        {
          kind: 'tool',
          key: entry.id,
          target: entry.id,
          entry,
          title: toolTitle(entry.name),
          summary,
          ...(outcome === undefined ? {} : { outcome }),
          ...(answer === undefined ? {} : { answer }),
          ...attributed(entry.attribution),
        },
        false,
      );
    } else if (entry.kind === 'decision') {
      push(
        {
          kind: 'decision',
          key: entry.id,
          target: entry.id,
          entry,
          summary: decisionText(entry),
        },
        false,
      );
    } else if (entry.kind === 'answer') {
      if (consumed.has(entry)) continue;
      push(
        {
          kind: 'answer',
          key: entry.id,
          target: undefined,
          entry,
          summary:
            entry.cancelled === true ? '放棄回答這些問題' : `已回答 ${entry.answers.length} 題`,
        },
        false,
      );
    } else if (entry.kind === 'compaction') {
      push({ kind: 'compaction', key: entry.id, target: entry.id, entry }, false);
    }
    // `deliverables`、`workspace-changes`：不長列，見檔頭的表。
  }

  const last = current as { key: string; rows: TraceRow[] } | undefined;
  if (last !== undefined) closeWithStatus(last.rows, state);
  return turns;
}

function endingRow(
  id: string,
  reason: EndingReason,
  summary: string,
  base: { readonly target: string; readonly attribution?: Attribution },
): TraceRow {
  return { kind: 'ending', key: `${id}:${reason}`, reason, summary, ...base };
}

/** 最新那一輪的收尾：回覆上的旗標標不到的（停在工具執行中被停止、整輪失敗）讀 `status`。 */
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
 * 兩列畫出來會一樣嗎：每個欄位 `===`。條目沒變時折疊器留著同一個參照，所以沒動的列判得出來——串流中每一格只有正在長的
 * 那幾列要重畫，其餘的 `memo` 擋掉。
 */
export function sameRow(a: TraceRow, b: TraceRow): boolean {
  const left = a as unknown as Record<string, unknown>;
  const right = b as unknown as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}

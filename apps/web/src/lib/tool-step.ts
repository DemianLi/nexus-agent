/**
 * 工具卡的轉接層（[#1682](https://github.com/DemianLi/nexus-agent/issues/1682)）：一則 `ToolEntry` → SG `StepRow` 要的
 * `Step`，以及 nexus 自己畫在 trailing 與 children 槽裡的那幾樣。決議見 #1682 issuecomment-6255973486（Q1）、
 * issuecomment-6256031087（slots 附加、不取代）。
 *
 * - **狀態只走轉接層**：SG 的 `status` 只管兩件事（`running` 讓按鈕閃、群組的 running 判斷），`done` 與 `error` 在畫面上
 *   沒有差別，所以 nexus 的四格加上停止、子代理不擴 union，照 {@link sgStatus} 收成三態；人讀的那個字（{@link ToolStep.statusText}）
 *   另外放進 trailing，狀態不能只靠動效表達（規格 §7）。
 * - **label 是一行字串**：標題加摘要（失敗時是錯誤第一行、停止的提問是 `STOPPED_QUESTION_TEXT`、撞到輸出上限是中文說明）。
 *   它包在 SG 的 `truncate` 裡，窄的時候會被截，所以狀態字不放在這裡。
 * - **明細**：一般工具用 SG 的 `detail`／`output`／`error`（`OutputBlock`）。SG 欄位表達不了的（讀檔卡、搜尋卡、提問清單、
 *   交付清單、待辦快照、diff、撞到輸出上限）由 `components/tool/card.tsx` 畫在 children 槽，**這幾種不設 `output`／`error`**：
 *   slots 是接在 SG 的明細後面（附加），兩邊都設就會把同一筆結果畫兩次（{@link ToolStep.resultInChildren}）。
 * - 參數照舊在 {@link INPUT_MAX_CHARS} 切頭尾（#958），結果照舊是 `toolOutput` 的頭、省略說明、尾（#601），組成一段字串。
 *
 * @module
 */

import { DELEGATION_TOOL_NAMES, isBackgroundSubagentMeta } from '@nexus/wire';
import type { AnswerEntry, QuestionItem, ToolEntry } from '@nexus/wire';

import type { Step } from '@/components/ui/tool-steps';
import {
  answersOfText,
  ASK_USER_QUESTION,
  isStoppedQuestion,
  pairQuestions,
  questionsOf,
  questionSummary,
  STOPPED_QUESTION_TEXT,
} from '@/lib/question-view';
import { PRESENT, presentedFilesOf, presentSummary } from '@/lib/present-view';
import type { PresentedFile } from '@/lib/present-view';
import { TODO_WRITE, todosOf, todoSummary } from '@/lib/todo-view';
import type { TodoItem } from '@/lib/todo-view';
import { toolDiffView } from '@/lib/tool-diff';
import { readCardOf, searchCardOf } from '@/lib/tool-result-card';
import type { ReadCard, SearchCard } from '@/lib/tool-result-card';
import { SUBAGENT_MAX_TOKENS_TEXT, subagentMaxTokensOf } from '@/lib/max-tokens-view';
import { clipMiddle, omittedLabel, showsInput, toolOutput } from '@/lib/tool-output';
import type { ToolOutput } from '@/lib/tool-output';
import {
  SEND_MESSAGE,
  sendMessageSummary,
  sendMessageTitle,
  subagentModelText,
} from '@/lib/subagent-view';
import { firstLine, INPUT_MAX_CHARS, toolInputBody, toolSummary, toolTitle } from '@/lib/tool-view';

export const TOOL_STATUS_LABEL = {
  running: '執行中',
  // **不是「執行中」也不是「失敗」**：這顆呼叫的本體停下來等一個人回答（問答；子代理照 dsh 不停下來等人，
  // [#324](https://github.com/DemianLi/nexus-agent/issues/324)）。講「執行中」會讓人以為只要等就好，講「失敗」是說謊（[#239](https://github.com/DemianLi/nexus-agent/issues/239)）。
  // **停在核准閘門上的不是這一格**：照 dsh 寫「執行中」，等待由核准卡表示（[#317](https://github.com/DemianLi/nexus-agent/issues/317)）。
  suspended: '等你回答',
  done: '完成',
  failed: '失敗',
} as const satisfies Record<ToolEntry['status'], string>;

/** 停止的提問那一格的狀態字（§4.3，#409）：停止不是失敗（#276）。 */
export const STOPPED_STATUS_LABEL = '已停止';

/** nexus 的狀態收成 SG 的三態（#1682 Q1 的對照表）：停止的提問與等人回答都不閃，失敗（含被拒、中斷）是 `error`。 */
export function sgStatus(entry: ToolEntry, stopped: boolean): Step['status'] {
  if (entry.status === 'running') return 'running';
  if (entry.status === 'failed' && !stopped) return 'error';
  return 'done';
}

export interface ToolStep {
  readonly step: Step;
  /** trailing 裡的狀態字。 */
  readonly statusText: string;
  readonly failed: boolean;
  readonly stopped: boolean;
  /** 結果畫在 children 槽（讀檔、搜尋、提問、交付、待辦、diff、撞到輸出上限），`step` 不帶 `output`／`error`。 */
  readonly resultInChildren: boolean;
  readonly questions: readonly QuestionItem[] | undefined;
  /** 這次的答案（線上那一份優先，退回本地那一則）；讀不到是 `undefined`。 */
  readonly given: Parameters<typeof questionSummary>[2];
  readonly paired: ReturnType<typeof pairQuestions> | undefined;
  readonly answered: boolean;
  readonly presented: readonly PresentedFile[] | undefined;
  readonly todos: readonly TodoItem[] | undefined;
  /** 待辦摘要另起的那一格「+N」：同時進行的其餘幾項（照 dsh `planSummary`）。 */
  readonly todoExtra: number;
  readonly diffView: ReturnType<typeof toolDiffView>;
  readonly readCard: ReadCard | undefined;
  readonly searchCard: SearchCard | undefined;
  readonly truncated: ReturnType<typeof subagentMaxTokensOf>;
  readonly backgroundRunId: string | undefined;
  readonly subagentModel: string | undefined;
  /**
   * 一般工具展開後沒有東西可看時講一聲（舊卡就有）：該畫參數卻是空的「沒有參數。」，只畫結果的還沒有結果「還沒有結果。」、
   * 結束了也沒有「沒有結果文字。」。畫在 children 槽，SG 才不會把這一列停用（停用的按鈕鍵盤停不上去）。
   */
  readonly emptyNote: string | undefined;
}

/** 結果文字組成一段：頭、省略說明、尾（`ToolOutputBlock` 原本畫成三段的那個形狀）。 */
export function outputText(output: ToolOutput): string {
  const label = omittedLabel(output);
  return label === undefined ? output.head : `${output.head}\n${label}\n${output.tail}`;
}

/** 參數照 {@link INPUT_MAX_CHARS} 切頭尾（#958），中間一行講沒畫多少字。 */
export function inputText(text: string): string {
  const clipped = clipMiddle(text, INPUT_MAX_CHARS);
  return clipped.dropped === 0
    ? text
    : `${clipped.head}\n⋯ 中間 ${clipped.dropped} 字沒畫 ⋯\n${clipped.tail}`;
}

export function toStep(
  entry: ToolEntry,
  {
    answer,
    subagentNames,
  }: { answer?: AnswerEntry; subagentNames?: ReadonlyMap<string, string> } = {},
): ToolStep {
  const stopped = isStoppedQuestion(entry);
  const failed = entry.status === 'failed' && !stopped;
  const answered = entry.status === 'done';
  const questions = entry.name === ASK_USER_QUESTION ? questionsOf(entry.input) : undefined;
  // 答案優先讀線上那一份（#439）：它不分分頁，重新整理與重播都在。本地那一則是舊日誌（沒有 `text`）的退路。
  const given =
    questions === undefined ? undefined : (answersOfText(entry.text) ?? answer?.answers);
  const paired =
    questions === undefined || given === undefined ? undefined : pairQuestions(questions, given);
  const presented = entry.name === PRESENT ? presentedFilesOf(entry.input) : undefined;
  const todos = entry.name === TODO_WRITE ? todosOf(entry.input) : undefined;
  const todoLine = todos === undefined ? undefined : todoSummary(todos);
  const sendLine =
    entry.name === SEND_MESSAGE
      ? sendMessageSummary(entry.input, entry.attribution, subagentNames ?? new Map())
      : undefined;
  const background =
    DELEGATION_TOOL_NAMES.includes(entry.name) && isBackgroundSubagentMeta(entry.meta)
      ? entry.meta
      : undefined;
  const diffView = toolDiffView(entry);
  const readCard = readCardOf(entry);
  const searchCard = searchCardOf(entry);
  const truncated = subagentMaxTokensOf(entry);
  const showsError = failed && entry.error !== undefined;

  const title =
    entry.name === SEND_MESSAGE ? sendMessageTitle(entry.attribution) : toolTitle(entry.name);
  // 失敗時摘要換成錯誤的第一行（照 dsh `errorSummary`）：收著也看得到為什麼。
  const summary = stopped
    ? STOPPED_QUESTION_TEXT
    : showsError
      ? truncated !== undefined
        ? SUBAGENT_MAX_TOKENS_TEXT
        : firstLine(entry.error ?? '')
      : questions !== undefined
        ? questionSummary(questions, answered, given)
        : presented !== undefined
          ? presentSummary(presented)
          : todoLine !== undefined
            ? todoLine.text
            : (sendLine ?? toolSummary(entry.name, entry.input));

  // 有自己一份清單或檢視的：提問、交付、待辦、diff、讀檔、搜尋。參數原文不畫，它們就是展開後的那一份。
  const ownView =
    questions !== undefined ||
    (presented !== undefined && presented.length > 0) ||
    todos !== undefined ||
    diffView !== undefined ||
    readCard !== undefined ||
    searchCard !== undefined;
  const resultInChildren = ownView || truncated !== undefined;
  const body = toolInputBody(entry.name, entry.input);
  const output = toolOutput(entry);
  const inputShown = showsInput(entry.name) && !ownView;
  const emptyNote = resultInChildren
    ? undefined
    : inputShown
      ? body === undefined
        ? '沒有參數。'
        : undefined
      : output === undefined && entry.error === undefined
        ? entry.status === 'running'
          ? '還沒有結果。'
          : '沒有結果文字。'
        : undefined;
  const step: Step = {
    id: entry.id,
    label: summary === '' ? title : `${title} ${summary}`,
    status: sgStatus(entry, stopped),
    ...(inputShown && body !== undefined ? { detail: inputText(body.text) } : {}),
    ...(resultInChildren
      ? {}
      : {
          ...(output === undefined ? {} : { output: outputText(output) }),
          ...(showsError ? { error: entry.error } : {}),
        }),
  };
  return {
    step,
    statusText: stopped ? STOPPED_STATUS_LABEL : TOOL_STATUS_LABEL[entry.status],
    failed,
    stopped,
    resultInChildren,
    questions,
    given,
    paired,
    answered,
    presented,
    todos,
    todoExtra: todoLine !== undefined && !showsError ? todoLine.extra : 0,
    diffView,
    readCard,
    searchCard,
    truncated,
    backgroundRunId: background?.runId,
    subagentModel: background === undefined ? undefined : subagentModelText(background),
    emptyNote,
  };
}

/**
 * 工具卡（規格 §4.2 列 13／14，#406）：SG 的 `StepRow`（#1682，地圖 #1497 第 ④ 步）。收著是一行按鈕：標題加摘要（SG 的 label），
 * 後面接 nexus 的 trailing（工具名、待辦「+N」、子代理狀態字、歸屬、狀態字），寫檔／改檔再接 SG 畫的 `+N −M`；展開看參數、結果、錯誤、diff，
 * 或 SG 欄位表達不了的那幾種檢視。`ToolEntry` 怎麼變成 SG 的 `Step` 在轉接層 `lib/tool-step.ts`（`toStep`）。
 *
 * - **外觀照 SG**（#1468 Q8）：不再是浮起來的卡片，沒有狀態圖示（它們都是 `aria-hidden`、跟狀態字同義）、沒有執行中的邊框光、
 *   參數不上色、展開沒有動效。狀態字一定在 trailing 裡（規格 §7：狀態不能只靠動效表達；label 包在 truncate 裡，窄的時候會被截）。
 *   執行中 SG 會讓按鈕閃（`animate-pulse`），覆寫檔停掉（波谷時次要字的對比不到 4.5，Q5 優先）。
 * - **展開由這裡控制**（patch `0017`）：停在提問時被停止的那一刻打開，觀測分頁一掛上就是開的（`defaultOpen`）。
 * - **報讀**（§8）：狀態變化不唸，狀態由狀態列講；按鈕的名稱含標題、摘要與狀態字。
 * - **寫檔／改檔的 diff 交給 SG**（#601；#1685 B 起是 `step.patch`）：列上的 `+N −M` 與展開後的 `DiffView` 都由 vendor 畫，
 *   上限與報讀在 nexus 層 `components/ui/diff-view.tsx`。手機版的歸屬照樣畫在 children 槽（patch `0018` 的 patch 分支也接 children）。
 * - **SG 欄位表達不了的畫在 children 槽**（patch `0018`，接在 SG 的明細後面）：讀檔卡與搜尋卡（#625）、提問清單（§4.3，#409、#439）、
 *   交付清單（#441）、待辦快照（#575）、撞到輸出上限的說明與寫到一半的結果（#608）、
 *   背景子代理的模型行與面板（#869、#889）、手機版的歸屬。這幾種的結果只畫在這裡，`toStep` 不設 SG 的 `output`／`error`。
 *   哪個工具畫哪一種、摘要怎麼取，見 `lib/tool-step.ts` 與它引用的各個 `lib/*-view.ts`。
 * - **外層那一格 div** 帶 `data-testid="tool-entry"`、`data-status`、`data-variant`，給測試與 guard 找。
 */

import type { AnswerEntry, Attribution, QuestionItem, ToolEntry } from '@nexus/wire';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';

import { Surface } from '@/components/surface';
import { SubagentPanel, SubagentStateLabel } from '@/components/tool/subagent-control';
import { TodoList } from '@/components/todo/list';
import { ToolOutputBlock, ToolRead, ToolSearch } from '@/components/tool/result';
import { Badge } from '@/components/ui/badge';
import { OutputBlock, StepRow, STEP_LABELS } from '@/components/ui/tool-steps';
import { answerText } from '@/lib/question-view';
import type { QuestionAnswer } from '@/lib/question-view';
import { basename } from '@/lib/present-view';
import type { PresentedFile } from '@/lib/present-view';
import { SUBAGENT_MAX_TOKENS_TEXT, SUBAGENT_PARTIAL_TEXT } from '@/lib/max-tokens-view';
import { outputOf } from '@/lib/tool-output';
import { toStep } from '@/lib/tool-step';
import { classifyTool } from '@/lib/tool-view';

export { TOOL_STATUS_LABEL } from '@/lib/tool-step';

/** 子代理歸屬（列 15）。root 不畫；join 不起來時照講「未歸屬」——寧可說不知道，不要說錯。 */
export function AttributionBadge({ attribution }: { attribution: Attribution }) {
  if (attribution.kind === 'root') return null;
  return (
    <Badge variant="outline">
      {attribution.kind === 'subagent' ? `子代理 ${attribution.name}` : '未歸屬的子代理'}
    </Badge>
  );
}

/**
 * 那一組問題照問的順序列出來。有答案時每題接「→ 回答」；沒有時列選項——停下來那一組人照著打字回覆，
 * 還沒答的看得到在問什麼。
 */
function QuestionList({
  questions,
  answers,
}: {
  questions: readonly QuestionItem[];
  /** 題目 id → 那一題的答案（`pairQuestions`）；讀不到或配不起來時沒有。 */
  answers: ReadonlyMap<string, QuestionAnswer> | undefined;
}) {
  return (
    <Surface as="ol" tone="stage" className="flex flex-col gap-3 p-3 text-body">
      {questions.map((question) => (
        <li key={question.id} className="flex flex-col gap-1" data-testid="question-row">
          {question.header !== undefined && (
            <span className="text-muted-foreground text-tip">{question.header}</span>
          )}
          <span>{question.question}</span>
          {answers !== undefined ? (
            <span className="text-foreground font-medium">
              <span aria-hidden className="text-muted-foreground">
                →{' '}
              </span>
              <span className="sr-only">回答：</span>
              {answerText(answers.get(question.id))}
            </span>
          ) : (
            question.options !== undefined &&
            question.options.length > 0 && (
              <ul className="text-muted-foreground flex list-disc flex-col gap-0.5 pl-5 text-tip">
                {question.options.map((option) => (
                  <li key={option.label}>
                    {option.label}
                    {option.description !== undefined && `：${option.description}`}
                  </li>
                ))}
              </ul>
            )
          )}
        </li>
      ))}
    </Surface>
  );
}

/** 宣告交付的檔案照宣告的順序列出來：檔名一眼認，完整路徑分得出同名檔，說明是模型給人看的那句。 */
function PresentedFileList({ files }: { files: readonly PresentedFile[] }) {
  return (
    <Surface as="ul" tone="stage" className="flex flex-col gap-3 p-3 text-body">
      {files.map((file, index) => (
        <li
          key={`${index}:${file.path}`}
          className="flex min-w-0 flex-col gap-0.5"
          data-testid="presented-file"
        >
          <span className="font-medium break-all">{basename(file.path)}</span>
          <code className="text-muted-foreground font-mono text-tip break-all">{file.path}</code>
          {file.description !== undefined && (
            <span className="text-muted-foreground text-tip">{file.description}</span>
          )}
        </li>
      ))}
    </Surface>
  );
}

export function ToolCard({
  entry,
  answer,
  subagentNames,
  defaultOpen = false,
}: {
  entry: ToolEntry;
  /** 一掛上就是展開的（觀測分頁在列上按開才掛這張卡，不必再點第二下，#1033）。 */
  defaultOpen?: boolean;
  /** 配到這張提問卡的那一則答案（`pairAnswers`）；別的工具、或配不到時沒有。 */
  answer?: AnswerEntry;
  /** 背景子代理的編號 → 名字（`lib/subagent-view.ts`），`send_message` 那張卡用它說出傳給誰；沒給就說不出名字。 */
  subagentNames?: ReadonlyMap<string, string>;
}) {
  // 串流中每一格都會重畫；參數一長（整檔的 write）算 diff 不便宜，所以只在這一則、配到的答案或名字表變了才重算。
  // 名字表要由呼叫端穩住（`useStableNames`），每格新建一個 `Map` 這裡就每格重算（#1682 審查）。
  const view = useMemo(
    () =>
      toStep(entry, {
        ...(answer === undefined ? {} : { answer }),
        ...(subagentNames === undefined ? {} : { subagentNames }),
      }),
    [entry, answer, subagentNames],
  );
  const { stopped } = view;
  const [open, setOpen] = useState(stopped || defaultOpen);
  // 停下來的那一刻這張卡早就在畫面上了（等你回答），所以要在**翻成**停止時打開，初始值只管重播出來的那種。
  const [wasStopped, setWasStopped] = useState(stopped);
  if (stopped !== wasStopped) {
    setWasStopped(stopped);
    if (stopped) setOpen(true);
  }
  const body = toolBody(entry, view);
  return (
    <div
      data-testid="tool-entry"
      data-status={entry.status}
      data-variant={classifyTool(entry.name)}
    >
      <StepRow
        step={view.step}
        open={open}
        onOpenChange={setOpen}
        trailing={
          <>
            {/* 手機寬度讓給摘要：標題已經講了是哪一類，工具名是給熟的人對照的（#625 實機）。 */}
            <code className="hidden shrink-0 font-mono text-tip sm:inline">{entry.name}</code>
            {view.todoExtra > 0 && (
              <span className="shrink-0 text-tip" data-testid="todo-extra">
                <span aria-hidden>+{view.todoExtra}</span>
                <span className="sr-only">，另有 {view.todoExtra} 項進行中</span>
              </span>
            )}
            {view.backgroundRunId !== undefined && (
              <SubagentStateLabel runId={view.backgroundRunId} />
            )}
            <span className="hidden shrink-0 sm:inline-flex">
              <AttributionBadge attribution={entry.attribution} />
            </span>
            <Badge variant={view.failed ? 'destructive' : 'secondary'} className="shrink-0">
              {view.statusText}
            </Badge>
          </>
        }
      >
        {body}
      </StepRow>
    </div>
  );
}

/** children 槽：SG 欄位表達不了的那幾樣；什麼都沒有就是 `undefined`（不然 SG 會當成有東西可開）。 */
function toolBody(entry: ToolEntry, view: ReturnType<typeof toStep>): ReactNode {
  const parts: ReactNode[] = [];
  if (entry.attribution.kind !== 'root')
    parts.push(
      <div key="attribution" className="sm:hidden">
        <AttributionBadge attribution={entry.attribution} />
      </div>,
    );
  if (view.subagentModel !== undefined)
    parts.push(
      <p key="model" data-subagent-model="" className="text-muted-foreground text-tip">
        {view.subagentModel}
      </p>,
    );
  if (view.questions !== undefined) {
    parts.push(<QuestionList key="questions" questions={view.questions} answers={view.paired} />);
    if (view.answered && view.paired === undefined)
      parts.push(
        <p key="questions-note" className="text-muted-foreground text-tip">
          {view.given === undefined
            ? '這次的答案讀不出來：結果文字太長被截過，或不是預期的形狀。'
            : '答案和題目對不起來，只列題目。'}
        </p>,
      );
  } else if (view.presented !== undefined && view.presented.length > 0)
    parts.push(<PresentedFileList key="presented" files={view.presented} />);
  else if (view.todos !== undefined) parts.push(<TodoList key="todos" todos={view.todos} />);
  else if (view.readCard !== undefined) parts.push(<ToolRead key="read" card={view.readCard} />);
  else if (view.searchCard !== undefined)
    parts.push(<ToolSearch key="search" card={view.searchCard} />);
  if (view.truncated !== undefined) {
    const partial = view.truncated.partial.trim() !== '';
    parts.push(
      <Surface key="truncated" as="p" tone="stage" className="text-destructive p-3 text-tip">
        {SUBAGENT_MAX_TOKENS_TEXT}
        {partial && SUBAGENT_PARTIAL_TEXT}
      </Surface>,
    );
    if (partial)
      parts.push(<ToolOutputBlock key="partial" output={outputOf(view.truncated.partial)} />);
  } else if (view.resultInChildren && view.failed && entry.error !== undefined)
    // 有自己一份檢視的那幾種失敗了：錯誤照 SG 的錯誤框畫，接在檢視後面（SG 的 `error` 沒設，不會畫兩次）。
    parts.push(
      <OutputBlock key="error" label={STEP_LABELS.error} text={entry.error} tone="error" />,
    );
  if (view.emptyNote !== undefined)
    parts.push(
      <p key="empty" className="text-muted-foreground text-tip">
        {view.emptyNote}
      </p>,
    );
  if (view.backgroundRunId !== undefined)
    parts.push(<SubagentPanel key="subagent" runId={view.backgroundRunId} />);
  return parts.length === 0 ? undefined : parts;
}

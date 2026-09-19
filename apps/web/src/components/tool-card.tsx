/**
 * 工具卡（規格 §4.2 列 13／14，#406）：收合時一行（狀態、標題、工具名、摘要、歸屬、狀態字），展開看參數與錯誤。
 * 直接吃 `ToolEntry.status` 的四格；分類與摘要在 `lib/tool-view.ts`。
 *
 * - **浮起來**（`shadow-material`），展開的內容放內層 stage（§5）。
 * - **動效**（§7）：展開收合 250／150 高度＋透明度（collapsible）；出現往上 8px 由對話列表管；
 *   執行中的邊框光**同時最多一個**（`beam` 由呼叫端決定給誰）。
 * - **報讀**（§8）：狀態變化不唸，狀態由狀態列講；orb 旁有同義文字，所以 `aria-hidden`。
 * - **停在提問時被停止的 `ask_user_question`**（§4.3，#409）：直接展開、列出題目與選項，標「已停止，請直接打字回覆」，
 *   不畫紅字——停止不是失敗（#276），而那句紅字是給模型看的英文。判法在 `lib/question-view.ts`。
 * - **答完的 `ask_user_question`**（§4.3，#409）：展開列「問題 → 回答」，答案是呼叫端按題目 id 配來的（`pairAnswers`）；
 *   配不到（重新整理、別的分頁）就只列題目、收著那一行照講「已回答 N 題」。參數原文不畫：它就是這幾題。
 */

import type { AnswerEntry, Attribution, QuestionItem, ToolEntry } from '@nexus/wire';
import { Check, ChevronDown, Hand, X } from 'lucide-react';
import { useState } from 'react';

import { AgentOrb } from '@/components/agent-orb';
import { CodeBlock } from '@/components/markdown/code-block';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  answerText,
  ASK_USER_QUESTION,
  isStoppedQuestion,
  questionsOf,
  questionSummary,
  STOPPED_QUESTION_TEXT,
} from '@/lib/question-view';
import { classifyTool, firstLine, toolInputBody, toolSummary, toolTitle } from '@/lib/tool-view';

export const TOOL_STATUS_LABEL = {
  running: '執行中',
  // **不是「執行中」也不是「失敗」**：這顆呼叫的本體停下來等一個人回答（問答；子代理照 dsh 不停下來等人，
  // [#324](https://github.com/DemianLi/nexus-agent/issues/324)）。講「執行中」會讓人以為只要等就好，講「失敗」是說謊（[#239](https://github.com/DemianLi/nexus-agent/issues/239)）。
  // **停在核准閘門上的不是這一格**：照 dsh 寫「執行中」，等待由核准卡表示（[#317](https://github.com/DemianLi/nexus-agent/issues/317)）。
  suspended: '等你回答',
  done: '完成',
  failed: '失敗',
} as const satisfies Record<ToolEntry['status'], string>;

/** 子代理歸屬（列 15）。root 不畫；join 不起來時照講「未歸屬」——寧可說不知道，不要說錯。 */
export function AttributionBadge({ attribution }: { attribution: Attribution }) {
  if (attribution.kind === 'root') return null;
  return (
    <Badge variant="outline">
      {attribution.kind === 'subagent' ? `子代理 ${attribution.name}` : '未歸屬的子代理'}
    </Badge>
  );
}

function StatusIcon({ status }: { status: ToolEntry['status'] }) {
  if (status === 'running') return <AgentOrb state="working" size={20} decorative />;
  if (status === 'suspended') return <Hand aria-hidden className="text-brand size-4" />;
  if (status === 'done') return <Check aria-hidden className="text-muted-foreground size-4" />;
  return <X aria-hidden className="text-destructive size-4" />;
}

/**
 * 那一組問題照問的順序列出來。有答案時每題接「→ 回答」；沒有時列選項——停下來那一組人照著打字回覆，
 * 還沒答的看得到在問什麼。
 */
function QuestionList({
  questions,
  answer,
}: {
  questions: readonly QuestionItem[];
  answer: AnswerEntry | undefined;
}) {
  return (
    <ol className="bg-stage shadow-stage flex flex-col gap-3 rounded-xl p-3 text-sm">
      {questions.map((question) => (
        <li key={question.id} className="flex flex-col gap-1" data-testid="question-row">
          {question.header !== undefined && (
            <span className="text-muted-foreground text-xs">{question.header}</span>
          )}
          <span>{question.question}</span>
          {answer !== undefined ? (
            <span className="text-foreground font-medium">
              <span aria-hidden className="text-muted-foreground">
                →{' '}
              </span>
              <span className="sr-only">回答：</span>
              {answerText(answer.answers.find((candidate) => candidate.id === question.id))}
            </span>
          ) : (
            question.options !== undefined &&
            question.options.length > 0 && (
              <ul className="text-muted-foreground flex list-disc flex-col gap-0.5 pl-5 text-xs">
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
    </ol>
  );
}

export function ToolCard({
  entry,
  beam,
  answer,
}: {
  entry: ToolEntry;
  beam: boolean;
  /** 配到這張提問卡的那一則答案（`pairAnswers`）；別的工具、或配不到時沒有。 */
  answer?: AnswerEntry;
}) {
  const stopped = isStoppedQuestion(entry);
  const [open, setOpen] = useState(stopped);
  // 停下來的那一刻這張卡早就在畫面上了（等你回答），所以要在**翻成**停止時打開，初始值只管重播出來的那種。
  const [wasStopped, setWasStopped] = useState(stopped);
  if (stopped !== wasStopped) {
    setWasStopped(stopped);
    if (stopped) setOpen(true);
  }
  const variant = classifyTool(entry.name);
  const body = toolInputBody(entry.name, entry.input);
  const questions = entry.name === ASK_USER_QUESTION ? questionsOf(entry.input) : undefined;
  const failed = entry.status === 'failed' && !stopped;
  const answered = entry.status === 'done';
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="bg-card shadow-material border-beam rounded-3xl p-1"
      data-testid="tool-entry"
      data-status={entry.status}
      data-variant={variant}
      data-kind="run"
      data-active={beam}
    >
      <CollapsibleTrigger className="group hover:bg-chip-hover active:bg-chip-pressed flex min-h-11 w-full min-w-0 items-center gap-2.5 rounded-[20px] px-3 py-2 text-left transition-colors duration-(--duration-quick)">
        <span className="flex size-5 shrink-0 items-center justify-center">
          {stopped ? (
            <X aria-hidden className="text-muted-foreground size-4" />
          ) : (
            <StatusIcon status={entry.status} />
          )}
        </span>
        <span className="text-ui shrink-0 font-medium">{toolTitle(entry.name)}</span>
        <code className="text-muted-foreground shrink-0 font-mono text-xs">{entry.name}</code>
        <span
          className={`min-w-0 flex-1 truncate text-xs ${failed ? 'text-destructive' : 'text-muted-foreground'}`}
        >
          {/* 失敗時這一格換成錯誤的第一行（照 dsh `errorSummary`）：收著也看得到為什麼。 */}
          {stopped
            ? STOPPED_QUESTION_TEXT
            : failed && entry.error !== undefined
              ? firstLine(entry.error)
              : questions !== undefined
                ? questionSummary(questions, answered)
                : toolSummary(entry.name, entry.input)}
        </span>
        <span className="hidden sm:inline-flex">
          <AttributionBadge attribution={entry.attribution} />
        </span>
        <Badge variant={failed ? 'destructive' : 'secondary'} className="shrink-0">
          {stopped ? '已停止' : TOOL_STATUS_LABEL[entry.status]}
        </Badge>
        <ChevronDown
          aria-hidden
          data-motion-rotate
          className="text-muted-foreground size-4 shrink-0 transition-transform duration-(--duration-fast) ease-(--ease-smooth-out) group-data-[state=open]:rotate-180"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down overflow-hidden">
        <div className="m-1 mt-0 flex flex-col gap-2">
          {entry.attribution.kind !== 'root' && (
            <div className="px-2 sm:hidden">
              <AttributionBadge attribution={entry.attribution} />
            </div>
          )}
          {questions !== undefined ? (
            <>
              <QuestionList questions={questions} answer={answer} />
              {answered && answer === undefined && (
                <p className="text-muted-foreground px-3 pb-1 text-xs">
                  答案只記在作答的那個分頁，這裡看不到。
                </p>
              )}
            </>
          ) : body === undefined ? (
            <p className="text-muted-foreground px-3 py-2 text-xs">沒有參數。</p>
          ) : (
            <CodeBlock code={body.text} lang={body.lang} streaming={entry.status === 'running'} />
          )}
          {entry.error !== undefined && !stopped && (
            <pre className="bg-stage shadow-stage text-destructive rounded-xl p-3 font-mono text-xs whitespace-pre-wrap">
              {entry.error}
            </pre>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

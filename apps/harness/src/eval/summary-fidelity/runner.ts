/**
 * 交接保真度評估的跑者（[#2774](https://github.com/DemianLi/nexus-agent/issues/2774)）。
 *
 * 一個變體跑兩步：
 *
 * 1. **強制摘要**。每一段對話接到訊息串後面，叫一次出貨的摘要器（`createSummarizer`，prompt、切點、重試都是它自己的），
 *    門檻調小到這一段一定越過。主模型那一格用罐頭回覆頂替，不打模型；打模型的只有摘要器：通常一次，
 *    摘要後這份請求仍到門檻時，摘要器照出貨設定（`compactionRetries` 1）換成不留尾巴再摘一次。
 * 2. **問題目**。摘要器交下去的那一串（摘要加逐字留下的尾巴）後面接一題，一題一次模型呼叫，答案交給 `../scorers.ts` 的
 *    `scoreMentions`。
 *
 * 門檻與保留量照出貨在預設模型上的實際比例（保留量封在 token 門檻的兩成），絕對值縮小：題庫要的是「事實被摘掉」，不是把窗口塞滿。
 * 只留 token 門檻，出貨的 60 則訊息數門檻不設。
 */

import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { createSummarizer, DEFAULT_SUMMARIZATION, SessionLog, TokenAnchorBook } from '@nexus/core';
import type { StreamRetryOptions } from '@nexus/core';
import { scoreMentions } from '../scorers.js';
import type { FidelityQuestion, FidelityVariant } from './dataset.js';

/** 評估用的摘要門檻（token）。每一段對話都要比它長，由 `summary-fidelity.test.ts` 釘住。 */
export const FIDELITY_TRIGGER_TOKENS = 8_000;
/** 摘要之後逐字留下的量（token）：門檻的兩成，等於出貨在預設模型上的封頂比例。 */
export const FIDELITY_RETAIN_TOKENS = 1_600;

/** 問題目時的系統提示。 */
const ANSWER_SYSTEM_PROMPT =
  'You are an assistant continuing an ongoing conversation. Answer the next question using only what is in the conversation so far. ' +
  'Reply in the language of the question, in one short sentence. If the conversation does not contain the answer, say you do not know.';

/** 主模型那一格的罐頭回覆。 */
const CANNED_REPLY = 'Understood.';

/** 這次評估用到的模型。 */
export interface FidelityModels {
  /** 交給摘要器的那顆：摘要器讀它的 `profile`、叫它的 `invoke`。 */
  readonly summaryModel: unknown;
  /** 問一題，回答案的文字。 */
  ask(messages: readonly BaseMessage[]): Promise<string>;
  /** 摘要器那一次呼叫的重試政策。省略就不重試。 */
  readonly retry?: StreamRetryOptions;
}

/** 一題的結果。 */
export interface FidelityQuestionResult {
  readonly questionId: string;
  readonly kind: FidelityQuestion['kind'];
  /** 這個事實經過幾次摘要。 */
  readonly summariesCrossed: number;
  /** `scoreMentions` 的分數，0 到 1。比對不看空白。 */
  readonly score: number;
  /** 答案裡出現了被推翻的舊結論。題目沒列 `stale` 時恆為假。 */
  readonly staleHit: boolean;
  /** 該提到的字串是否全都在最後那則摘要裡（比對不看空白）。答錯時用它分辨是摘要丟了，還是摘要有、模型沒答出來。 */
  readonly inSummary: boolean;
  /** 該提到的字串有任何一個出現在逐字留下的尾巴裡：這題量不到摘要，不進平均。 */
  readonly leaked: boolean;
  readonly answer: string;
}

/** 一個變體跑一次的結果。 */
export interface FidelityVariantResult {
  readonly variantId: FidelityVariant['id'];
  readonly title: string;
  /** 每一段：摘要器那一步花了幾毫秒（含它自己的重試與重摘）、摘要幾個字元、摘要之後逐字留下幾則訊息。 */
  readonly summaries: readonly {
    readonly summarizeMs: number;
    readonly summaryChars: number;
    readonly retainedMessages: number;
  }[];
  readonly questions: readonly FidelityQuestionResult[];
  /** 沒洩漏的題目的平均分；全洩漏時是 `undefined`。 */
  readonly score: number | undefined;
  /** 過時命中的題數。 */
  readonly staleHits: number;
}

/** 摘要沒有照預期發生：這一輪量不到東西，不是零分。 */
export class SummaryDidNotHappenError extends Error {
  constructor(variantId: string, segment: number, detail: string) {
    super(`變體 ${variantId} 第 ${segment + 1} 段沒有剛好生出一則摘要：${detail}`);
    this.name = 'SummaryDidNotHappenError';
  }
}

function textOf(message: BaseMessage): string {
  return typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
}

/**
 * 比對前拿掉所有空白。模型回答時空白的寫法不固定（「4月23日」與「4 月 23 日」），那不是摘要丟了東西。
 */
function squash(text: string): string {
  return text.replace(/\s+/g, '');
}

function isSummary(message: BaseMessage): boolean {
  return (
    (message.additional_kwargs as { lc_source?: unknown } | undefined)?.lc_source ===
    'summarization'
  );
}

/**
 * 跑一個變體一次。
 *
 * @param variant - 變體。
 * @param models - 摘要模型與答題模型。
 * @returns 每一題的結果與這個變體的平均分。
 * @throws {SummaryDidNotHappenError} 任何一段沒有剛好生出一則摘要（門檻沒到、摘要模型失敗或摘要被拒收）。答題模型
 *   （`models.ask`）的錯誤原樣拋。
 */
export async function runFidelityVariant(
  variant: FidelityVariant,
  models: FidelityModels,
): Promise<FidelityVariantResult> {
  const log = new SessionLog(`summary-fidelity-${variant.id}`);
  const middleware = createSummarizer(
    // 歷史檔寫進空的替身，不落盤。
    { readFile: async () => null, write: async (path: string) => ({ path }) } as never,
    {
      ...DEFAULT_SUMMARIZATION,
      trigger: [{ type: 'tokens', value: FIDELITY_TRIGGER_TOKENS }],
      retainRatio: undefined,
      retainTokens: FIDELITY_RETAIN_TOKENS,
    },
    new TokenAnchorBook(),
    { forCall: () => ({ kind: 'ok', address: { kind: 'root' }, log }) },
    // 工具結果修剪關掉：它會在摘要之前先動到訊息，這裡只量摘要。
    false,
    undefined,
    undefined,
    undefined,
    models.retry,
  );
  // 兩格都要給：摘要器靠它們認出是同一條對話的呼叫，下一段才會接著上一次的切點摘，而不是從原文重摘。
  const runtime = {
    configurable: {
      thread_id: `summary-fidelity-${variant.id}`,
      checkpoint_ns: 'model_request:summary-fidelity',
    },
  };
  const summaryCount = () =>
    log.events.filter((event) => event.type === 'compaction/summary').length;

  const state: BaseMessage[] = [];
  let seen: readonly BaseMessage[] = [];
  const summaries: FidelityVariantResult['summaries'][number][] = [];
  for (const [index, segment] of variant.segments.entries()) {
    state.push(...segment);
    const before = summaryCount();
    const startedAt = performance.now();
    await middleware.wrapModelCall?.(
      {
        messages: [...state],
        state: { messages: [...state] },
        runtime,
        model: models.summaryModel,
        systemMessage: new SystemMessage(ANSWER_SYSTEM_PROMPT),
        tools: [],
      } as never,
      ((request: { messages: readonly BaseMessage[] }) => {
        seen = request.messages;
        return new AIMessage(CANNED_REPLY);
      }) as never,
    );
    const summarizeMs = Math.round(performance.now() - startedAt);
    const summary = seen.find(isSummary);
    if (summaryCount() !== before + 1 || summary === undefined) {
      throw new SummaryDidNotHappenError(
        variant.id,
        index,
        `日誌多了 ${summaryCount() - before} 顆 compaction/summary，交下去 ${seen.length} 則`,
      );
    }
    summaries.push({
      summarizeMs,
      summaryChars: textOf(summary).length,
      retainedMessages: seen.length - 1,
    });
    state.push(new AIMessage(CANNED_REPLY));
  }

  const summaryText = squash(seen.filter(isSummary).map(textOf).join('\n'));
  const tail = seen.filter((message) => !isSummary(message));
  const tailText = tail
    .map((message) =>
      message instanceof ToolMessage || !AIMessage.isInstance(message)
        ? textOf(message)
        : `${textOf(message)}\n${JSON.stringify(message.tool_calls ?? [])}`,
    )
    .join('\n');
  const squashedTail = squash(tailText);

  const questions: FidelityQuestionResult[] = [];
  for (const question of variant.questions) {
    const answer = await models.ask([
      new SystemMessage(ANSWER_SYSTEM_PROMPT),
      ...seen,
      new AIMessage(CANNED_REPLY),
      new HumanMessage(question.prompt),
    ]);
    const score =
      scoreMentions(
        {
          id: question.id,
          prompt: question.prompt,
          expected: { toolCalls: [], mentions: question.mentions.map(squash) },
        },
        { caseId: question.id, toolCalls: [], finalText: squash(answer) },
      ) ?? 0;
    questions.push({
      questionId: question.id,
      kind: question.kind,
      summariesCrossed: variant.segments.length - question.segment,
      score,
      staleHit: (question.stale ?? []).some((needle) => squash(answer).includes(squash(needle))),
      inSummary: question.mentions.every((needle) => summaryText.includes(squash(needle))),
      leaked: question.mentions.some((needle) => squashedTail.includes(squash(needle))),
      answer,
    });
  }

  const counted = questions.filter((result) => !result.leaked);
  return {
    variantId: variant.id,
    title: variant.title,
    summaries,
    questions,
    score:
      counted.length === 0
        ? undefined
        : counted.reduce((sum, result) => sum + result.score, 0) / counted.length,
    staleHits: questions.filter((result) => result.staleHit).length,
  };
}

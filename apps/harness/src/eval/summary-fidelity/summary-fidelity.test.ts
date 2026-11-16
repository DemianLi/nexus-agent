import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { estimateMessageTokens, SUMMARY_ENTRY_INSTRUCTION, SUMMARY_INSTRUCTION } from '@nexus/core';
import { describe, expect, it } from 'vitest';
import { FIDELITY_VARIANTS } from './dataset.js';
import { formatFidelityReport } from './report.js';
import {
  FIDELITY_RECALL_MAX_REQUESTS,
  FIDELITY_TRIGGER_TOKENS,
  runFidelityVariant,
  SummaryDidNotHappenError,
} from './runner.js';
import type { FidelityModels } from './runner.js';

const contentOf = (message: BaseMessage) =>
  typeof message.content === 'string' ? message.content : JSON.stringify(message.content);

/** 雜訊行：存取日誌與會議室借用紀錄。 */
const NOISE = /^(10\.0\.\d+\.\d+ - - |第 \d+ 筆：)/;

/** 索引條目那次的回覆：標題加一行，是合格的條目；這份評估量的是現況，條目只佔位。 */
const ENTRY_TEXT = '本段對話\n- 見現況';
/** 這一次呼叫是不是索引條目那次（回覆是 {@link ENTRY_TEXT}，不算進現況）。 */
const isEntryCall = (input: readonly BaseMessage[]) =>
  contentOf(input.at(-1) ?? new HumanMessage('')).includes(SUMMARY_ENTRY_INSTRUCTION);

/**
 * 把要摘的對話裡不是雜訊的行原樣留下的摘要模型：事實全在。系統訊息與摘要指令不算摘要內容（重播形狀才有）。
 */
const KEEPS_EVERYTHING = {
  profile: {},
  invoke: async (input: readonly BaseMessage[]) => {
    if (isEntryCall(input)) return { text: ENTRY_TEXT };
    return {
      text: input
        .filter(
          (message) => message.getType() !== 'system' && contentOf(message) !== SUMMARY_INSTRUCTION,
        )
        .map(contentOf)
        .join('\n')
        .split('\n')
        .filter((line) => !NOISE.test(line))
        .join('\n'),
    };
  },
};

/** 什麼都沒留下的摘要模型（條目那次回的單行也是合格的條目）。 */
const DROPS_EVERYTHING = {
  profile: {},
  invoke: async () => ({ text: 'Nothing of note happened.' }),
};

/** 把看到的整串原樣念回來的答題模型：分數只取決於事實有沒有活過摘要。最後一則是題目本身，不算。 */
const echo = async (messages: readonly BaseMessage[]) =>
  messages.slice(0, -1).map(contentOf).join('\n');

const models = (summaryModel: unknown): FidelityModels => ({ summaryModel, ask: echo });

describe('交接保真度評估（#2774）', () => {
  it('五個變體：摘要一次、連續兩次、連續四次、中文對話、決定被推翻', () => {
    expect(FIDELITY_VARIANTS.map((variant) => variant.id)).toEqual([
      'single',
      'double',
      'quad',
      'zh',
      'overturned',
    ]);
    expect(FIDELITY_VARIANTS.find((variant) => variant.id === 'double')?.segments).toHaveLength(2);
    expect(FIDELITY_VARIANTS.find((variant) => variant.id === 'quad')?.segments).toHaveLength(4);
  });

  it('每一段都長過摘要門檻，而且以使用者的話結尾', () => {
    for (const variant of FIDELITY_VARIANTS) {
      for (const segment of variant.segments) {
        const tokens = segment.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
        expect(tokens, variant.id).toBeGreaterThan(FIDELITY_TRIGGER_TOKENS);
        expect(segment.at(-1)?.getType(), variant.id).toBe('human');
      }
    }
  });

  it('題目的 segment 都指得到一段，該提到的字串在那一段裡找得到', () => {
    for (const variant of FIDELITY_VARIANTS) {
      for (const question of variant.questions) {
        const segment = variant.segments[question.segment];
        expect(segment, `${variant.id}/${question.id}`).toBeDefined();
        const text = (segment ?? []).map(contentOf).join('\n');
        for (const needle of [...question.mentions, ...(question.stale ?? [])]) {
          expect(text, `${variant.id}/${question.id}`).toContain(needle);
        }
      }
    }
  });

  it.each(FIDELITY_VARIANTS)('$id：摘要留住事實時滿分，沒有一題落在尾巴裡', async (variant) => {
    const result = await runFidelityVariant(variant, models(KEEPS_EVERYTHING));

    expect(result.summaries).toHaveLength(variant.segments.length);
    expect(result.questions.map((question) => question.leaked)).not.toContain(true);
    expect(result.questions.map((question) => question.inSummary)).not.toContain(false);
    expect(result.score).toBe(1);
  });

  it.each(FIDELITY_VARIANTS)('$id：摘要什麼都沒留時零分', async (variant) => {
    const result = await runFidelityVariant(variant, models(DROPS_EVERYTHING));

    expect(result.questions.map((question) => question.inSummary)).not.toContain(true);
    expect(result.score).toBe(0);
    expect(result.staleHits).toBe(0);
  });

  it('問題目的那串不含工具訊息', async () => {
    for (const variant of FIDELITY_VARIANTS) {
      const asked: (readonly BaseMessage[])[] = [];
      await runFidelityVariant(variant, {
        summaryModel: DROPS_EVERYTHING,
        ask: async (messages) => {
          asked.push(messages);
          return '';
        },
      });
      expect(asked).toHaveLength(variant.questions.length);
      for (const messages of asked) {
        expect(messages.some((message) => message instanceof ToolMessage)).toBe(false);
        expect(
          messages.some(
            (message) => AIMessage.isInstance(message) && (message.tool_calls ?? []).length > 0,
          ),
        ).toBe(false);
      }
    }
  });

  it.each(FIDELITY_VARIANTS)(
    '$id：replay 時摘要模型收到系統訊息、原訊息與摘要指令，分數照算',
    async (variant) => {
      const inputs: (readonly BaseMessage[])[] = [];
      const result = await runFidelityVariant(variant, {
        summaryModel: {
          profile: {},
          invoke: async (input: readonly BaseMessage[]) => {
            inputs.push(input);
            return KEEPS_EVERYTHING.invoke(input);
          },
        },
        ask: echo,
        summaryCall: 'replay',
      });

      // 每段兩次：索引條目一次、現況一次，各自的最後一則是它的指令。
      expect(inputs).toHaveLength(variant.segments.length * 2);
      for (const input of inputs) {
        expect(input[0]?.getType()).toBe('system');
        expect(input.length).toBeGreaterThan(2);
        expect([SUMMARY_INSTRUCTION, SUMMARY_ENTRY_INSTRUCTION]).toContain(input.at(-1)?.content);
      }
      expect(inputs.filter(isEntryCall)).toHaveLength(variant.segments.length);
      expect(result.score).toBe(1);
    },
  );

  it('連續摘要兩次：第一段的事實經過兩次摘要，第二段的經過一次', async () => {
    const double = FIDELITY_VARIANTS.find((variant) => variant.id === 'double')!;
    const result = await runFidelityVariant(double, models(KEEPS_EVERYTHING));

    const crossed = new Map(
      result.questions.map((question) => [question.questionId, question.summariesCrossed]),
    );
    expect(crossed.get('path')).toBe(2);
    expect(crossed.get('runbook')).toBe(1);
  });

  it('連續摘要兩次：第二次摘的是第一次的摘要，不是第一段的原文', async () => {
    const double = FIDELITY_VARIANTS.find((variant) => variant.id === 'double')!;
    // 只記現況那一次的輸入（索引條目那次的輸入不是摘要內容，不計）。
    const inputs: string[] = [];
    await runFidelityVariant(double, {
      summaryModel: {
        profile: {},
        invoke: async (input: readonly BaseMessage[]) => {
          if (isEntryCall(input)) return { text: ENTRY_TEXT };
          inputs.push(input.map(contentOf).join('\n'));
          return { text: `SUMMARY-${inputs.length}` };
        },
      },
      ask: async () => '',
    });

    expect(inputs).toHaveLength(2);
    expect(inputs[1]).toContain('SUMMARY-1');
    expect(inputs[1]).not.toContain('I am preparing the vendor review');
  });

  it('該提到的字串與過時的字串只出現在事實裡，雜訊裡沒有', () => {
    for (const variant of FIDELITY_VARIANTS) {
      const noise = variant.segments
        .flat()
        .map(contentOf)
        .join('\n')
        .split('\n')
        .filter((line) => NOISE.test(line) || /^(Summary table|第 \S+ 個時段)/.test(line))
        .join('\n');
      expect(noise.length, variant.id).toBeGreaterThan(10_000);
      for (const question of variant.questions) {
        for (const needle of [...question.mentions, ...(question.stale ?? [])]) {
          expect(noise, `${variant.id}/${question.id}`).not.toContain(needle);
        }
      }
    }
  });

  it('答案帶著被推翻的舊結論時記過時命中，不影響分數', async () => {
    const overturned = FIDELITY_VARIANTS.find((variant) => variant.id === 'overturned')!;
    const result = await runFidelityVariant(overturned, {
      summaryModel: DROPS_EVERYTHING,
      ask: async () => 'PostgreSQL (earlier we said MySQL)',
    });

    const database = result.questions.find((question) => question.questionId === 'database');
    expect(database).toMatchObject({ score: 1, staleHit: true });
  });

  it('比對不看空白：答案把「4 月 23 日」寫成「4月23日」也算提到', async () => {
    const zh = FIDELITY_VARIANTS.find((variant) => variant.id === 'zh')!;
    const result = await runFidelityVariant(zh, {
      summaryModel: DROPS_EVERYTHING,
      ask: async () => '4月23日',
    });

    expect(result.questions.find((question) => question.questionId === 'bid-date')?.score).toBe(1);
  });

  it('摘要沒發生時拋，不當成零分', async () => {
    const single = FIDELITY_VARIANTS.find((variant) => variant.id === 'single')!;
    const rejects = {
      profile: {},
      invoke: async () => {
        throw new Error('上游壞了');
      },
    };

    await expect(runFidelityVariant(single, models(rejects))).rejects.toBeInstanceOf(
      SummaryDidNotHappenError,
    );
  });

  it('報表每個變體一列得分，洩漏的題目另外標出', async () => {
    const results = [];
    for (const variant of FIDELITY_VARIANTS) {
      results.push(await runFidelityVariant(variant, models(KEEPS_EVERYTHING)));
    }
    const report = formatFidelityReport([results]);

    for (const variant of FIDELITY_VARIANTS) expect(report).toContain(variant.id);
    expect(report).toContain('1.00');
  });
});

describe('帶讀回工具答題（#2777）', () => {
  const single = FIDELITY_VARIANTS.find((variant) => variant.id === 'single')!;
  const double = FIDELITY_VARIANTS.find((variant) => variant.id === 'double')!;

  /** 每一題先搜第一個該提到的字串，再把工具結果念回來的答題模型。 */
  const searches = (variant: (typeof FIDELITY_VARIANTS)[number]) => {
    const firstRequests: (readonly BaseMessage[])[] = [];
    const answerStep: NonNullable<FidelityModels['answerStep']> = async (messages, tools) => {
      expect(tools.map((tool) => tool.name)).toEqual(['history_read', 'history_search']);
      const last = messages.at(-1)!;
      if (ToolMessage.isInstance(last)) return new AIMessage(contentOf(last));
      firstRequests.push(messages);
      const question = variant.questions.find((each) => each.prompt === contentOf(last))!;
      return new AIMessage({
        content: '',
        tool_calls: [
          { id: 'q', name: 'history_search', args: { query: question.mentions[0]!, limit: 1 } },
        ],
      });
    };
    return { firstRequests, answerStep };
  };

  it('摘要什麼都沒留，模型搜得到被摘掉的原文：摘要裡沒有、答案裡有', async () => {
    const { firstRequests, answerStep } = searches(single);
    const result = await runFidelityVariant(single, {
      ...models(DROPS_EVERYTHING),
      answerStep,
    });
    const first = result.questions.find((question) => !question.leaked)!;
    const mention = single.questions.find((each) => each.id === first.questionId)!.mentions[0]!;
    expect(first.inSummary).toBe(false);
    expect(first.answer).toMatch(/match(es)? for/);
    expect(first.answer.replace(/\s+/g, '')).toContain(mention.replace(/\s+/g, ''));
    expect(first).toMatchObject({ requests: 2, recallCalls: 1 });
    // 前言指向讀回工具。
    expect(firstRequests[0]!.map(contentOf).join('\n')).toContain('call history_search with a literal string');
  });

  it('連續摘要兩次：第一段的原文還讀得回來', async () => {
    const { answerStep } = searches(double);
    const result = await runFidelityVariant(double, { ...models(DROPS_EVERYTHING), answerStep });
    const early = result.questions.find((question) => question.summariesCrossed === 2)!;
    expect(early.answer).toMatch(/match(es)? for/);
  });

  it(`一直叫工具：送到第 ${FIDELITY_RECALL_MAX_REQUESTS} 個請求就停，最後那一則的文字當答案`, async () => {
    let requests = 0;
    const result = await runFidelityVariant(single, {
      ...models(DROPS_EVERYTHING),
      answerStep: async () => {
        requests += 1;
        return new AIMessage({
          content: '',
          tool_calls: [{ id: 'again', name: 'history_read', args: { entry: 1 } }],
        });
      },
    });
    expect(requests).toBe(single.questions.length * FIDELITY_RECALL_MAX_REQUESTS);
    expect(result.questions[0]).toMatchObject({
      answer: '',
      requests: FIDELITY_RECALL_MAX_REQUESTS,
      recallCalls: FIDELITY_RECALL_MAX_REQUESTS - 1,
    });
  });

  it('沒給 answerStep：前言不指向讀回工具，每題一個請求、不叫工具', async () => {
    const seen: string[] = [];
    const result = await runFidelityVariant(single, {
      summaryModel: DROPS_EVERYTHING,
      ask: async (messages) => {
        seen.push(messages.map(contentOf).join('\n'));
        return '';
      },
    });
    expect(seen[0]).not.toContain('history_read');
    expect(result.questions.every((q) => q.requests === 1 && q.recallCalls === 0)).toBe(true);
  });
});

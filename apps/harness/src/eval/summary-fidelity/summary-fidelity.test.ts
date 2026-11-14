import { AIMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { estimateMessageTokens } from '@nexus/core';
import { describe, expect, it } from 'vitest';
import { FIDELITY_VARIANTS } from './dataset.js';
import { formatFidelityReport } from './report.js';
import { FIDELITY_TRIGGER_TOKENS, runFidelityVariant, SummaryDidNotHappenError } from './runner.js';
import type { FidelityModels } from './runner.js';

const contentOf = (message: BaseMessage) =>
  typeof message.content === 'string' ? message.content : JSON.stringify(message.content);

/** 雜訊行：存取日誌與會議室借用紀錄。 */
const NOISE = /^(10\.0\.\d+\.\d+ - - |第 \d+ 筆：)/;

/** 把要摘的對話裡不是雜訊的行原樣留下的摘要模型：事實全在。 */
const KEEPS_EVERYTHING = {
  profile: {},
  invoke: async (input: readonly BaseMessage[]) => ({
    text: input
      .map(contentOf)
      .join('\n')
      .split('\n')
      .filter((line) => !NOISE.test(line))
      .join('\n'),
  }),
};

/** 什麼都沒留下的摘要模型。 */
const DROPS_EVERYTHING = {
  profile: {},
  invoke: async () => ({ text: 'Nothing of note happened.' }),
};

/** 把看到的整串原樣念回來的答題模型：分數只取決於事實有沒有活過摘要。最後一則是題目本身，不算。 */
const echo = async (messages: readonly BaseMessage[]) =>
  messages.slice(0, -1).map(contentOf).join('\n');

const models = (summaryModel: unknown): FidelityModels => ({ summaryModel, ask: echo });

describe('交接保真度評估（#2774）', () => {
  it('四個變體：摘要一次、連續兩次、中文對話、決定被推翻', () => {
    expect(FIDELITY_VARIANTS.map((variant) => variant.id)).toEqual([
      'single',
      'double',
      'zh',
      'overturned',
    ]);
    expect(FIDELITY_VARIANTS.find((variant) => variant.id === 'double')?.segments).toHaveLength(2);
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

  it('連續摘要兩次：第一段的事實經過兩次摘要，第二段的經過一次', async () => {
    const double = FIDELITY_VARIANTS.find((variant) => variant.id === 'double')!;
    const result = await runFidelityVariant(double, models(KEEPS_EVERYTHING));

    const crossed = new Map(
      result.questions.map((question) => [question.questionId, question.summariesCrossed]),
    );
    expect(crossed.get('path')).toBe(2);
    expect(crossed.get('runbook')).toBe(1);
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

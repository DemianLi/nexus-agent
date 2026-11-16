import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { estimateMessageTokens, SUMMARY_ENTRY_INSTRUCTION, SUMMARY_INSTRUCTION } from '@nexus/core';
import { describe, expect, it } from 'vitest';
import { ALL_FIDELITY_VARIANTS, DETAIL_VARIANTS, FIDELITY_VARIANTS } from './dataset.js';
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
    for (const variant of ALL_FIDELITY_VARIANTS) {
      for (const segment of variant.segments) {
        const tokens = segment.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
        expect(tokens, variant.id).toBeGreaterThan(FIDELITY_TRIGGER_TOKENS);
        expect(segment.at(-1)?.getType(), variant.id).toBe('human');
      }
    }
  });

  it('題目的 segment 都指得到一段，該提到的字串在那一段裡找得到', () => {
    for (const variant of ALL_FIDELITY_VARIANTS) {
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

  it.each(ALL_FIDELITY_VARIANTS)('$id：摘要留住事實時滿分，沒有一題落在尾巴裡', async (variant) => {
    const result = await runFidelityVariant(variant, models(KEEPS_EVERYTHING));

    expect(result.summaries).toHaveLength(variant.segments.length);
    expect(result.questions.map((question) => question.leaked)).not.toContain(true);
    expect(result.questions.map((question) => question.inSummary)).not.toContain(false);
    expect(result.score).toBe(1);
  });

  it.each(ALL_FIDELITY_VARIANTS)('$id：摘要什麼都沒留時零分', async (variant) => {
    const result = await runFidelityVariant(variant, models(DROPS_EVERYTHING));

    expect(result.questions.map((question) => question.inSummary)).not.toContain(true);
    expect(result.score).toBe(0);
    expect(result.staleHits).toBe(0);
  });

  it('問題目的那串不含工具訊息', async () => {
    for (const variant of ALL_FIDELITY_VARIANTS) {
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
    for (const variant of ALL_FIDELITY_VARIANTS) {
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
    // 沒命中時工具回的那一句也帶 `matches for` 與 query 本身，所以要正數、而且只看命中的那幾行。
    expect(first.answer).toMatch(/^[1-9]\d* match(es)? for/);
    expect(first.answer.split('\n').slice(1).join('\n').replace(/\s+/g, '')).toContain(
      mention.replace(/\s+/g, ''),
    );
    expect(first).toMatchObject({ requests: 2, recallCalls: 1 });
    expect(firstRequests[0]!.map(contentOf).join('\n')).toContain(
      'call history_search with a literal string',
    );
  });

  it('連續摘要兩次：第一段的原文還讀得回來', async () => {
    const { answerStep } = searches(double);
    const result = await runFidelityVariant(double, { ...models(DROPS_EVERYTHING), answerStep });
    const early = result.questions.find((question) => question.summariesCrossed === 2)!;
    expect(early.answer).toMatch(/^[1-9]\d* match(es)? for/);
    expect(early.answer).toContain('- entry 1, offset');
  });

  it(`一直叫工具：送到第 ${FIDELITY_RECALL_MAX_REQUESTS} 個請求就停，最後那一則的文字當答案`, async () => {
    let requests = 0;
    const result = await runFidelityVariant(single, {
      ...models(DROPS_EVERYTHING),
      answerStep: async () => {
        requests += 1;
        return new AIMessage({
          content: `step ${requests}`,
          tool_calls: [{ id: 'again', name: 'history_read', args: { entry: 1 } }],
        });
      },
    });
    expect(requests).toBe(single.questions.length * FIDELITY_RECALL_MAX_REQUESTS);
    expect(result.questions[0]).toMatchObject({
      answer: `step ${FIDELITY_RECALL_MAX_REQUESTS}`,
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
    expect(seen).toHaveLength(single.questions.length);
    expect(result.questions.every((q) => q.requests === 1 && q.recallCalls === 0)).toBe(true);
  });
});

describe('摘要留不住答案的題目與成對的量法（#2908）', () => {
  const rows = DETAIL_VARIANTS.find((variant) => variant.id === 'rows')!;

  /** 每一題搜題目裡點名的那個鍵（資產標籤、人名、財產編號），再把工具結果念回來。 */
  const searchesKey: NonNullable<FidelityModels['answerStep']> = async (messages) => {
    const last = messages.at(-1)!;
    if (ToolMessage.isInstance(last)) return new AIMessage(contentOf(last));
    const key = /AT-\d+|P31-\d+|(?<=extension of )[A-Z]\w+ \w+|(?<=保管人)\S{3}(?=保管)/.exec(
      contentOf(last),
    )![0];
    return new AIMessage({
      content: '',
      tool_calls: [{ id: 'q', name: 'history_search', args: { query: key, limit: 1 } }],
    });
  };

  it('另一組三個變體，原本那五個裡沒有它們', () => {
    const ids = DETAIL_VARIANTS.map((variant) => variant.id);
    expect(ids).toEqual(['rows', 'rows-zh', 'rows-deep']);
    expect(FIDELITY_VARIANTS).toHaveLength(5);
    for (const id of ids) expect(FIDELITY_VARIANTS.map((variant) => variant.id)).not.toContain(id);
    expect(ALL_FIDELITY_VARIANTS.map((variant) => variant.id)).toEqual([
      ...FIDELITY_VARIANTS.map((variant) => variant.id),
      ...ids,
    ]);
  });

  it('rows-deep 有三段，題目的事實都在第一段', () => {
    const deep = DETAIL_VARIANTS.find((variant) => variant.id === 'rows-deep')!;
    expect(deep.segments).toHaveLength(3);
    expect(deep.questions.map((question) => question.segment)).toEqual([0, 0, 0, 0, 0]);
  });

  it('題目用來發問的鍵在各自的清冊或名單裡只出現一次', () => {
    for (const variant of DETAIL_VARIANTS) {
      const text = variant.segments.flat().map(contentOf).join('\n');
      for (const question of variant.questions) {
        const key = /AT-\d+|P31-\d+|(?<=extension of )[A-Z]\w+ \w+|(?<=保管人)\S{3}(?=保管)/.exec(
          question.prompt,
        )![0];
        expect(text.split(key), `${variant.id}/${question.id}`).toHaveLength(2);
      }
    }
  });

  it('答案只出現在清冊的那一列或名單的那一筆：題目本身與別的訊息裡都沒有', () => {
    for (const variant of DETAIL_VARIANTS) {
      const text = variant.segments.flat().map(contentOf).join('\n');
      for (const question of variant.questions) {
        expect(question.kind).toBe('detail');
        for (const needle of question.mentions) {
          expect(question.prompt, `${variant.id}/${question.id}`).not.toContain(needle);
          expect(text.split(needle), `${variant.id}/${question.id}`).toHaveLength(2);
        }
      }
    }
  });

  it.each(DETAIL_VARIANTS)(
    '$id：摘要什麼都沒留，照題目裡的鍵搜得回那一列，滿分',
    async (variant) => {
      const result = await runFidelityVariant(variant, {
        ...models(DROPS_EVERYTHING),
        answerStep: searchesKey,
      });
      expect(result.questions.map((question) => question.inSummary)).not.toContain(true);
      expect(result.questions.map((question) => question.recallCalls)).not.toContain(0);
      expect(result.score).toBe(1);
    },
  );

  it('rows-zh 的反查題：history_search 回的片段裡，人名那一行就是答案那一列', async () => {
    const zh = DETAIL_VARIANTS.find((variant) => variant.id === 'rows-zh')!;
    const result = await runFidelityVariant(zh, {
      ...models(DROPS_EVERYTHING),
      // 只念人名所在的那一行：片段把列併在一起的話，這一行會帶到別列的編號。
      answerStep: async (messages, tools) => {
        const last = messages.at(-1)!;
        if (!ToolMessage.isInstance(last)) return searchesKey(messages, tools);
        const key = /"(.+?)"/.exec(contentOf(last))![1]!;
        const line = contentOf(last)
          .split('\n')
          .slice(1)
          .find((each) => each.includes(key));
        return new AIMessage(line ?? '');
      },
    });

    const reverse = result.questions.filter((question) => question.questionId.startsWith('tag-'));
    expect(reverse).toHaveLength(2);
    for (const question of reverse) {
      expect(question.score, question.questionId).toBe(1);
      expect(question.answer.match(/P31-\d+/g), question.questionId).toHaveLength(1);
    }
  });

  it('成對：同一題先不帶工具問一次，兩次看到的訊息相同，各記各的分數', async () => {
    const order: string[] = [];
    const withoutTools: string[] = [];
    const withTools: string[] = [];
    const result = await runFidelityVariant(rows, {
      summaryModel: DROPS_EVERYTHING,
      ask: async (messages) => {
        order.push('without');
        withoutTools.push(messages.map(contentOf).join('\n'));
        return 'I do not know.';
      },
      answerStep: async (messages, tools) => {
        if (!ToolMessage.isInstance(messages.at(-1)!)) {
          order.push('with');
          withTools.push(messages.map(contentOf).join('\n'));
        }
        return searchesKey(messages, tools);
      },
      paired: true,
    });

    expect(order).toEqual(rows.questions.flatMap(() => ['without', 'with']));
    expect(withoutTools).toEqual(withTools);
    expect(withoutTools).toHaveLength(rows.questions.length);
    expect(result.score).toBe(1);
    expect(result.scoreWithoutTools).toBe(0);
    expect(result.questions[0]?.withoutTools).toEqual({
      answer: 'I do not know.',
      score: 0,
      staleHit: false,
    });
  });

  it('不成對時沒有不帶工具那一格', async () => {
    const result = await runFidelityVariant(rows, {
      ...models(DROPS_EVERYTHING),
      answerStep: searchesKey,
    });
    expect(result.scoreWithoutTools).toBeUndefined();
    expect(result.questions.every((question) => question.withoutTools === undefined)).toBe(true);
  });

  it('報表照摘要裡有沒有答案分開算，成對時多印不帶工具的分數', async () => {
    const kept = await runFidelityVariant(rows, models(KEEPS_EVERYTHING));
    const dropped = await runFidelityVariant(rows, {
      summaryModel: DROPS_EVERYTHING,
      ask: async () => 'I do not know.',
      answerStep: searchesKey,
      paired: true,
    });
    const report = formatFidelityReport([[kept], [dropped]]);
    const count = rows.questions.length;

    expect(report).toContain(`摘要裡有答案  ${count} 題次  得分 1.00`);
    expect(report).toContain(
      `摘要裡沒有答案  ${count} 題次  得分 1.00  不帶工具 0.00  叫了讀回工具 ${count}/${count}（叫了的得分 1.00）`,
    );
  });

  it('報表：沒有一題摘要裡沒有答案時，那一類印 0 題次', async () => {
    const kept = await runFidelityVariant(rows, models(KEEPS_EVERYTHING));
    expect(formatFidelityReport([[kept]])).toContain('摘要裡沒有答案  0 題次');
  });
});

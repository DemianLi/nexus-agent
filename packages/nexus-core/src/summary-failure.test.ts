/**
 * **生摘要那次模型呼叫失敗時的處理**——[#1374](https://github.com/DemianLi/nexus-agent/issues/1374)。
 *
 * 照 dsh `compaction-basic`（`src/index.ts`）分兩條，我們的觸發方式對得上：
 *
 * | 誰觸發 | dsh 對應 | 摘要失敗時 |
 * | --- | --- | --- |
 * | 我們自己的門檻（token 預算合成的超窗、或訊息數） | `agent/pre-step` 的 pressure（`:158-175`） | warn，照原請求送出去（continuing the turn） |
 * | 端點真的回超窗 | `agent/request-error` 的 context-overflow（`:205-224`） | warn，**保留原本的請求錯誤** |
 *
 * 卡面原本寫「保留原錯誤」兩條通用，但預算層合成的超窗不是任何真的請求錯誤——拋出去使用者只會看到我們自己寫的
 * 「摘要預算：…」那句。所以兩條各一個測試，再做一條突變：把兩條的處理對調，兩條都要紅。
 *
 * 不發明修剪或退回策略（`trimTokensToSummarize` 不設）。
 */

import { ContextOverflowError } from '@langchain/core/errors';
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { createSummarizer, DEFAULT_SUMMARIZATION } from './summarization.js';
import type { SummarizationSettings } from './summarization.js';
import { TokenAnchorBook } from './token-estimate.js';

const BIG = '這是一段很長的內容。'.repeat(300);
const conversation = (): BaseMessage[] => [
  new HumanMessage(BIG),
  new AIMessage('一'),
  new HumanMessage('二'),
  new AIMessage('三'),
  new HumanMessage('四'),
  new AIMessage('五'),
  new HumanMessage('短問題'),
];

/** 摘要模型：`invoke` 依 `fail` 拋錯或回摘要。 */
function summaryModel(fail?: () => Error) {
  let invokes = 0;
  return {
    get invokes() {
      return invokes;
    },
    profile: {},
    invoke: async () => {
      invokes += 1;
      if (fail !== undefined) throw fail();
      return { text: '這是摘要。' };
    },
  };
}

async function run(options: {
  settings?: Partial<SummarizationSettings>;
  summaryFails?: () => Error;
  /** 第幾次呼叫（1 起算）要拋、拋什麼；其餘回 `好。`。 */
  handlerThrows?: (call: number) => Error | undefined;
}) {
  const reports: string[] = [];
  const model = summaryModel(options.summaryFails);
  const middleware = createSummarizer(
    { write: async (path: string) => ({ path }) } as never,
    { ...DEFAULT_SUMMARIZATION, retainTokens: 1, ...options.settings },
    new TokenAnchorBook(),
    undefined,
    false,
    undefined,
    undefined,
    (message) => reports.push(message),
  );
  const handled: BaseMessage[][] = [];
  const outcome = await (async () => {
    try {
      return {
        result: await middleware.wrapModelCall?.(
          {
            messages: conversation(),
            state: {},
            model,
            systemMessage: new SystemMessage('系統。'),
            tools: [],
          } as never,
          ((request: { messages: BaseMessage[] }) => {
            handled.push(request.messages);
            const error = options.handlerThrows?.(handled.length);
            if (error !== undefined) throw error;
            return new AIMessage('好。');
          }) as never,
        ),
      };
    } catch (error) {
      return { error };
    }
  })();
  return { ...outcome, reports, handled, model };
}

const TOKEN_TRIGGER: Partial<SummarizationSettings> = {
  trigger: [{ type: 'tokens', value: 2_000 }],
};

describe('摘要失敗：我們自己的門檻觸發（dsh 的 pressure 路徑）', () => {
  it('預算門檻合成的超窗、摘要壞了：warn 一條，照原請求送出去，不拋', async () => {
    const out = await run({
      settings: TOKEN_TRIGGER,
      summaryFails: () => new Error('摘要模型當場炸了'),
    });
    expect(out.error).toBeUndefined();
    expect((out.result as AIMessage).content).toBe('好。');
    // 送出去的是原請求：七則一則沒少，也不是摘要過的。
    expect(out.handled).toHaveLength(1);
    expect(out.handled[0]).toHaveLength(7);
    expect(String(out.handled[0]![0]!.content)).toBe(BIG);
    expect(out.reports).toHaveLength(1);
    expect(out.reports[0]).toContain('摘要模型當場炸了');
    expect(out.reports[0]).toContain('照原請求送出');
    expect(out.model.invokes).toBe(1);
  });

  it('訊息數門檻觸發、摘要壞了：同一條路', async () => {
    const out = await run({
      settings: { trigger: [{ type: 'messages', value: 3 }] },
      summaryFails: () => new Error('摘要模型當場炸了'),
    });
    expect(out.error).toBeUndefined();
    expect(out.handled).toHaveLength(1);
    expect(out.handled[0]).toHaveLength(7);
    expect(out.reports[0]).toContain('照原請求送出');
  });
});

describe('摘要失敗：端點真的回超窗（dsh 的 overflow 路徑）', () => {
  it('留下原本的請求錯誤（同一個物件），不是摘要那個錯；warn 一條', async () => {
    const endpointError = new ContextOverflowError('端點說：超窗了');
    const out = await run({
      // 門檻開很大：我們自己的預算不會合成超窗，是端點回的。
      settings: { trigger: [{ type: 'tokens', value: 900_000 }] },
      summaryFails: () => new Error('摘要模型當場炸了'),
      handlerThrows: (call) => (call === 1 ? endpointError : undefined),
    });
    expect(out.result).toBeUndefined();
    expect(out.error).toBe(endpointError);
    expect(out.reports).toHaveLength(1);
    expect(out.reports[0]).toContain('摘要模型當場炸了');
    expect(out.reports[0]).toContain('保留原本的請求錯誤');
    // 沒有再送一次原請求：端點已經說裝不下了。
    expect(out.handled).toHaveLength(1);
  });
});

describe('摘要失敗的處理只認「生摘要那次」', () => {
  it('摘要成功、之後的模型呼叫才失敗：錯照原樣冒出去，不當成摘要壞了、也不退回原請求', async () => {
    const network = new Error('網路斷了');
    const out = await run({
      settings: TOKEN_TRIGGER,
      handlerThrows: () => network,
    });
    expect(out.error).toBe(network);
    expect(out.reports).toEqual([]);
    expect(out.model.invokes).toBe(1);
  });

  it('使用者按停止（AbortError）：不吞、不記 warn', async () => {
    const abort = Object.assign(new Error('中止'), { name: 'AbortError' });
    const out = await run({ settings: TOKEN_TRIGGER, summaryFails: () => abort });
    expect(out.error).toBe(abort);
    expect(out.reports).toEqual([]);
  });

  it('摘要沒壞、也沒超窗：不經過這條路', async () => {
    const out = await run({ settings: TOKEN_TRIGGER });
    expect(out.error).toBeUndefined();
    expect(out.reports).toEqual([]);
  });
});

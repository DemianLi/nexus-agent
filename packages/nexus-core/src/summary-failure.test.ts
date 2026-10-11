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
import {
  createSummarizer,
  DEFAULT_SUMMARIZATION,
  readSummarizationEvent,
} from './summarization.js';
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
  messages?: readonly BaseMessage[];
  state?: Record<string, unknown>;
  settings?: Partial<SummarizationSettings>;
  /** 給了就是有型錄的模型：保留量走出廠的 `retainRatio`，不是測試預設的 1 token。 */
  limits?: { contextWindow: number; maxOutputTokens: number };
  summaryFails?: () => Error;
  /** 第幾次呼叫（1 起算）要拋、拋什麼；其餘回 `好。`。 */
  handlerThrows?: (call: number) => Error | undefined;
}) {
  const reports: string[] = [];
  const writes: string[] = [];
  const model = summaryModel(options.summaryFails);
  const limits = options.limits;
  const middleware = createSummarizer(
    {
      write: async (path: string) => {
        writes.push(path);
        return { path };
      },
    } as never,
    {
      ...DEFAULT_SUMMARIZATION,
      ...(limits === undefined ? { retainTokens: 1 } : {}),
      ...options.settings,
    },
    new TokenAnchorBook(),
    undefined,
    false,
    limits === undefined ? undefined : () => limits,
    undefined,
    (message) => reports.push(message),
  );
  const handled: BaseMessage[][] = [];
  const outcome = await (async () => {
    try {
      return {
        result: await middleware.wrapModelCall?.(
          {
            messages: options.messages ?? conversation(),
            state: options.state ?? {},
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
  return { ...outcome, reports, handled, model, writes };
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

  /**
   * **退回的是「沒動手摘要時本來會往下交的那份」，不是 `request.messages` 的原串。** graph state 的 `messages` 一直長，
   * 摘要之前的舊訊息還在裡面；已經摘要過的 thread，第二次摘要壞了不能把整段摘要前的歷史原封送給端點。
   * （dsh 的 continuing the turn 送的是目前的 surface。）
   */
  it('state 帶著舊的摘要事件：退回送的是「摘要＋切點之後」，不是原串', async () => {
    const messages: BaseMessage[] = [
      ...Array.from({ length: 6 }, (_, index) => new HumanMessage(`舊的第 ${index} 則`)),
      new HumanMessage(BIG),
      new AIMessage('六'),
      new HumanMessage('七'),
      new AIMessage('八'),
    ];
    const out = await run({
      messages,
      state: {
        _summarizationEvent: {
          cutoffIndex: 6,
          summaryMessage: new HumanMessage('舊摘要。'),
          filePath: '/conversation_history/session_x.md',
        },
      },
      settings: TOKEN_TRIGGER,
      summaryFails: () => new Error('摘要模型當場炸了'),
    });
    expect(out.error).toBeUndefined();
    expect(out.handled).toHaveLength(1);
    const sent = out.handled[0]!;
    expect(sent).toHaveLength(5);
    expect(String(sent[0]!.content)).toBe('舊摘要。');
    expect(String(sent[1]!.content)).toBe(BIG);
    // 原串裡切點之前的舊訊息一則都沒有被送出去。
    expect(sent.map((message) => String(message.content))).not.toContain('舊的第 0 則');
  });

  it('摘要那次呼叫自己拋 ContextOverflowError（生摘要那顆也裝不下）：同樣不拋、照原請求送出', async () => {
    const out = await run({
      settings: TOKEN_TRIGGER,
      summaryFails: () => new ContextOverflowError('摘要請求本身超窗'),
    });
    expect(out.error).toBeUndefined();
    expect(out.handled).toHaveLength(1);
    expect(out.handled[0]).toHaveLength(7);
    expect(out.reports[0]).toContain('摘要請求本身超窗');
    // 基座沒有把它當成可恢復的超窗再摘一次：摘要模型只被叫一次。
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

/**
 * **尾巴蓋住全部：門檻到了，但沒有東西可摘。** 出廠設定下小訊息的對話就是這樣——訊息數門檻（60）到了，
 * 20,000 token 的尾巴還裝得下整段對話，基座算出 `cutoffIndex <= 0`，直接把請求送出去。
 *
 * 這種情況每一步都會遇到，所以釘死四件事：**不叫摘要模型、不寫歷史檔、不記壓縮事件、不 warn**，請求原樣照送。
 * 多花一次呼叫或多寫一筆事件，就是每一步都在浪費。
 */
describe('門檻到了，但尾巴蓋住全部：什麼都不做', () => {
  it('訊息數門檻觸發、尾巴蓋住整段：不摘要、不寫檔、不記事件、不 warn，原請求照送', async () => {
    const out = await run({
      limits: { contextWindow: 700_045, maxOutputTokens: 16_384 },
      settings: { trigger: [{ type: 'messages', value: 3 }] },
      // 就算摘要模型會壞，也不該被叫到：壞了也不會有 warn。
      summaryFails: () => new Error('不該被叫到'),
    });
    expect(out.error).toBeUndefined();
    expect(out.model.invokes).toBe(0);
    expect(out.writes).toEqual([]);
    expect(out.reports).toEqual([]);
    expect(readSummarizationEvent(out.result)).toBeUndefined();
    expect(out.handled).toHaveLength(1);
    expect(out.handled[0]).toHaveLength(7);
    expect(String(out.handled[0]![0]!.content)).toBe(BIG);
    expect((out.result as AIMessage).content).toBe('好。');
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

describe('端點的超窗被一層層包起來（每顆 middleware 一層 MiddlewareError）', () => {
  it('埋在十幾層 cause 底下仍認得是超窗：走「保留原本的請求錯誤」，不當成自己的門檻觸發', async () => {
    let wrapped: Error = new ContextOverflowError('端點說：超窗了');
    for (let layer = 0; layer < 16; layer += 1)
      wrapped = new Error(wrapped.message, { cause: wrapped });
    const out = await run({
      settings: { trigger: [{ type: 'tokens', value: 900_000 }] },
      summaryFails: () => new Error('摘要模型當場炸了'),
      handlerThrows: (call) => (call === 1 ? wrapped : undefined),
    });
    expect(out.error).toBe(wrapped);
    expect(out.handled).toHaveLength(1);
    expect(out.reports[0]).toContain('保留原本的請求錯誤');
  });
});

describe('摘要請求本身超窗，而端點也回了超窗', () => {
  it('兩個都是超窗：還給呼叫端的仍是端點那一個，不是摘要請求的', async () => {
    const endpointError = new ContextOverflowError('端點說：超窗了');
    const out = await run({
      settings: { trigger: [{ type: 'tokens', value: 900_000 }] },
      summaryFails: () => new ContextOverflowError('摘要請求本身超窗'),
      handlerThrows: (call) => (call === 1 ? endpointError : undefined),
    });
    expect(out.error).toBe(endpointError);
    expect(out.model.invokes).toBe(1);
    expect(out.reports[0]).toContain('保留原本的請求錯誤');
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

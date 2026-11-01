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
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import o200k_base from 'gpt-tokenizer/encoding/o200k_base';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createSummarizer,
  DEFAULT_SUMMARIZATION,
  readSummarizationEvent,
} from './summarization.js';
import type { SummarizationSettings } from './summarization.js';
import { estimateMessageTokens, TokenAnchorBook } from './token-estimate.js';

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

/**
 * **可取代的只剩上一顆摘要：一樣什麼都不做**（[#2086](https://github.com/DemianLi/nexus-agent/issues/2086)）。
 *
 * 出廠的保留量是 20,000 token。尾巴裡有一則自己就撐過保留量的大工具結果時，切點停在它的工具呼叫前面；之後新進來的小訊息
 * 推不動它，切點前面只剩上一顆摘要。訊息數一直在 60 以上，每一步都觸發；摘了也只是拿新摘要換舊摘要，沒有新內容可卸。
 * 所以跟上面那條一樣，當成沒有東西可摘：不打摘要模型、不 warn、不提交。
 */
describe('可取代的只剩上一顆摘要：不打摘要模型', () => {
  const FACTORY_LIMITS = { contextWindow: 700_045, maxOutputTokens: 16_384 };
  const previousSummary = () =>
    new HumanMessage({ content: '舊摘要。', additional_kwargs: { lc_source: 'summarization' } });
  const GIANT = 'x'.repeat(200_000);
  /** 摘要事件套用之後是 `[舊摘要, 工具呼叫, 大結果, ...small 則小訊息]`；切點之前的舊訊息只在原串裡。 */
  const stuck = (small: number) => {
    const old = Array.from({ length: 4 }, (_, index) => new HumanMessage(`舊的第 ${index} 則`));
    const tail: BaseMessage[] = [
      new AIMessage({ content: '', tool_calls: [{ id: 'read-1', name: 'read_file', args: {} }] }),
      new ToolMessage({ content: GIANT, tool_call_id: 'read-1' }),
      ...Array.from({ length: small }, (_, index) =>
        index % 2 === 0 ? new HumanMessage(`第 ${index} 句`) : new AIMessage(`第 ${index} 答`),
      ),
    ];
    return {
      messages: [...old, ...tail],
      state: {
        _summarizationEvent: {
          cutoffIndex: old.length,
          summaryMessage: previousSummary(),
          filePath: '/conversation_history/session_x.md',
        },
      },
    };
  };

  it('前提：大結果自己撐過出廠保留量，後面的小訊息加起來推不過它', () => {
    const { messages } = stuck(64);
    expect(estimateMessageTokens(messages[5]!)).toBeGreaterThanOrEqual(20_000);
    const smalls = messages.slice(6).reduce((sum, m) => sum + estimateMessageTokens(m), 0);
    expect(smalls).toBeLessThan(20_000);
  });

  it('連跑三步、每步多兩則：都不打摘要模型、不 warn、不提交，送的是「舊摘要＋切點之後」', async () => {
    for (const small of [60, 62, 64]) {
      const { messages, state } = stuck(small);
      const out = await run({ messages, state, limits: FACTORY_LIMITS });
      expect(out.error).toBeUndefined();
      expect(out.model.invokes).toBe(0);
      expect(out.reports).toEqual([]);
      expect(readSummarizationEvent(out.result)).toBeUndefined();
      expect(out.handled).toHaveLength(1);
      expect(out.handled[0]).toHaveLength(small + 3);
      expect(String(out.handled[0]![0]!.content)).toBe('舊摘要。');
    }
  });

  it('切點前除了舊摘要還有別的：照常摘要', async () => {
    const { messages, state } = stuck(62);
    // 工具呼叫前面多一則：切點前是 `[舊摘要, 這一則]`。
    messages.splice(4, 0, new HumanMessage('切點前多一則'));
    const out = await run({ messages, state, limits: FACTORY_LIMITS });
    expect(out.model.invokes).toBe(1);
  });

  it('後面再來一則撐得過保留量的訊息：切點往前，摘要照常提交', async () => {
    const { messages, state } = stuck(60);
    messages.push(new HumanMessage('y'.repeat(200_000)));
    const out = await run({ messages, state, limits: FACTORY_LIMITS });
    expect(out.model.invokes).toBe(1);
    expect(readSummarizationEvent(out.result)).toBeDefined();
    expect(out.reports).toEqual([]);
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

/**
 * **摘要生出來了，但不比它取代的那段小：不提交**（[#1396](https://github.com/DemianLi/nexus-agent/issues/1396)）。
 *
 * 照 dsh `compaction-basic` 的 shrink 檢查（`region.ts:417-420`，`framedSummaryTokenCount >= shadowedRouteTokenCount` 就拋）。
 * 拋出來的錯記進「摘要這一格壞了」的那份名單，所以走上面 #1383 既有的兩條路，不另開第三條：自己的門檻觸發就 warn、
 * 照原請求送；端點真的超窗就 warn、保留原本的請求錯誤。
 *
 * 量具兩邊同一把（`estimateMessageTokens`）。**偏離 dsh**：它用 route price，我們沒有逐路由計價（#1383 的 D3 同一個理由）。
 */
describe('摘要不比被取代的小', () => {
  /** 七則都短：被取代的那段一定比「框架＋歷史檔路徑」小。 */
  const tiny = (): BaseMessage[] => [
    new HumanMessage('問'),
    new AIMessage('答'),
    new HumanMessage('二'),
    new AIMessage('三'),
    new HumanMessage('四'),
    new AIMessage('五'),
    new HumanMessage('短問題'),
  ];

  it('我們自己的門檻觸發：warn 一條，照原請求送出去，不提交、不拋', async () => {
    const out = await run({
      messages: tiny(),
      settings: { trigger: [{ type: 'messages', value: 3 }] },
    });
    expect(out.error).toBeUndefined();
    // 摘要真的生出來過（所以才有得比），然後被擋下。
    expect(out.model.invokes).toBe(1);
    // 送出去的是原請求：七則一則沒少，第一則不是摘要。
    expect(out.handled).toHaveLength(1);
    expect(out.handled[0]).toHaveLength(7);
    expect(String(out.handled[0]![0]!.content)).toBe('問');
    // 沒有提交：回的是模型的回應，不是帶 `_summarizationEvent` 的 Command。
    expect(readSummarizationEvent(out.result)).toBeUndefined();
    expect((out.result as AIMessage).content).toBe('好。');
    // 正好一條 warn，說的是這件事，走的是 #1383 那條「照原請求送出」。
    expect(out.reports).toHaveLength(1);
    expect(out.reports[0]).toContain('不比被取代');
    expect(out.reports[0]).toContain('照原請求送出');
  });

  it('端點真的回超窗：保留原本的請求錯誤（同一個物件），warn 一條，不再重送', async () => {
    const endpointError = new ContextOverflowError('端點說：超窗了');
    const out = await run({
      messages: tiny(),
      // 門檻開很大：我們自己的預算不會合成超窗，是端點回的。
      settings: { trigger: [{ type: 'tokens', value: 900_000 }] },
      handlerThrows: (call) => (call === 1 ? endpointError : undefined),
    });
    expect(out.error).toBe(endpointError);
    expect(out.model.invokes).toBe(1);
    expect(out.handled).toHaveLength(1);
    expect(out.reports).toHaveLength(1);
    expect(out.reports[0]).toContain('不比被取代');
    expect(out.reports[0]).toContain('保留原本的請求錯誤');
  });

  it('擋下時報的被取代量是整段的總和', async () => {
    const messages = tiny();
    const out = await run({ messages, settings: { trigger: [{ type: 'messages', value: 3 }] } });
    const reported = Number(/被取代的 (\d+) token/.exec(out.reports[0] ?? '')?.[1]);
    const whole = messages
      .slice(0, 6)
      .reduce((total, message) => total + estimateMessageTokens(message), 0);
    expect(reported).toBe(whole);
  });

  /** 大工具結果被剪過之後是新字串，整段量完是一次冷編碼，見 `assertSummaryShrinks`。 */
  it('累加到超過摘要就放行，後面的訊息不編碼', async () => {
    const page = (word: string) => `${word} `.repeat(400);
    const first = `first${randomUUID()}`;
    const later = `later${randomUUID()}`;
    const encode = vi.spyOn(o200k_base, 'encode');
    try {
      const out = await run({
        messages: [
          new HumanMessage(page(first)),
          new AIMessage(page(later)),
          new HumanMessage(page(later)),
          new HumanMessage('短問題'),
        ],
        settings: { trigger: [{ type: 'messages', value: 3 }] },
      });
      expect(readSummarizationEvent(out.result)).toBeDefined();
      const sent = encode.mock.calls.map(([text]) => text);
      expect(sent.some((text) => text.includes(first))).toBe(true);
      expect(sent.some((text) => text.includes(later))).toBe(false);
    } finally {
      encode.mockRestore();
    }
  });

  it('被取代的遠比摘要大：照常提交，沒有 warn', async () => {
    const out = await run({ settings: { trigger: [{ type: 'messages', value: 3 }] } });
    expect(out.error).toBeUndefined();
    expect(readSummarizationEvent(out.result)).toBeDefined();
    expect(String(out.handled[0]![0]!.content)).toContain('這是摘要。');
    expect(out.reports).toEqual([]);
  });

  /**
   * **邊界：框好的摘要與被取代的那段一樣大。** dsh 是 `>=`，所以一樣大也不提交；要是寫成 `>`，這一條翻成提交。
   *
   * 被取代的那段取一則純文字，字數逐字加到它的估計值剛好等於、再多一格（`framed + 1`）：兩個都在，才有「剛好等於」可量。
   */
  it('一樣大：不提交；只大一個 token：提交', async () => {
    // 歷史檔路徑固定：框好的摘要裡帶著它，隨機的 session id 會讓估計值在兩次執行之間差幾個 token。
    const state = { _summarizationSessionId: 'session_fixed01' };
    const committed = await run({ state, settings: { trigger: [{ type: 'messages', value: 3 }] } });
    const framed = estimateMessageTokens(committed.handled[0]![0]!);

    const textOf = (chars: number) => new HumanMessage('字'.repeat(chars));
    let equal = -1;
    let plusOne = -1;
    for (let chars = 1; chars <= 4_000 && plusOne < 0; chars += 1) {
      const tokens = estimateMessageTokens(textOf(chars));
      if (tokens === framed && equal < 0) equal = chars;
      if (tokens === framed + 1 && plusOne < 0) plusOne = chars;
    }
    // 前提：兩個長度都找得到，不然下面比的不是「剛好等於」。
    expect(equal).toBeGreaterThan(0);
    expect(plusOne).toBeGreaterThan(0);

    const attempt = (chars: number) =>
      run({
        messages: [textOf(chars), new HumanMessage('短問題')],
        state,
        settings: { trigger: [{ type: 'messages', value: 2 }] },
      });

    const same = await attempt(equal);
    expect(readSummarizationEvent(same.result)).toBeUndefined();
    expect(same.reports).toHaveLength(1);
    expect(same.reports[0]).toContain('不比被取代');
    expect(same.handled[0]).toHaveLength(2);

    const bigger = await attempt(plusOne);
    expect(readSummarizationEvent(bigger.result)).toBeDefined();
    expect(bigger.reports).toEqual([]);
  });
});

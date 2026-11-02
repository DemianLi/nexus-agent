/**
 * **端點真的回超窗時，緊急摘要不保留尾巴（retain 0）**——[#1381](https://github.com/DemianLi/nexus-agent/issues/1381)。
 *
 * dsh `compaction-basic` 在端點確認超窗時繞過保留政策（`src/index.ts:262`「overflow bypasses the normal threshold and
 * retained-tail policy」），`:294` 起呼叫 `selectCompactableRange(session, measurement, 0)`：retain 取 0，只留工具配對
 * 需要的尾巴；`retainTokens` 只用在 pressure 路徑。
 *
 * 我們的兩條觸發走同一顆基座與同一個保留量：預算層合成的超窗（我們自己的門檻到了）與端點真的超窗。後者端點已經說
 * 「裝不下」，再留 20,000 token 的尾巴，壓完可能還是裝不下。這一檔把兩條分開釘：
 *
 * | 誰觸發 | 尾巴 |
 * | --- | --- |
 * | 預算層合成的超窗 | 照 `retainRatio` 算的保留量（尾巴蓋住全部時什麼都不摘） |
 * | 端點真的超窗 | 只留最新一則加上工具配對需要的 |
 *
 * 真端點超窗的錯誤形狀沒量到（#1369 三次探測都在連線層失敗），這裡在假端點上釘住「怎麼認出是真超窗」：
 * **錯誤鏈上有 `ContextOverflowError`（`isInstance`，不設深度上限）而且它不是我們自己合成的那一顆。**
 */

import { ContextOverflowError } from '@langchain/core/errors';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import {
  createSummarizer,
  DEFAULT_SUMMARIZATION,
  isRealOverflow,
  readSummarizationEvent,
  syntheticOverflow,
} from './summarization.js';
import type { SummarizationSettings } from './summarization.js';
import { TokenAnchorBook } from './token-estimate.js';

const BIG = '這是一段很長的內容。'.repeat(300);
/** 出廠預設那顆：保留量夾到 20,000 token，遠大於整段對話。 */
const CATALOG = { contextWindow: 700_045, maxOutputTokens: 16_384 };

const conversation = (): BaseMessage[] => [
  new HumanMessage(BIG),
  new AIMessage('一'),
  new HumanMessage('二'),
  new AIMessage('三'),
  new HumanMessage('四'),
  new AIMessage('五'),
  new HumanMessage('短問題'),
];

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
  settings?: Partial<SummarizationSettings>;
  limits?: typeof CATALOG;
  summaryFails?: () => Error;
  /** 第幾次呼叫（1 起算）要拋什麼；其餘回 `好。`。 */
  handlerThrows?: (call: number) => Error | undefined;
}) {
  const reports: string[] = [];
  const model = summaryModel(options.summaryFails);
  const limits = options.limits ?? CATALOG;
  const middleware = createSummarizer(
    { write: async (path: string) => ({ path }) } as never,
    { ...DEFAULT_SUMMARIZATION, ...options.settings },
    new TokenAnchorBook(),
    undefined,
    false,
    () => limits,
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

/** 兩條觸發都不靠訊息數：端點超窗只會走「基座接住 handler 的超窗」那條。 */
const HIGH_TOKEN_TRIGGER: Partial<SummarizationSettings> = {
  trigger: [{ type: 'tokens', value: 900_000 }],
};

const texts = (messages: readonly BaseMessage[]) =>
  messages.map((message) => String(message.content));

describe('端點真的回超窗：retain 0', () => {
  it('尾巴原本蓋住全部：還是摘要，只留最新一則', async () => {
    const out = await run({
      settings: HIGH_TOKEN_TRIGGER,
      handlerThrows: (call) =>
        call === 1
          ? new ContextOverflowError('Input exceeded the model context window.')
          : undefined,
    });

    expect(out.error).toBeUndefined();
    expect(out.model.invokes).toBe(1);
    // 第一次是原請求（拋了超窗），第二次是摘要之後的請求。
    expect(out.handled).toHaveLength(2);
    expect(out.handled[0]).toHaveLength(7);
    expect(texts(out.handled[1]!)).toHaveLength(2);
    expect(texts(out.handled[1]!)[1]).toBe('短問題');
    expect(out.reports).toEqual([]);
    expect(readSummarizationEvent(out.result)?.cutoffIndex).toBe(6);
  });

  /**
   * 對照：預算層合成的超窗不算。同一份對話、同一個保留量——尾巴蓋住全部，沒有東西可摘，請求照原樣送出去，
   * 摘要模型一次都不叫。
   */
  it('預算層合成的超窗不繞過保留量：尾巴蓋住全部時什麼都不摘', async () => {
    const out = await run({ settings: { trigger: [{ type: 'tokens', value: 2_000 }] } });

    expect(out.error).toBeUndefined();
    expect(out.model.invokes).toBe(0);
    expect(out.handled).toHaveLength(1);
    expect(out.handled[0]).toHaveLength(7);
    expect(out.reports).toEqual([]);
  });

  it('工具呼叫與結果的配對不拆：尾巴是最新一則加上它的呼叫', async () => {
    const messages: BaseMessage[] = [
      new HumanMessage(BIG),
      new AIMessage('先看看'),
      new HumanMessage('去查'),
      new AIMessage({
        content: '',
        tool_calls: [{ id: 'call_1', name: 'lookup', args: { q: 'x' }, type: 'tool_call' }],
      }),
      new ToolMessage({ content: '結果', tool_call_id: 'call_1' }),
    ];
    const out = await run({
      messages,
      settings: HIGH_TOKEN_TRIGGER,
      handlerThrows: (call) =>
        call === 1
          ? new ContextOverflowError('Input exceeded the model context window.')
          : undefined,
    });

    expect(out.error).toBeUndefined();
    const sent = out.handled[1]!;
    // 摘要 + 呼叫 + 結果：最新一則是 ToolMessage，它的呼叫跟著留下。
    expect(sent).toHaveLength(3);
    expect(ToolMessage.isInstance(sent[2])).toBe(true);
    expect(AIMessage.isInstance(sent[1])).toBe(true);
  });

  it('埋在十幾層 cause 底下的端點超窗也認得（MiddlewareError 每顆 middleware 包一層）', async () => {
    let wrapped: Error = new ContextOverflowError('端點說：超窗了');
    for (let layer = 0; layer < 16; layer += 1)
      wrapped = new Error(wrapped.message, { cause: wrapped });
    const failure = wrapped;
    const out = await run({
      settings: HIGH_TOKEN_TRIGGER,
      handlerThrows: (call) => (call === 1 ? failure : undefined),
    });

    expect(out.error).toBeUndefined();
    expect(out.model.invokes).toBe(1);
    expect(texts(out.handled[1]!)).toHaveLength(2);
  });

  it('摘要之後仍然超窗：照原樣往外走，不洩出內部訊號', async () => {
    const stubborn = new ContextOverflowError('摘要之後還是裝不下');
    const out = await run({
      settings: HIGH_TOKEN_TRIGGER,
      handlerThrows: () => stubborn,
    });

    expect(out.error).toBe(stubborn);
    expect(String(out.error)).not.toContain('EndpointOverflowSignal');
  });

  it('只有一則：沒有東西可摘，錯照原樣往外走', async () => {
    const original = new ContextOverflowError('端點說：超窗了');
    const out = await run({
      messages: [new HumanMessage(BIG)],
      settings: HIGH_TOKEN_TRIGGER,
      handlerThrows: () => original,
    });

    expect(out.error).toBe(original);
    expect(out.model.invokes).toBe(0);
  });

  it('retain 0 的摘要自己壞了：保留原本的請求錯誤（同一個物件），warn 一條', async () => {
    const original = new ContextOverflowError('端點說：超窗了');
    const out = await run({
      settings: HIGH_TOKEN_TRIGGER,
      summaryFails: () => new Error('摘要模型當場炸了'),
      handlerThrows: (call) => (call === 1 ? original : undefined),
    });

    expect(out.error).toBe(original);
    expect(out.reports).toHaveLength(1);
    expect(out.reports[0]).toContain('保留原本的請求錯誤');
  });

  it('已經是最小尾巴（保留量小於等於 retain 0 的）時不升級：行為與從前相同', async () => {
    const out = await run({
      settings: { ...HIGH_TOKEN_TRIGGER, retainTokens: 1, retainRatio: undefined },
      handlerThrows: (call) =>
        call === 1
          ? new ContextOverflowError('Input exceeded the model context window.')
          : undefined,
    });

    expect(out.error).toBeUndefined();
    expect(out.model.invokes).toBe(1);
    expect(texts(out.handled[1]!)).toHaveLength(2);
  });
});

/** 每顆 middleware 包一層，就像 `MiddlewareError.wrap`。 */
function wrapped(error: Error, layers: number): Error {
  let current = error;
  for (let layer = 0; layer < layers; layer += 1)
    current = new Error(current.message, { cause: current });
  return current;
}

describe('怎麼認出是真超窗', () => {
  /**
   * **判的是鏈上找到的那顆的身分，不是最外層那個。** 合成的超窗被包了很多層之後，最外層是個普通 `Error`，
   * 不在 WeakSet 裡——若判的是最外層，合成的會被誤認成端點真的超窗，我們自己的預算觸發就會繞過保留量。
   */
  it('合成的超窗被包了十幾層之後，仍然是合成的，不誤判成真超窗', () => {
    const synthetic = syntheticOverflow('摘要預算：到了門檻');
    expect(isRealOverflow(synthetic)).toBe(false);
    expect(isRealOverflow(wrapped(synthetic, 1))).toBe(false);
    expect(isRealOverflow(wrapped(synthetic, 16))).toBe(false);
  });

  it('端點回的超窗（不在 WeakSet 裡）包多少層都是真的', () => {
    const real = new ContextOverflowError('Input exceeded the model context window.');
    expect(isRealOverflow(real)).toBe(true);
    expect(isRealOverflow(wrapped(real, 16))).toBe(true);
    // 供應商的原始錯誤用 `fromError` 轉成型別化的超窗：原錯誤掛在 `cause`，仍是端點說的。
    expect(
      isRealOverflow(wrapped(ContextOverflowError.fromError(new Error('400 context length')), 3)),
    ).toBe(true);
  });

  it('不是超窗的錯一律不是：普通 Error、AbortError、非物件', () => {
    expect(isRealOverflow(new Error('網路斷了'))).toBe(false);
    expect(isRealOverflow(Object.assign(new Error('中止'), { name: 'AbortError' }))).toBe(false);
    expect(isRealOverflow('字串')).toBe(false);
    expect(isRealOverflow(undefined)).toBe(false);
  });

  /**
   * **端點真的回的、沒進 WeakSet 的超窗，一定走 retain 0**——包了多少層都一樣。這條跟上面「合成的不算」合起來是
   * 一個判別的兩面：兩面都釘，任何一邊判反都有一條紅。
   */
  it('真超窗不在 WeakSet 裡：走 retain 0（包十幾層、尾巴原本蓋住全部）', async () => {
    const real = wrapped(new ContextOverflowError('Input exceeded the model context window.'), 12);
    const out = await run({
      settings: HIGH_TOKEN_TRIGGER,
      handlerThrows: (call) => (call === 1 ? real : undefined),
    });

    expect(out.error).toBeUndefined();
    expect(out.model.invokes).toBe(1);
    expect(texts(out.handled[1]!)).toHaveLength(2);
    expect(texts(out.handled[1]!)[1]).toBe('短問題');
  });
});

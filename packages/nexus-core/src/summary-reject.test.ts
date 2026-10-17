/**
 * **摘要生出來了、但不能當摘要用**——[#1539](https://github.com/DemianLi/nexus-agent/issues/1539)。
 *
 * 照 dsh `summarizeWithLlm`（`compaction-basic/src/summarizer.ts:164-171`、`:196-221`）拒收四種：被輸出上限截斷、含圖、
 * 全空白（含空字串）、只有推理。拒收之後走 #1374 的退路，與 `summary-failure.test.ts` 同兩條：門檻觸發就 warn、照原請求送；
 * 端點真的超窗就 warn、保留原錯誤。
 *
 * 每條都走出貨的 `createSummarizer` 組出來的整條鏈（`withTokenBudget` → … → `quietInvoke`），摘要模型回真的 `AIMessage`。
 */

import { ContextOverflowError } from '@langchain/core/errors';
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { BaseMessage, MessageContent } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { createSummarizer, DEFAULT_SUMMARIZATION, SummaryRejectedError } from './summarization.js';
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

const TOKEN_TRIGGER: Partial<SummarizationSettings> = {
  trigger: [{ type: 'tokens', value: 2_000 }],
};

/** 摘要模型：每次 `invoke` 都回 `reply()`。 */
function summaryModel(reply: () => unknown) {
  let invokes = 0;
  return {
    get invokes() {
      return invokes;
    },
    profile: {},
    invoke: async () => {
      invokes += 1;
      return reply();
    },
  };
}

async function run(options: {
  settings?: Partial<SummarizationSettings>;
  reply: () => unknown;
  /** 第幾次呼叫（1 起算）要拋、拋什麼；其餘回 `好。`。 */
  handlerThrows?: (call: number) => Error | undefined;
}) {
  const reports: string[] = [];
  const model = summaryModel(options.reply);
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

/** 摘要模型回的訊息。`content` 用陣列時是 LangChain 的輸出區塊。 */
const reply = (content: unknown, finishReason = 'stop') =>
  new AIMessage({
    content: content as MessageContent,
    response_metadata: { finish_reason: finishReason },
  });

const HALF = '## 1. Primary Request and Intent\n使用者要含稅的口徑。\n## 2. Key Technical';

/** 拒收、門檻觸發：照原請求送出那 7 則，warn 恰好一條，摘要模型只叫一次（不重打）。 */
async function expectRejectedAndSentAsIs(
  content: unknown,
  finishReason: string,
  reason: string,
): Promise<void> {
  const out = await run({ settings: TOKEN_TRIGGER, reply: () => reply(content, finishReason) });
  expect(out.error).toBeUndefined();
  expect((out.result as AIMessage).content).toBe('好。');
  expect(out.handled).toHaveLength(1);
  expect(out.handled[0]).toHaveLength(7);
  expect(String(out.handled[0]![0]!.content)).toBe(BIG);
  expect(out.reports).toHaveLength(1);
  expect(out.reports[0]).toContain(reason);
  expect(out.reports[0]).toContain('照原請求送出');
  expect(out.model.invokes).toBe(1);
}

describe('拒收被截斷的摘要（dsh 的 MAX_TOKENS）', () => {
  it('finish_reason 是 length：不換上半份，照原請求送出', async () => {
    await expectRejectedAndSentAsIs(HALF, 'length', '截斷');
  });

  it('訊息只講原因、不引摘要內容', async () => {
    const out = await run({ settings: TOKEN_TRIGGER, reply: () => reply(HALF, 'length') });
    expect(out.reports[0]).toContain(new SummaryRejectedError('MAX_TOKENS').message);
    expect(out.reports[0]).not.toContain('含稅');
  });
});

describe('拒收沒有文字的摘要', () => {
  it.each([
    ['全空白', '   \n\t '],
    ['空字串', ''],
    ['只有推理區塊', [{ type: 'reasoning', reasoning: '我先想一下要怎麼摘要。' }]],
    ['文字區塊全是空白', [{ type: 'text', text: '  ' }]],
  ])('%s：照原請求送出', async (_name, content) => {
    await expectRejectedAndSentAsIs(content, 'stop', '沒有文字');
  });
});

describe('拒收含圖的摘要（dsh 的 UNSUPPORTED_CONTENT）', () => {
  const unsupported = new SummaryRejectedError('UNSUPPORTED_CONTENT').message;

  it.each([
    ['image（標準區塊）', { type: 'image', url: 'https://example.invalid/a.png' }],
    [
      'image_url（OpenAI 形狀）',
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
    ],
  ])('文字加一顆 %s：照原請求送出', async (_name, image) => {
    await expectRejectedAndSentAsIs(
      [{ type: 'text', text: '## 正常摘要' }, image],
      'stop',
      unsupported,
    );
  });

  it('碼是 UNSUPPORTED_CONTENT', () => {
    expect(new SummaryRejectedError('UNSUPPORTED_CONTENT').code).toBe('UNSUPPORTED_CONTENT');
  });
});

describe('拒收之後，端點真的超窗那條路（dsh 的 overflow 路徑）', () => {
  it('緊急摘要被截斷：保留原本那顆超窗錯，warn 一條', async () => {
    const endpointError = new ContextOverflowError('端點說：超窗了');
    const out = await run({
      // 門檻開很大：我們自己的預算不會合成超窗，是端點回的。
      settings: { trigger: [{ type: 'tokens', value: 900_000 }] },
      reply: () => reply(HALF, 'length'),
      handlerThrows: (call) => (call === 1 ? endpointError : undefined),
    });
    expect(out.result).toBeUndefined();
    expect(out.error).toBe(endpointError);
    expect(out.reports).toHaveLength(1);
    expect(out.reports[0]).toContain('截斷');
    expect(out.reports[0]).toContain('保留原本的請求錯誤');
    expect(out.handled).toHaveLength(1);
    expect(out.model.invokes).toBe(1);
  });
});

describe('不誤傷', () => {
  it.each([
    ['finish_reason 是 stop 的正常文字', () => reply('## 正常摘要')],
    [
      '文字區塊加推理區塊',
      () =>
        reply([
          { type: 'reasoning', reasoning: '想' },
          { type: 'text', text: '## 正常摘要' },
        ]),
    ],
    ['沒有 metadata、沒有 content 的替身', () => ({ text: '## 正常摘要' })],
  ])('%s：照常摘要', async (_name, summary) => {
    const out = await run({ settings: TOKEN_TRIGGER, reply: summary });
    expect(out.error).toBeUndefined();
    expect(out.reports).toEqual([]);
    expect(out.handled).toHaveLength(1);
    expect(out.handled[0]!.length).toBeLessThan(7);
    expect(String(out.handled[0]![0]!.content)).toContain('## 正常摘要');
    expect(out.model.invokes).toBe(1);
  });
});

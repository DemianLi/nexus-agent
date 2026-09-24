/**
 * 錨定估算的算法（[#588](https://github.com/DemianLi/nexus-agent/issues/588)）。接線與產品路徑在
 * `summarization.test.ts` 與 `apps/harness/src/context-pressure.test.ts`；這裡只管數字怎麼算出來。
 */

import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import {
  estimateAnchoredTokens,
  estimateRequestTokens,
  TokenAnchorBook,
} from './token-estimate.js';

const MODEL = { model: 'm-1' };
const SYSTEM = new SystemMessage('你是測試用的助手。');
const TOOLS = [
  { type: 'function', function: { name: 'read_file', description: '讀檔', parameters: {} } },
];

/** 一則帶實數的 AI 訊息。 */
function answered(id: string, input: number, model = 'm-1', text = '好。'): AIMessage {
  return new AIMessage({
    id,
    content: text,
    usage_metadata: { input_tokens: input, output_tokens: 1, total_tokens: input + 1 },
    response_metadata: { model_name: model },
  });
}

const request = (messages: readonly BaseMessage[], model: object = MODEL) => ({
  messages,
  systemMessage: SYSTEM,
  tools: TOOLS,
  model,
});

/** 一段夠長的中文，讓增量明顯。 */
const CHINESE = '錨定估算只估上一次之後新進來的那一截。'.repeat(60);

describe('E：o200k 的純估算', () => {
  it('system、工具定義、每則訊息都算，每則多 4', () => {
    const one = estimateRequestTokens({ messages: [new HumanMessage('你好')] });
    const two = estimateRequestTokens({
      messages: [new HumanMessage('你好'), new HumanMessage('你好')],
    });
    expect(two).toBe(one * 2);
    expect(estimateRequestTokens(request([new HumanMessage('你好')]))).toBeGreaterThan(one);
  });

  it('工具呼叫的名字與參數算進去', () => {
    const plain = new AIMessage('');
    const calling = new AIMessage({
      content: '',
      tool_calls: [{ id: 'c', name: 'read_file', args: { file_path: '/很長的路徑/檔.md' } }],
    });
    expect(estimateRequestTokens({ messages: [calling] })).toBeGreaterThan(
      estimateRequestTokens({ messages: [plain] }),
    );
  });

  it('推理區塊不算：送回模型時它被丟掉', () => {
    const withReasoning = new AIMessage({
      content: [
        { type: 'reasoning', reasoning: '想了很久。'.repeat(100) },
        { type: 'text', text: '好。' },
      ],
    });
    expect(estimateRequestTokens({ messages: [withReasoning] })).toBe(
      estimateRequestTokens({ messages: [new AIMessage('好。')] }),
    );
  });

  it('content 裡那份 tool_call 區塊不算：工具呼叫只從 tool_calls 算一次', () => {
    const call = {
      id: 'c',
      name: 'write_file',
      args: { content: '一大段要寫進檔案的中文。'.repeat(50) },
    };
    const withBlock = new AIMessage({
      content: [{ type: 'tool_call', ...call }] as never,
      tool_calls: [call],
    });
    const plain = new AIMessage({ content: '', tool_calls: [call] });
    expect(estimateRequestTokens({ messages: [withBlock] })).toBe(
      estimateRequestTokens({ messages: [plain] }),
    );
  });

  it('特殊 token 的字串當一般文字，不拋', () => {
    expect(() =>
      estimateRequestTokens({ messages: [new HumanMessage('a <|endoftext|> b')] }),
    ).not.toThrow();
  });

  it('很長的無空白片段不會卡住', () => {
    const started = Date.now();
    const tokens = estimateRequestTokens({ messages: [new HumanMessage('X'.repeat(40_000))] });
    expect(tokens).toBeGreaterThan(1_000);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe('錨', () => {
  it('錨在最後一則帶實數的 AI 訊息上，帳上有它的 E 就用帳上的', () => {
    const book = new TokenAnchorBook();
    const before = [new HumanMessage('第一句')];
    const anchor = answered('a1', 5_000);
    book.record(anchor, request(before), 1_000, 'estimate');
    const now = request([...before, anchor, new HumanMessage(CHINESE)]);
    const result = estimateAnchoredTokens(now, book);
    expect(result.basis).toBe('anchor');
    expect(result.tokens).toBe(5_000 + estimateRequestTokens(now) - 1_000);
  });

  it('帳上沒有就退到這串訊息裡錨之前的那一段', () => {
    const before = [new HumanMessage('第一句')];
    const now = request([...before, answered('a1', 5_000), new HumanMessage(CHINESE)]);
    const result = estimateAnchoredTokens(now, new TokenAnchorBook());
    expect(result.tokens).toBe(
      5_000 + estimateRequestTokens(now) - estimateRequestTokens(request(before)),
    );
  });

  it('換過模型的錨不用；兩邊有一邊不知道就放行', () => {
    const now = [new HumanMessage('q'), answered('a1', 5_000, 'm-0'), new HumanMessage('再問')];
    expect(estimateAnchoredTokens(request(now), new TokenAnchorBook()).basis).toBe('estimate');
    expect(estimateAnchoredTokens(request(now, {}), new TokenAnchorBook()).basis).toBe('anchor');
    const unnamed = new AIMessage({
      id: 'a2',
      content: '好。',
      usage_metadata: { input_tokens: 5_000, output_tokens: 1, total_tokens: 5_001 },
    });
    const withUnnamed = [new HumanMessage('q'), unnamed, new HumanMessage('再問')];
    expect(estimateAnchoredTokens(request(withUnnamed), new TokenAnchorBook()).basis).toBe(
      'anchor',
    );
  });

  it('沒有正的實數的 AI 訊息不當錨', () => {
    const zero = new AIMessage({
      id: 'a0',
      content: '好。',
      usage_metadata: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    });
    const now = [
      new HumanMessage('q'),
      zero,
      new AIMessage('沒有用量。'),
      new HumanMessage('再問'),
    ];
    expect(estimateAnchoredTokens(request(now), new TokenAnchorBook()).basis).toBe('estimate');
  });
});

describe('內容比例', () => {
  /** 兩次呼叫都在帳上：第一次 E=1000 實數 2000，第二次 E=3000 實數 5000——內容比例 1.5。 */
  function twoCalls(first: { e: number; t: number }, second: { e: number; t: number }) {
    const book = new TokenAnchorBook();
    const a1 = answered('a1', first.t);
    const a2 = answered('a2', second.t);
    book.record(a1, request([new HumanMessage('q')]), first.e, 'estimate');
    book.record(a2, request([new HumanMessage('q')]), second.e, 'anchor');
    const messages = [
      new HumanMessage('q'),
      a1,
      new ToolMessage({ content: 'x', tool_call_id: 'c' }),
      a2,
    ];
    return { book, messages };
  }

  it('兩次都在帳上、增量夠大：增量乘上內容比例', () => {
    const { book, messages } = twoCalls({ e: 1_000, t: 2_000 }, { e: 3_000, t: 5_000 });
    const now = request([...messages, new HumanMessage(CHINESE)]);
    const result = estimateAnchoredTokens(now, book);
    expect(result.tokens).toBe(Math.round(5_000 + (estimateRequestTokens(now) - 3_000) * 1.5));
  });

  it('估算增加量不到 500：比例用 1', () => {
    const { book, messages } = twoCalls({ e: 1_000, t: 2_000 }, { e: 1_400, t: 5_000 });
    const now = request([...messages, new HumanMessage(CHINESE)]);
    expect(estimateAnchoredTokens(now, book).tokens).toBe(
      5_000 + estimateRequestTokens(now) - 1_400,
    );
  });

  it('實數沒有增加（中間摘要過）：比例用 1', () => {
    const { book, messages } = twoCalls({ e: 1_000, t: 5_000 }, { e: 3_000, t: 4_000 });
    const now = request([...messages, new HumanMessage(CHINESE)]);
    expect(estimateAnchoredTokens(now, book).tokens).toBe(
      4_000 + estimateRequestTokens(now) - 3_000,
    );
  });

  it('只有一則錨：比例用 1', () => {
    const book = new TokenAnchorBook();
    const a1 = answered('a1', 2_000);
    book.record(a1, request([new HumanMessage('q')]), 1_000, 'estimate');
    const now = request([new HumanMessage('q'), a1, new HumanMessage(CHINESE)]);
    expect(estimateAnchoredTokens(now, book).tokens).toBe(
      2_000 + estimateRequestTokens(now) - 1_000,
    );
  });
});

describe('學到的比例（c̄）：自己算不出比例時借行程裡最近學到的', () => {
  /** 讓帳學到 `ratio`：一條 thread 的第一次 E=1000 實數 1000，第二次 E=2000 實數 1000＋1000×ratio。 */
  function learn(book: TokenAnchorBook, ratio: number, prefix = 'l'): void {
    const first = answered(`${prefix}1`, 1_000);
    book.record(first, request([new HumanMessage('q')]), 1_000, 'estimate');
    book.record(
      answered(`${prefix}2`, 1_000 + 1_000 * ratio),
      request([new HumanMessage('q'), first, new HumanMessage('再問')]),
      2_000,
      'anchor',
    );
  }

  it('錨定的那次回來就學；單錨的 thread 借它', () => {
    const book = new TokenAnchorBook();
    learn(book, 1.2);
    expect(book.learnedRatio('m-1')).toBeCloseTo(1.2);
    expect(book.learnedRatio('m-2')).toBeUndefined();

    const b1 = answered('b1', 2_000);
    book.record(b1, request([new HumanMessage('另一條')]), 1_500, 'anchor');
    const now = request([new HumanMessage('另一條'), b1, new HumanMessage(CHINESE)]);
    expect(estimateAnchoredTokens(now, book).tokens).toBe(
      Math.round(2_000 + (estimateRequestTokens(now) - 1_500) * 1.2),
    );
  });

  it('自己算得出比例就用自己的', () => {
    const book = new TokenAnchorBook();
    learn(book, 2);
    const a1 = answered('a1', 2_000);
    const a2 = answered('a2', 5_000);
    book.record(a1, request([new HumanMessage('q')]), 1_000, 'estimate');
    book.record(a2, request([new HumanMessage('q')]), 3_000, 'estimate');
    const now = request([
      new HumanMessage('q'),
      a1,
      new ToolMessage({ content: 'x', tool_call_id: 'c' }),
      a2,
      new HumanMessage(CHINESE),
    ]);
    expect(estimateAnchoredTokens(now, book).tokens).toBe(
      Math.round(5_000 + (estimateRequestTokens(now) - 3_000) * 1.5),
    );
  });

  it('借錨的第一次乘學到的比例，回來時也從那一對學', () => {
    const book = new TokenAnchorBook();
    const firstThread = request([new HumanMessage('短')]);
    const firstE = estimateRequestTokens(firstThread);
    book.record(answered('t1', 6_000), firstThread, firstE, 'estimate');

    const second = request([new HumanMessage(CHINESE)]);
    const secondE = estimateRequestTokens(second);
    expect(secondE - firstE).toBeGreaterThanOrEqual(500);
    const secondTruth = Math.round(6_000 + (secondE - firstE) * 1.3);
    book.record(answered('t2', secondTruth), second, secondE, 'borrowed');
    expect(book.learnedRatio('m-1')).toBeCloseTo(1.3, 2);

    const third = request([new HumanMessage(CHINESE + CHINESE)]);
    expect(estimateAnchoredTokens(third, book).tokens).toBe(
      Math.round(6_000 + (estimateRequestTokens(third) - firstE) * book.learnedRatio('m-1')!),
    );
  });

  it('學不出來（兩點太近或實數沒增加）就留著上一次的', () => {
    const book = new TokenAnchorBook();
    learn(book, 1.2);
    const near = answered('n1', 1_000);
    book.record(near, request([new HumanMessage('q')]), 1_000, 'estimate');
    book.record(
      answered('n2', 9_000),
      request([new HumanMessage('q'), near, new HumanMessage('再問')]),
      1_400,
      'anchor',
    );
    expect(book.learnedRatio('m-1')).toBeCloseTo(1.2);
    const shrunk = answered('s1', 9_000);
    book.record(shrunk, request([new HumanMessage('q')]), 1_000, 'estimate');
    book.record(
      answered('s2', 4_000),
      request([new HumanMessage('q'), shrunk, new HumanMessage('再問')]),
      5_000,
      'anchor',
    );
    expect(book.learnedRatio('m-1')).toBeCloseTo(1.2);
  });
});

describe('第一次：借別條 thread 的第一次', () => {
  it('同模型、同工具組的第一次記成借錨的來源，別條 thread 的第一次借它', () => {
    const book = new TokenAnchorBook();
    const firstThread = request([new HumanMessage('短')]);
    const firstE = estimateRequestTokens(firstThread);
    expect(estimateAnchoredTokens(firstThread, book).basis).toBe('estimate');
    book.record(answered('t1', 6_000), firstThread, firstE, 'estimate');

    const other = request([new HumanMessage(CHINESE)]);
    const result = estimateAnchoredTokens(other, book);
    expect(result.basis).toBe('borrowed');
    expect(result.tokens).toBe(6_000 + estimateRequestTokens(other) - firstE);
  });

  it('只記第一個；錨定的那幾次不記', () => {
    const book = new TokenAnchorBook();
    const thread = request([new HumanMessage('短')]);
    // 錨定的那次不是任何一條 thread 的第一次：帳上是空的時候記了它，也不能變成借錨的來源。
    book.record(answered('t0', 9_000), thread, 100, 'anchor');
    expect(book.firstCall(thread)).toBeUndefined();
    book.record(answered('t1', 6_000), thread, 100, 'estimate');
    book.record(answered('t2', 9_000), thread, 100, 'borrowed');
    expect(book.firstCall(thread)).toEqual({ tokens: 6_000, estimated: 100 });
  });

  it('工具組或模型不同就不借', () => {
    const book = new TokenAnchorBook();
    const thread = request([new HumanMessage('短')]);
    book.record(answered('t1', 6_000), thread, 100, 'estimate');
    expect(estimateAnchoredTokens({ ...thread, tools: [] }, book).basis).toBe('estimate');
    expect(estimateAnchoredTokens(request([new HumanMessage('短')]), book).basis).toBe('borrowed');
    expect(
      estimateAnchoredTokens(request([new HumanMessage('短')], { model: 'm-2' }), book).basis,
    ).toBe('estimate');
  });

  it('回來的不是帶實數的 AI 訊息就不記', () => {
    const book = new TokenAnchorBook();
    const thread = request([new HumanMessage('短')]);
    book.record({ update: {} }, thread, 100, 'estimate');
    book.record(new AIMessage('沒有用量。'), thread, 100, 'estimate');
    book.record(answered('t1', 6_000, 'm-other'), thread, 100, 'estimate');
    expect(book.firstCall(thread)).toBeUndefined();
  });
});

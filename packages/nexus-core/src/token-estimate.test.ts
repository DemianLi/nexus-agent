/**
 * 錨定估算的算法（[#588](https://github.com/DemianLi/nexus-agent/issues/588)）。接線與產品路徑在
 * `summarization.test.ts` 與 `apps/harness/src/context-pressure.test.ts`；這裡只管數字怎麼算出來。
 */

import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import o200k_base from 'gpt-tokenizer/encoding/o200k_base';
import { Tiktoken } from 'js-tiktoken/lite';
import o200kRanks from 'js-tiktoken/ranks/o200k_base';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  estimateAnchoredTokens,
  estimateRequestTokens,
  estimateTextTokens,
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

/**
 * [#952](https://github.com/DemianLi/nexus-agent/issues/952)：存檔點每次讀回來都是新的訊息物件，以物件為鍵的快取跨輪
 * 全部落空，長中文歷史每輪重編一遍。這裡量的是**編碼器被叫了幾次、編了幾個字元**，不是牆鐘時間——牆鐘在 CI 上不穩。
 */
/** 沒有另一半的代理碼元。 */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u;

describe('內容備忘與超長抽樣（#952）', () => {
  /** 數編碼器這段時間被餵了幾次、共多少字元。 */
  function countEncoding() {
    const spy = vi.spyOn(o200k_base, 'encode');
    return {
      calls: () => spy.mock.calls.length,
      chars: () => spy.mock.calls.reduce((sum, [text]) => sum + text.length, 0),
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // 不同的字串避免撞到別的測試已經備忘過的內容。
  const longChinese = (seed: string, chars: number) =>
    `${seed}｜中文工具結果，沒有空白。`.repeat(Math.ceil(chars / 14)).slice(0, chars);

  it('同樣的內容換一個訊息物件再估：不再編碼，數字不變', () => {
    const text = longChinese('備忘', 20_000);
    const first = estimateRequestTokens({ messages: [new HumanMessage(text)] });
    const encoding = countEncoding();
    // 模擬存檔點讀回來：內容一樣、物件是新的。
    const second = estimateRequestTokens({ messages: [new HumanMessage(text)] });
    expect(second).toBe(first);
    expect(encoding.calls()).toBe(0);
  });

  it('內容不同就要重編', () => {
    const encoding = countEncoding();
    estimateRequestTokens({ messages: [new HumanMessage(longChinese('甲', 2_000))] });
    estimateRequestTokens({ messages: [new HumanMessage(longChinese('乙', 2_000))] });
    expect(encoding.calls()).toBeGreaterThanOrEqual(2);
  });

  it('工具定義與 system 同樣以內容備忘', () => {
    const tool = {
      type: 'function',
      function: { name: 'big', description: longChinese('工具', 3_000), parameters: {} },
    };
    const system = () => new SystemMessage(longChinese('系統', 3_000));
    const first = estimateRequestTokens({ systemMessage: system(), tools: [{ ...tool }] });
    const encoding = countEncoding();
    const second = estimateRequestTokens({ systemMessage: system(), tools: [{ ...tool }] });
    expect(second).toBe(first);
    expect(encoding.calls()).toBe(0);
  });

  it('超長的一段只編幾個窗口：編進去的字元數有上限，估的數離全量不遠', () => {
    const text = longChinese('抽樣', 400_000);
    const encoding = countEncoding();
    const sampled = estimateRequestTokens({ messages: [new HumanMessage(text)] }) - 4;
    expect(encoding.chars()).toBeLessThanOrEqual(40_000);
    vi.restoreAllMocks();
    const exact = estimateTextTokens(text);
    expect(Math.abs(sampled / exact - 1)).toBeLessThan(0.05);
  });

  it('抽樣是確定的：同一段永遠推出同一個數', () => {
    const text = longChinese('確定', 150_000);
    const a = estimateRequestTokens({ messages: [new HumanMessage(text)] });
    const b = estimateRequestTokens({ messages: [new HumanMessage(`${text}`)] });
    expect(b).toBe(a);
  });

  it('單段文字的入口不抽樣：外溢層靠它做預算的硬保證', () => {
    const text = longChinese('全量', 120_000);
    const encoding = countEncoding();
    estimateTextTokens(text);
    expect(encoding.chars()).toBeGreaterThanOrEqual(text.length);
  });

  it('抽樣的窗口不會把代理對切成兩半', () => {
    // 每個字元都是兩個 UTF-16 碼元：任何一刀落在中間都會餵進孤立的代理。
    const text = longChinese('😀', 200_000).replaceAll(/[^😀]/gu, '😀');
    const encoding = countEncoding();
    estimateRequestTokens({ messages: [new HumanMessage(text)] });
    for (const [piece] of vi.mocked(o200k_base.encode).mock.calls) {
      expect(LONE_SURROGATE.test(piece)).toBe(false);
    }
    expect(encoding.calls()).toBeGreaterThan(0);
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

/**
 * [#1107](https://github.com/DemianLi/nexus-agent/issues/1107)：編碼器從 js-tiktoken 換成 gpt-tokenizer。換的前提是
 * **每一個輸入的 token 數逐位相同**——否則 spill-policy 的外溢預算（`estimateTextTokens`，精確數）會悄悄移位。
 * js-tiktoken 留在 devDependencies 當對照組：這裡用它照舊的做法（128 字元切塊、特殊 token 當一般文字）重算一遍。
 */
describe('編碼器對照（#1107）', () => {
  const oracle = new Tiktoken(o200kRanks);
  /** 前一個編碼器的算法，原樣：長的無空白／連續空白片段切 128 字元，其餘整段編。 */
  function oracleTokens(text: string): number {
    const encode = (piece: string) =>
      piece.length === 0 ? 0 : oracle.encode(piece, [], []).length;
    let total = 0;
    let last = 0;
    for (const match of text.matchAll(/\S{129,}|\s{129,}/g)) {
      total += encode(text.slice(last, match.index));
      for (let start = 0; start < match[0].length; start += 128)
        total += encode(match[0].slice(start, start + 128));
      last = match.index + match[0].length;
    }
    return total + encode(text.slice(last));
  }

  let seed = 20261006;
  const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = (low: number, high: number) =>
    String.fromCodePoint(low + Math.floor(random() * (high - low)));
  const many = (count: number, make: () => string) => Array.from({ length: count }, make).join('');

  const MATERIALS: Record<string, string> = {
    中文: '這是一段要送進模型的中文內容，會有標點、數字 123 與英文 words。'.repeat(400),
    英文程式碼: 'export function f(a: number, b: string) { return `${a}-${b}`; }\n'.repeat(300),
    隨機漢字: many(3_000, () => pick(0x4e00, 0x4e00 + 20_000)),
    隨機數字: many(3_000, () => pick(48, 58)),
    表情與組合字元: '👨‍👩‍👧‍👦🏳️‍🌈é́ 😀'.repeat(200),
    全字元範圍: many(3_000, () => {
      const code = Math.floor(random() * 0xffff);
      return code >= 0xd800 && code < 0xe000 ? 'x' : String.fromCharCode(code);
    }),
    特殊token字串: 'a<|endoftext|>b<|im_start|>c<|fim_prefix|> <|endofprompt|>x'.repeat(40),
    孤立代理碼元: 'ab\ud800cd\udc00ef'.repeat(100),
    長連續空白: ' \n\t'.repeat(2_000),
    長無空白英數: 'a1B2'.repeat(2_000),
    空字元: 'a\u0000b\u0000'.repeat(100),
  };

  it.each(Object.entries(MATERIALS))('%s：token 數與前一個編碼器逐位相同', (_name, text) => {
    expect(estimateTextTokens(text)).toBe(oracleTokens(text));
  });

  it('超過 128 字元的無空白片段切塊與否，由切塊後的數決定，與前一個編碼器相同', () => {
    for (const run of [127, 128, 129, 130, 300, 1_000]) {
      const text = `前 ${'漢'.repeat(run)} 後`;
      expect(estimateTextTokens(text)).toBe(oracleTokens(text));
    }
  });

  /**
   * 切塊是防崩潰的承重件：gpt-tokenizer 對十五萬個沒有空白的隨機漢字，不切的話四十三秒後拋
   * `RangeError: Maximum call stack size exceeded`（量過）；十八萬字元的空白與換行要編十一秒。`estimateTextTokens` 在外溢層
   * 的工具呼叫路徑上，拋出來就是那一次工具呼叫整個失敗。
   * 突變（量過）：把 `MAX_RUN` 改成極大值，這一條紅（拋 RangeError）。
   */
  it('極長的無空白片段不拋，估算與請求估算兩條路都是', () => {
    const hanzi = many(150_000, () => pick(0x4e00, 0x4e00 + 20_000));
    const base64 = many(
      150_000,
      () =>
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'[
          Math.floor(random() * 64)
        ]!,
    );
    for (const text of [hanzi, base64]) {
      expect(() => estimateTextTokens(text)).not.toThrow();
      expect(() => estimateRequestTokens({ messages: [new HumanMessage(text)] })).not.toThrow();
    }
    expect(estimateTextTokens(hanzi)).toBeGreaterThan(100_000);
  }, 60_000);
});

describe('逐位切詞的數字（#1102）', () => {
  const SINGLE = { singleDigits: true };
  /** 一串 ASCII 數字夾在文字裡：o200k 三位一組，逐位切詞是一位一個。 */
  const digits = (n: number) => '7'.repeat(n);

  it('數字連續 L 位，逐位算比 o200k 多 L − ceil(L/3)', () => {
    const base = estimateRequestTokens({ messages: [new HumanMessage('值：')] });
    const grouped = (n: number) =>
      estimateRequestTokens({ messages: [new HumanMessage(`值：${digits(n)}`)] }) - base;
    for (const n of [2, 3, 6, 10, 31]) {
      const single =
        estimateRequestTokens({ messages: [new HumanMessage(`值：${digits(n)}`)] }, SINGLE) - base;
      expect(single - grouped(n)).toBe(n - Math.ceil(n / 3));
    }
  });

  it('沒開旗標就跟舊的一模一樣', () => {
    const body = { messages: [new HumanMessage('編號 20260927 共 1234567 筆')] };
    expect(estimateRequestTokens(body, { singleDigits: false })).toBe(estimateRequestTokens(body));
    expect(estimateRequestTokens(body, SINGLE)).toBeGreaterThan(estimateRequestTokens(body));
  });

  it('單位數字與全形數字不加：o200k 本來就一個一位', () => {
    const body = { messages: [new HumanMessage('第 3 項，０１２３４５')] };
    expect(estimateRequestTokens(body, SINGLE)).toBe(estimateRequestTokens(body));
  });

  it('同一則訊息先開旗標再不開，各算各的（快取不跨模型外洩）', () => {
    const message = new HumanMessage(`id=${digits(30)}`);
    const off = estimateRequestTokens({ messages: [message] });
    const on = estimateRequestTokens({ messages: [message] }, SINGLE);
    expect(on - off).toBe(30 - 10);
    expect(estimateRequestTokens({ messages: [message] })).toBe(off);
    expect(estimateRequestTokens({ messages: [message] }, SINGLE)).toBe(on);
  });

  it('超過備忘門檻的長文也一樣算（內容備忘不吃掉旗標）', () => {
    const text = `${'列 '.repeat(200)}${digits(300)}`;
    const body = { messages: [new HumanMessage(text)] };
    expect(estimateRequestTokens(body, SINGLE) - estimateRequestTokens(body)).toBe(300 - 100);
  });

  it('工具呼叫參數與工具結果裡的數字也算', () => {
    const calling = new AIMessage({
      content: '',
      tool_calls: [{ id: 'c', name: 'read_file', args: { n: digits(30) } }],
    });
    const result = new ToolMessage({ content: digits(30), tool_call_id: 'c' });
    for (const message of [calling, result]) {
      const gap =
        estimateRequestTokens({ messages: [message] }, SINGLE) -
        estimateRequestTokens({ messages: [message] });
      expect(gap).toBeGreaterThanOrEqual(30 - 10);
    }
  });

  it('精確的 estimateTextTokens 不受影響', () => {
    expect(estimateTextTokens(digits(30))).toBe(estimateTextTokens(digits(30)));
    const exact = estimateTextTokens(digits(30));
    estimateRequestTokens({ messages: [new HumanMessage(digits(30))] }, SINGLE);
    expect(estimateTextTokens(digits(30))).toBe(exact);
  });

  it('TokenAnchorBook 只對宣告過的模型回 true', () => {
    const book = new TokenAnchorBook({ singleDigitModels: ['m-digits'] });
    expect(book.singleDigits('m-digits')).toBe(true);
    expect(book.singleDigits('m-1')).toBe(false);
    expect(book.singleDigits(undefined)).toBe(false);
    expect(new TokenAnchorBook().singleDigits('m-digits')).toBe(false);
  });

  it('錨定估算：宣告過的模型第一次估得高、沒宣告的不動', () => {
    const csv = Array.from(
      { length: 200 },
      (_, i) => `${1000000 + i},${20260927 + i},3.14159`,
    ).join('\n');
    const thread = (model: string) => request([new HumanMessage(csv)], { model });
    const plain = estimateAnchoredTokens(thread('m-1'), new TokenAnchorBook());
    const declared = estimateAnchoredTokens(
      thread('m-digits'),
      new TokenAnchorBook({ singleDigitModels: ['m-digits'] }),
    );
    expect(declared.basis).toBe('estimate');
    expect(declared.tokens).toBeGreaterThan(plain.tokens * 1.3);
    // 沒宣告的模型不因為帳上有別的模型宣告而改變。
    expect(
      estimateAnchoredTokens(
        thread('m-1'),
        new TokenAnchorBook({ singleDigitModels: ['m-digits'] }),
      ).tokens,
    ).toBe(plain.tokens);
  });

  it('錨之後的增量也按位數計', () => {
    const book = new TokenAnchorBook({ singleDigitModels: ['m-digits'] });
    const model = { model: 'm-digits' };
    const answer = answered('a1', 5_000, 'm-digits');
    const before = [new HumanMessage('開始'), answer];
    const after = [...before, new HumanMessage(digits(300))];
    book.record(answer, request(before.slice(0, 1), model), 100, 'estimate');
    const without = estimateAnchoredTokens(request(before, model), book).tokens;
    const grown = estimateAnchoredTokens(request(after, model), book).tokens;
    // 300 位數字逐位算至少 300 個 token，不是 o200k 的 100。
    expect(grown - without).toBeGreaterThanOrEqual(300);
  });
});

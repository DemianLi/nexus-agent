/**
 * **摘要之後逐字留下的量，依這一步的模型算 token**——[#1374](https://github.com/DemianLi/nexus-agent/issues/1374)。
 *
 * 從前 `keep` 是 20 則：小窗口（32,768）上每則 3,000 字，20 則自己就 30,342 token，比門檻還大，摘要完下一步又過門檻。
 * 現在照 dsh `compaction-basic`：`retainRatio` 0.16 × 訊息預算（窗口 − 輸出上限），再封在有效門檻的兩成（登記的偏離），
 * 選尾巴用 dsh `selectCompactableRange` 的「累加到 ≥ 為止、跨過的那則也留」。
 *
 * 基座的 `keep` 建構時就定了，所以 `createSummarizer` 每次請求算出 N，轉給 `keep: { messages, N }` 那顆實例。
 * 這一檔量三件事：**算對**（公式與選法）、**接對**（N 真的決定了送出去的串）、**不寫兩份**（不同 N 的實例共用同一個
 * 歷史檔）。
 */

import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import {
  createSummarizer,
  DEFAULT_SUMMARIZATION,
  effectiveTrigger,
  RETAIN_FALLBACK_MESSAGES,
  retainedMessageCount,
  retainedTailCount,
  retainTokensFor,
  SUMMARIZATION_MIDDLEWARE_NAME,
} from './summarization.js';
import type { ModelContextLimits, SummarizationSettings } from './summarization.js';
import { SummaryCutoffTable } from './summary-cutoffs.js';
import { estimateMessageTokens, TokenAnchorBook } from './token-estimate.js';

/** 出廠型錄三顆（`apps/harness/cordis.yml`）：窗口與輸出上限。 */
const DEFAULT_MODEL: ModelContextLimits = { contextWindow: 700_045, maxOutputTokens: 16_384 };
const MID_MODEL: ModelContextLimits = { contextWindow: 131_072, maxOutputTokens: 4_096 };
const SMALL_MODEL: ModelContextLimits = { contextWindow: 32_768, maxOutputTokens: 4_096 };
const SHIPPED_TRIGGER = DEFAULT_SUMMARIZATION.trigger;
const ratio = { retainRatio: 0.16 } as const;

describe('保留量的公式（retainTokensFor）', () => {
  /**
   * PM 在 #1374 定的公式：`min(floor(訊息預算 × 0.16), floor(有效門檻 × 0.2))`。前一項是 dsh 的；後一項只在我們的 100k 絕對
   * 門檻讓 dsh 的值超過門檻時生效。三顆算出來：90b 與 dsh 一樣（4,587），11b 與預設那顆被封在 20,000。
   */
  it.each([
    ['90b（窗口 32,768）：dsh 的值，封頂不生效', SMALL_MODEL, 4_587],
    ['11b（窗口 131,072）：dsh 的 20,316 被封在 20,000', MID_MODEL, 20_000],
    ['預設那顆（窗口 700,045）：dsh 的 109,385 超過門檻，被封在 20,000', DEFAULT_MODEL, 20_000],
  ])('%s', (_label, limits, expected) => {
    const trigger = effectiveTrigger(SHIPPED_TRIGGER, limits);
    expect(retainTokensFor(ratio, limits, trigger)).toBe(expected);
  });

  it('封頂的就是 dsh 的載入期驗證擋的那一種：不封的話預設那顆的保留量比門檻還大', () => {
    const trigger = effectiveTrigger(SHIPPED_TRIGGER, DEFAULT_MODEL);
    const dsh = Math.floor((DEFAULT_MODEL.contextWindow - DEFAULT_MODEL.maxOutputTokens) * 0.16);
    expect(dsh).toBe(109_385);
    expect(dsh).toBeGreaterThan(100_000);
    expect(retainTokensFor(ratio, DEFAULT_MODEL, trigger)).toBeLessThan(100_000);
  });

  it('沒型錄的模型：只剩門檻那一項（有效 token 門檻的兩成）', () => {
    expect(retainTokensFor(ratio, undefined, SHIPPED_TRIGGER)).toBe(20_000);
  });

  it('連 token 門檻都沒有：算不出來，呼叫端退回 20 則', () => {
    const onlyMessages = [{ type: 'messages', value: 60 }] as const;
    expect(retainTokensFor(ratio, undefined, onlyMessages)).toBeUndefined();
    expect(RETAIN_FALLBACK_MESSAGES).toBe(20);
  });

  it('retainTokens 照給，但一樣封在門檻的兩成', () => {
    expect(retainTokensFor({ retainTokens: 5_000 }, SMALL_MODEL, SHIPPED_TRIGGER)).toBe(5_000);
    expect(retainTokensFor({ retainTokens: 50_000 }, undefined, SHIPPED_TRIGGER)).toBe(20_000);
  });

  it('有型錄的 retainTokens 不看窗口', () => {
    const trigger = effectiveTrigger(SHIPPED_TRIGGER, SMALL_MODEL);
    // 90b 的有效門檻 26,214，兩成是 5,242：給 8,000 被封在 5,242。
    expect(retainTokensFor({ retainTokens: 8_000 }, SMALL_MODEL, trigger)).toBe(5_242);
  });
});

/** 一則大小固定的訊息：量出來的 token 數（不寫死 tokenizer 的答案）。 */
function sized(role: 'human' | 'ai', tag: string): BaseMessage {
  const text = `${tag}：${'這是一段固定長度的內容。'.repeat(20)}`;
  return role === 'human' ? new HumanMessage(text) : new AIMessage(text);
}
const conversation = (count: number): BaseMessage[] =>
  Array.from({ length: count }, (_, index) =>
    sized(index % 2 === 0 ? 'human' : 'ai', String(index)),
  );

describe('選尾巴（retainedTailCount）：dsh 的「累加到 ≥ 為止、跨過的那則也留」', () => {
  const unit = estimateMessageTokens(sized('human', '0'));

  it('累加到 ≥ 保留量為止，跨過的那則也留', () => {
    const messages = conversation(20);
    const lastThree = messages
      .slice(-3)
      .reduce((sum, message) => sum + estimateMessageTokens(message), 0);
    // 保留量 = 最後三則的總和：累加到第三則恰好 ≥，留三則。
    expect(retainedTailCount(messages, lastThree)).toBe(3);
    // 多 1 token：第三則還不夠，第四則跨過去，**第四則也留**。
    expect(retainedTailCount(messages, lastThree + 1)).toBe(4);
  });

  /** 這條是基座 `{type:'tokens'}` 的 fail-open：最新一則自己就超過目標時一則不留。 */
  it('最新一則自己就超過保留量：至少留它自己，不是一則不留', () => {
    const huge = new HumanMessage('字'.repeat(20_000));
    const messages = [...conversation(6), huge];
    expect(retainedTailCount(messages, 100)).toBe(1);
  });

  it('保留量是 0 也留一則（跨過的那則）', () => {
    expect(retainedTailCount(conversation(6), 0)).toBe(1);
  });

  it('整串都在尾巴裡：回整串的長度，基座看到 `messages.length <= keep` 就不摘要', () => {
    const messages = conversation(6);
    expect(retainedTailCount(messages, unit * 1_000)).toBe(6);
  });

  it('空串回 0', () => {
    expect(retainedTailCount([], 100)).toBe(0);
  });

  describe('切點不能把工具呼叫和它的結果拆開', () => {
    const call = (id: string) =>
      new AIMessage({ content: '呼叫。', tool_calls: [{ id, name: 'echo', args: {} }] });
    const result = (id: string) => new ToolMessage({ content: '結果。', tool_call_id: id });

    it('尾巴的第一則是工具結果：退到發出那次呼叫的訊息', () => {
      const messages = [...conversation(4), call('c1'), result('c1'), sized('ai', '尾')];
      // 保留量只夠最後一則（「尾」）；往前累加會先停在工具結果，但那把呼叫和結果拆開了。
      const kept = retainedTailCount(messages, 1);
      expect(kept).toBe(1);
      const two = retainedTailCount(messages, estimateMessageTokens(messages.at(-1)!) + 1);
      // 兩則剛好是「結果＋尾」→ 結果在尾巴裡，它的呼叫在前面，所以退到呼叫那則：三則。
      expect(two).toBe(3);
    });

    it('一次呼叫兩個工具：兩個結果都在尾巴裡才算平衡', () => {
      const double = new AIMessage({
        content: '兩個。',
        tool_calls: [
          { id: 'a', name: 'echo', args: {} },
          { id: 'b', name: 'echo', args: {} },
        ],
      });
      const messages = [...conversation(4), double, result('a'), result('b')];
      // 保留量只夠最後一則（結果 b）：結果 a、呼叫都在切點前面，b 的呼叫在切點前面 → 退到 double。
      expect(retainedTailCount(messages, 1)).toBe(3);
    });

    it('退到底就是整串都留', () => {
      const messages = [call('c1'), result('c1')];
      expect(retainedTailCount(messages, 1)).toBe(2);
    });

    it('沒有對得上呼叫的工具結果（孤兒）不阻擋', () => {
      const messages = [...conversation(4), result('孤兒')];
      expect(retainedTailCount(messages, 1)).toBe(1);
    });
  });
});

describe('留幾則（retainedMessageCount）：切點前只剩上一顆摘要就是摘不到東西（#2086）', () => {
  const summary = () =>
    new HumanMessage({ content: '舊摘要。', additional_kwargs: { lc_source: 'summarization' } });
  const big = () => new HumanMessage('字'.repeat(80_000));
  const settings = { trigger: SHIPPED_TRIGGER, retainTokens: 20_000 };

  it('切點前只有上一顆摘要：回整串的長度', () => {
    const messages = [summary(), big(), ...conversation(4)];
    expect(retainedTailCount(messages, 20_000)).toBe(messages.length - 1);
    expect(retainedMessageCount(messages, settings, undefined)).toBe(messages.length);
  });

  it('切點前只有一則、但不是摘要：照選尾巴的數', () => {
    const messages = [new HumanMessage('第一句。'), big(), ...conversation(4)];
    expect(retainedMessageCount(messages, settings, undefined)).toBe(messages.length - 1);
  });

  it('切點前是摘要加一則：照選尾巴的數', () => {
    const messages = [summary(), new HumanMessage('多一則。'), big(), ...conversation(4)];
    expect(retainedMessageCount(messages, settings, undefined)).toBe(messages.length - 2);
  });

  it('算不出 token 保留量、退回 20 則時也一樣', () => {
    const onlyMessages = { trigger: [{ type: 'messages', value: 60 }] as const };
    const messages = [summary(), ...conversation(RETAIN_FALLBACK_MESSAGES)];
    expect(retainedMessageCount(messages, onlyMessages, undefined)).toBe(messages.length);
    const plain = [new HumanMessage('第一句。'), ...conversation(RETAIN_FALLBACK_MESSAGES)];
    // 切得到東西，再封在則數門檻的兩成：20 則封成 12 則。
    expect(retainedMessageCount(plain, onlyMessages, undefined)).toBe(12);
  });
});

describe('留幾則（retainedMessageCount）：切得到東西時，則數封在 `messages` 門檻的兩成（#2659）', () => {
  const unit = estimateMessageTokens(sized('human', '0'));
  /** 保留量剛好是 52 則：沒封頂的話，61 則的串摘完留 52 則，下一輪多 8 則又回到 60。 */
  const settings = { trigger: SHIPPED_TRIGGER, retainTokens: unit * 52 };

  it('照 token 選出 52 則：封成 12 則', () => {
    const messages = conversation(61);
    expect(retainedTailCount(messages, unit * 52)).toBe(52);
    expect(retainedMessageCount(messages, settings, undefined)).toBe(12);
  });

  it('尾巴蓋住整串：不封頂、照舊不摘', () => {
    const messages = conversation(61);
    const covering = { trigger: SHIPPED_TRIGGER, retainTokens: unit * 1_000 };
    expect(retainedMessageCount(messages, covering, undefined)).toBe(messages.length);
  });

  it('沒有 `messages` 門檻就不封', () => {
    const onlyTokens = { trigger: [{ type: 'tokens', value: 100_000 }] as const, retainTokens: unit * 52 };
    expect(retainedMessageCount(conversation(61), onlyTokens, undefined)).toBe(52);
  });

  it('封頂的切點落在工具結果上：退到發出那次呼叫，多留一則', () => {
    const call = new AIMessage({ content: '呼叫。', tool_calls: [{ id: 'c1', name: 'echo', args: {} }] });
    const result = new ToolMessage({ content: '結果。', tool_call_id: 'c1' });
    const messages = [...conversation(49), call, result, ...conversation(11)];
    expect(retainedMessageCount(messages, settings, undefined)).toBe(13);
  });

  it('門檻小到兩成不滿兩則：至少留兩則（最近一來一回）', () => {
    const tiny = { trigger: [{ type: 'messages', value: 3 }] as const, retainTokens: unit * 52 };
    expect(retainedMessageCount(conversation(61), tiny, undefined)).toBe(2);
  });

  it('下限只拉高封頂：照 token 只選出 1 則時仍是 1 則', () => {
    const tiny = { trigger: [{ type: 'messages', value: 3 }] as const, retainTokens: 1 };
    expect(retainedMessageCount(conversation(61), tiny, undefined)).toBe(1);
  });
});

/** 記憶體裡的 backend：基座的 offload 讀 `downloadFiles`、寫 `write`／`uploadFiles`。 */
function memoryBackend() {
  const files = new Map<string, string>();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  return {
    files,
    async downloadFiles(paths: readonly string[]) {
      return paths.map((path) =>
        files.has(path)
          ? { path, content: encoder.encode(files.get(path)!), error: null }
          : { path, content: null, error: 'file_not_found' },
      );
    },
    async uploadFiles(entries: readonly (readonly [string, Uint8Array])[]) {
      return entries.map(([path, content]) => {
        files.set(path, decoder.decode(content));
        return { path, error: null };
      });
    },
    async write(path: string, content: string) {
      files.set(path, content);
      return { path };
    },
    async edit(path: string, _old: string, next: string) {
      files.set(path, next);
      return { path };
    },
  };
}

/** 一顆有名字的假模型：`limitsOf` 靠名字挑型錄。摘要請求會打到它的 `invoke`。 */
function namedModel(name: string) {
  const prompts: string[] = [];
  return {
    prompts,
    model: {
      name,
      profile: {},
      invoke: async (input: readonly BaseMessage[]) => {
        prompts.push(String(input[0]?.content));
        return { text: '這是摘要。' };
      },
    },
  };
}

const LIMITS_BY_NAME: Record<string, ModelContextLimits> = {
  small: SMALL_MODEL,
  mid: MID_MODEL,
};
/** 根 agent 的一次模型呼叫：切點表認得出它。 */
const ROOT_CALL = { configurable: { thread_id: 't', checkpoint_ns: 'model_request:x' } };

const limitsOf = (model: unknown) =>
  LIMITS_BY_NAME[(model as { name?: string } | undefined)?.name ?? ''];

/** 只留 `tokens` 那道門檻：這一節量的是 token 保留量，則數封頂（#2659）會把這裡的上百則小訊息封成 12 則，另有一節。 */
const TOKENS_ONLY = [{ type: 'tokens', value: 100_000 }] as const;

describe('接對：N 決定了送出去的串', () => {
  async function run(options: {
    modelName: string;
    messages: readonly BaseMessage[];
    settings?: Partial<SummarizationSettings>;
    state?: Record<string, unknown>;
    backend?: ReturnType<typeof memoryBackend>;
  }) {
    const { model } = namedModel(options.modelName);
    const cutoffs = new SummaryCutoffTable();
    const middleware = createSummarizer(
      (options.backend ?? memoryBackend()) as never,
      { ...DEFAULT_SUMMARIZATION, trigger: TOKENS_ONLY, ...options.settings },
      new TokenAnchorBook(),
      undefined,
      false,
      limitsOf,
      undefined,
      undefined,
      undefined,
      cutoffs,
    );
    const sent: { messages: readonly BaseMessage[] }[] = [];
    const result = await middleware.wrapModelCall?.(
      {
        messages: options.messages,
        state: { ...options.state, messages: options.messages },
        model,
        systemMessage: new SystemMessage('系統。'),
        tools: [],
        runtime: ROOT_CALL,
      } as never,
      ((request: { messages: readonly BaseMessage[] }) => {
        sent.push(request);
        return new AIMessage('好。');
      }) as never,
    );
    return { sent, result, middleware, cutoff: cutoffs.lookup(ROOT_CALL, options.messages) };
  }

  const unit = estimateMessageTokens(sized('human', '0'));

  /**
   * 同一串訊息、不同模型：90b 的保留量是 4,587、11b 的是 20,000，所以留下的則數不同。**這一條同時證明分派用的是這一步
   * 的模型（`limitsOf(request.model)`），不是建構時定死的值。**
   */
  it('小窗口模型（90b）：留 dsh 的 4,587，比兩成封頂小，所以不被封', async () => {
    // 小窗口的有效門檻 26,214，一串 20 × unit 要超過它：用夠多則。
    const count = Math.ceil(26_214 / unit) + 8;
    const messages = conversation(count);
    const small = await run({ modelName: 'small', messages });
    expect(small.cutoff).toBeDefined();
    const smallKept = small.sent[0]!.messages.length - 1;
    expect(smallKept).toBe(Math.ceil(4_587 / unit));
    expect(String(small.sent[0]!.messages[0]!.content)).toContain('這是摘要。');
  });

  it('中窗口模型（11b）：dsh 的 20,316 被封在 20,000，與沒型錄的同量', async () => {
    const count = Math.ceil(100_000 / unit) + 8;
    const out = await run({ modelName: 'mid', messages: conversation(count) });
    expect(out.cutoff).toBeDefined();
    expect(out.sent[0]!.messages.length - 1).toBe(Math.ceil(20_000 / unit));
  });

  it('沒型錄的模型（limitsOf 回 undefined）：照有效門檻的兩成留', async () => {
    // 預設門檻 100,000 → 保留 20,000；串要超過 100,000。
    const count = Math.ceil(100_000 / unit) + 8;
    const out = await run({ modelName: 'unknown', messages: conversation(count) });
    expect(out.cutoff).toBeDefined();
    expect(out.sent[0]!.messages.length - 1).toBe(Math.ceil(20_000 / unit));
  });

  it('疊上只有一顆：回傳的 middleware 名字是基座那個，沒有 stateSchema', async () => {
    const out = await run({ modelName: 'small', messages: conversation(4) });
    expect(out.middleware.name).toBe(SUMMARIZATION_MIDDLEWARE_NAME);
    // 切點在組裝的切點表上（#2416），圖上沒有摘要的私有欄位。
    expect(out.middleware.stateSchema).toBeUndefined();
  });
});

describe('不寫兩份：不同 N 的實例共用同一個歷史檔', () => {
  const unit = estimateMessageTokens(sized('human', '0'));

  /**
   * 分派器依 N 各建一顆引擎；歷史檔的會話名由同一個 `sessionIdOf` 交給每一顆、照呼叫身分取，所以同一個呼叫身分換了 N 仍是同一個檔。
   */
  async function twoSummaries() {
    const backend = memoryBackend();
    const { model: modelA } = namedModel('small');
    const { model: modelB } = namedModel('mid');
    const cutoffs = new SummaryCutoffTable();
    const middleware = createSummarizer(
      backend as never,
      DEFAULT_SUMMARIZATION,
      new TokenAnchorBook(),
      undefined,
      false,
      limitsOf,
      undefined,
      undefined,
      undefined,
      cutoffs,
    );
    const call = async (model: unknown, messages: readonly BaseMessage[]) => {
      await middleware.wrapModelCall?.(
        {
          messages,
          state: { messages },
          model,
          systemMessage: new SystemMessage('系統。'),
          tools: [],
          runtime: ROOT_CALL,
        } as never,
        (() => new AIMessage('好。')) as never,
      );
      return cutoffs.lookup(ROOT_CALL, messages)!;
    };

    // 第一次：小窗口，N 小。
    const first = await call(modelA, conversation(Math.ceil(26_214 / unit) + 8));
    // 第二次：同一條 thread 接著長，換中窗口（N 不同）。
    const second = await call(modelB, conversation(Math.ceil(100_000 / unit) + 8));
    return { backend, first, second };
  }

  it('換了 N：兩次摘要仍寫進同一個檔，內容是兩段', async () => {
    const { backend, first, second } = await twoSummaries();
    expect(first.filePath).toBeTruthy();
    expect(second.filePath).toBe(first.filePath);
    expect([...backend.files.keys()]).toEqual([first.filePath]);
    const content = backend.files.get(first.filePath!)!;
    expect(content.match(/## Summarized at/g)).toHaveLength(2);
  });
});

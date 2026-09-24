/**
 * 壓力閘門量的是**摘要器眼中的那一串**，不是 `request.messages` 原串。
 *
 * 這一格分不出來的話，剪刀會在第一次摘要之後**永遠**開著——圖的狀態只會長不會縮，所以
 * 原串的門檻從那時起恆成立。那正是 [#149](https://github.com/DemianLi/nexus-agent/issues/149)
 * 明著否掉的「每次超預算就剪」，而且它不拋、不少剪，只多剪，行為上幾乎看不出來。
 * 走 agent 迴圈驗不到這一格：腳本模型的輪數會被摘要器自己那次呼叫吃掉，
 * 「摘要之後才叫工具」排不出穩定的位置——所以判準放在這裡。
 */

import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import {
  createSummarizer,
  DEFAULT_SUMMARIZATION,
  effectiveMessages,
  isUnderCompactionPressure,
  readSummarizationEvent,
} from './summarization.js';
import type { SummarizationThreshold } from './summarization.js';
import { estimateRequestTokens, TokenAnchorBook } from './token-estimate.js';
import { TOOL_RESULT_PRUNE_MARKER } from './tool-result-pruner.js';

/** 一串長到任何門檻都會成立的原始訊息。 */
function longHistory(count: number): BaseMessage[] {
  return Array.from({ length: count }, (_, index) =>
    index % 2 === 0 ? new HumanMessage(`問 ${index}`) : new AIMessage(`答 ${index}`),
  );
}

const SUMMARY = new AIMessage('這是摘要。');

describe('摘要器眼中的訊息串', () => {
  it('沒有摘要事件時就是原串', () => {
    const messages = longHistory(10);
    expect(effectiveMessages(messages, {})).toBe(messages);
    expect(effectiveMessages(messages, undefined)).toBe(messages);
    expect(effectiveMessages(messages, null)).toBe(messages);
  });

  it('有摘要事件時是「摘要 ＋ 切點之後」', () => {
    const messages = longHistory(10);
    const seen = effectiveMessages(messages, {
      _summarizationEvent: { summaryMessage: SUMMARY, cutoffIndex: 8 },
    });

    expect(seen).toHaveLength(3);
    expect(seen[0]).toBe(SUMMARY);
    expect(seen[1]).toBe(messages[8]);
  });

  /** 形狀不對的事件不准把整串吃掉——寧可退回原串（多剪），不要當成空的（少量到）。 */
  it('事件的形狀不對就退回原串', () => {
    const messages = longHistory(10);
    expect(effectiveMessages(messages, { _summarizationEvent: null })).toBe(messages);
    expect(effectiveMessages(messages, { _summarizationEvent: { cutoffIndex: 8 } })).toBe(messages);
    expect(effectiveMessages(messages, { _summarizationEvent: { summaryMessage: SUMMARY } })).toBe(
      messages,
    );
  });
});

describe('壓力閘門', () => {
  const BY_MESSAGES: SummarizationThreshold[] = [{ type: 'messages', value: 6 }];
  const BY_TOKENS: SummarizationThreshold[] = [{ type: 'tokens', value: 5_000 }];
  /** 一段 o200k 大約八千 token 的中文。 */
  const BIG_TEXT = '壓力閘門要量的是摘要器眼中的那一串。'.repeat(800);
  const pressure = (
    messages: readonly BaseMessage[],
    trigger: readonly SummarizationThreshold[],
    state?: unknown,
  ) => isUnderCompactionPressure({ messages, state }, trigger, new TokenAnchorBook());

  it('門檻陣列並聯，任何一道成立就算壓力到了', () => {
    expect(pressure(longHistory(6), BY_MESSAGES)).toBe(true);
    expect(pressure(longHistory(5), BY_MESSAGES)).toBe(false);
    expect(pressure(longHistory(5), [...BY_MESSAGES, { type: 'tokens', value: 1 }])).toBe(true);
  });

  it('token 那道用的是錨定估算，沒錨時就是 o200k 的純估算', () => {
    const big = [new ToolMessage({ content: BIG_TEXT, tool_call_id: 'c1' })];
    // 前提：那段真的超過門檻，短的那句真的沒有。
    expect(estimateRequestTokens({ messages: big })).toBeGreaterThan(5_000);
    expect(pressure(big, BY_TOKENS)).toBe(true);
    expect(pressure([new HumanMessage('短')], BY_TOKENS)).toBe(false);
  });

  /**
   * **這是整組的承重條：摘要之後，長長的原串是「沒有壓力」的。**
   *
   * 同一串訊息，量原串成立、量有效串不成立。閘門要跟後者走。
   */
  it('摘要之後：原串越得過門檻，有效串越不過——閘門要跟有效串走', () => {
    const messages = [...longHistory(9), new ToolMessage({ content: '收到', tool_call_id: 'c1' })];
    const state = { _summarizationEvent: { summaryMessage: SUMMARY, cutoffIndex: 9 } };

    expect(pressure(messages, BY_MESSAGES)).toBe(true);
    expect(pressure(messages, BY_MESSAGES, state)).toBe(false);
  });

  it('摘要之後但有效串真的很大時，壓力照樣算到', () => {
    const messages = [
      ...longHistory(9),
      new ToolMessage({ content: BIG_TEXT, tool_call_id: 'c1' }),
    ];
    const state = { _summarizationEvent: { summaryMessage: SUMMARY, cutoffIndex: 9 } };

    expect(pressure(messages, BY_TOKENS, state)).toBe(true);
  });
});

/**
 * **接線那一格**：`createSummarizer` 包出來的那顆，真的是拿有效串去量的嗎？
 *
 * 上面兩組驗的是兩個純函式；這一組驗的是它們**被接在一起**。少了它，把閘門改回量原串
 * 那個突變在整個測試樹上一條都不紅——而那正是這個缺陷會回來的方式。
 *
 * 這裡直接叫 middleware 的 `wrapModelCall`，不走 agent 迴圈：腳本模型的輪數會被摘要器
 * 自己那次呼叫吃掉，「摘要之後才叫工具」在迴圈裡排不出穩定的位置。
 */
describe('壓力閘門接在有效串上（接線）', () => {
  /** 基座那顆只會讀 `profile`；門檻我們自己給，所以它不會去算模型預設。 */
  const FAKE_MODEL = { profile: {} } as never;

  async function messagesSeenByModel(
    trigger: readonly SummarizationThreshold[],
    messages: readonly BaseMessage[],
    state: Record<string, unknown>,
  ): Promise<readonly BaseMessage[]> {
    // `keep` 留在預設的 20 則：這一串只有 10 則，`determineCutoffIndex` 會算出 `<= 0`、
    // 基座直接 `return handler(...)`。這一格要看的是**剪刀動沒動**，不是摘要跑不跑得起來
    // ——真讓它跑起來就得餵一個會回話的模型，那是另一個檔的事。
    const middleware = createSummarizer({ readFile: async () => null } as never, {
      ...DEFAULT_SUMMARIZATION,
      trigger,
    });
    let seen: readonly BaseMessage[] = [];
    await middleware.wrapModelCall?.(
      {
        messages,
        state,
        model: FAKE_MODEL,
        systemMessage: new SystemMessage('系統。'),
        tools: [],
      } as never,
      ((request: { messages: readonly BaseMessage[] }) => {
        seen = request.messages;
        return new AIMessage('好。');
      }) as never,
    );
    return seen;
  }

  const HUGE = 'X'.repeat(40_000);

  function withHugeTool(): BaseMessage[] {
    return [...longHistory(9), new ToolMessage({ content: HUGE, tool_call_id: 'c1' })];
  }

  /**
   * **承重條。** 原串 10 則越得過「6 則」，有效串只有 2 則越不過——量對的話一個字都不動。
   * 閘門改回量原串就會在這裡紅。
   */
  it('摘要之後有效串在門檻下 → 那坨大東西一個字都沒被動', async () => {
    const seen = await messagesSeenByModel([{ type: 'messages', value: 6 }], withHugeTool(), {
      _summarizationEvent: { summaryMessage: SUMMARY, cutoffIndex: 9 },
    });

    expect(String(seen.at(-1)?.content)).toBe(HUGE);
  });

  /** 對照組：同一串、同一道門檻，沒有摘要事件時壓力是真的到了——這時候就該剪。 */
  it('沒有摘要事件時同一串就會被剪', async () => {
    const seen = await messagesSeenByModel([{ type: 'messages', value: 6 }], withHugeTool(), {});

    expect(String(seen.at(-1)?.content)).toContain(TOOL_RESULT_PRUNE_MARKER);
  });
});

/**
 * **生摘要的那次呼叫帶「不上線」的標記，交下去的是本尊**（[#584](https://github.com/DemianLi/nexus-agent/issues/584)）。
 *
 * 即時與重新整理對得上的那條驗收在 `apps/harness/src/context-pressure.test.ts`，走的是產品路徑。那條驗不到「換回本尊」：
 * 主模型那次先經過 `bindTools`，拿到的是新實例，替身的 `invoke` 本來就碰不到它。換回本尊防的是下一層直接
 * `invoke`、不先 `bindTools` 的那條路，所以釘在這裡：直接叫 `wrapModelCall`，看交下去的是哪一顆。
 */
describe('生摘要的那次呼叫不上線（接線）', () => {
  function fakeModel() {
    const calls: { tags: unknown }[] = [];
    return {
      calls,
      // 基座只讀 `profile`、只呼叫 `invoke`。
      model: {
        profile: {},
        invoke: async (_input: unknown, config?: { tags?: unknown }) => {
          calls.push({ tags: config?.tags });
          return { text: '這是摘要。' };
        },
      },
    };
  }

  async function modelHandedDown(trigger: readonly SummarizationThreshold[], model: object) {
    const middleware = createSummarizer({ write: async (path: string) => ({ path }) } as never, {
      ...DEFAULT_SUMMARIZATION,
      trigger,
      keep: { type: 'messages', value: 2 },
    });
    let handed: unknown;
    await middleware.wrapModelCall?.(
      {
        messages: longHistory(10),
        state: {},
        model,
        systemMessage: new SystemMessage('系統。'),
        tools: [],
      } as never,
      ((request: { model: unknown }) => {
        handed = request.model;
        return new AIMessage('好。');
      }) as never,
    );
    return handed;
  }

  it('摘要了：生摘要那次帶 nostream，交下去的是本尊', async () => {
    const { model, calls } = fakeModel();
    const handed = await modelHandedDown([{ type: 'messages', value: 6 }], model);
    // 前提：真的摘要了，本尊的 `invoke` 被叫了一次。
    expect(calls).toHaveLength(1);
    expect(calls[0]!.tags).toEqual(['nostream']);
    expect(handed).toBe(model);
  });

  it('沒摘要：交下去的也是本尊，一次都沒叫', async () => {
    const { model, calls } = fakeModel();
    const handed = await modelHandedDown([{ type: 'messages', value: 1_000 }], model);
    expect(calls).toEqual([]);
    expect(handed).toBe(model);
  });
});

/**
 * **從摘要器的回傳值認出「這一輪真的壓縮了」。**
 *
 * 這是 `compaction/summary`（[#143](https://github.com/DemianLi/nexus-agent/issues/143)）
 * 的判別式。它是鴨子型別而不是 `instanceof Command`，理由見 `summarization.ts`：pnpm 樹
 * 底下同一個套件可能有多份實例，跨實例的 `instanceof` 是 `false`，而那種錯不會拋，只會讓
 * 事件永遠記不到。
 *
 * 走 agent 迴圈驗得到「有記到」，但驗不到這些邊界——真的跑起來時 `filePath` 永遠是字串。
 */
describe('認出壓縮發生過', () => {
  it('帶 `_summarizationEvent` 的 Command 形狀就是壓縮了', () => {
    expect(
      readSummarizationEvent({
        update: { _summarizationEvent: { cutoffIndex: 12, filePath: '/h/s.md' } },
      }),
    ).toEqual({ cutoffIndex: 12, filePath: '/h/s.md' });
  });

  /**
   * **`filePath: null` 是有意義的那個值，不是「沒有」。**
   *
   * 它正是 [#66](https://github.com/DemianLi/nexus-agent/issues/66) 那個 fail-open 的訊號
   * ——歷史沒寫成功、原文就此消失，而基座對這件事只印一行 `console.warn`。把它當成缺值
   * 而讓整筆事件消失的話，唯一一個耐久痕跡就沒了。
   */
  it('`filePath` 是 null 照樣記，那是 #66 的訊號', () => {
    expect(
      readSummarizationEvent({
        update: { _summarizationEvent: { cutoffIndex: 3, filePath: null } },
      }),
    ).toEqual({ cutoffIndex: 3, filePath: null });
  });

  it('沒壓縮的那些輪回的是模型的回應，認不出東西來', () => {
    expect(readSummarizationEvent(new AIMessage('好。'))).toBeUndefined();
    expect(readSummarizationEvent(undefined)).toBeUndefined();
    expect(readSummarizationEvent(null)).toBeUndefined();
    expect(readSummarizationEvent({ update: null })).toBeUndefined();
    expect(readSummarizationEvent({ update: {} })).toBeUndefined();
  });

  /** 形狀不對就整筆不要——`cutoffIndex` 不是數字的話，記下去也讀不出意義。 */
  it('切點不是數字就整筆不記', () => {
    expect(
      readSummarizationEvent({ update: { _summarizationEvent: { filePath: '/h/s.md' } } }),
    ).toBeUndefined();
    expect(
      readSummarizationEvent({ update: { _summarizationEvent: { cutoffIndex: '3' } } }),
    ).toBeUndefined();
  });

  /** `filePath` 是別的型別時當成沒寫成功，不是讓整筆消失——同上一條的理由，方向相反。 */
  it('`filePath` 型別不對就當成沒寫成功', () => {
    expect(
      readSummarizationEvent({ update: { _summarizationEvent: { cutoffIndex: 5, filePath: 7 } } }),
    ).toEqual({ cutoffIndex: 5, filePath: null });
  });
});

/**
 * **`tokens` 門檻由錨定估算比，超過就借基座的溢出恢復路徑摘要**（[#588](https://github.com/DemianLi/nexus-agent/issues/588)）。
 *
 * 走真的 `createSummarizationMiddleware`：這一層靠的是基座那條 `catch` 真的認得我們拋的那顆、而且只在它接得住的
 * 地方拋，用替身驗不到。
 */
describe('tokens 門檻（接線）', () => {
  /** o200k 大約三千 token 的中文。 */
  const BIG = '這一段很長，要讓估算越過門檻。'.repeat(300);

  function fakeModel() {
    const invokes: unknown[] = [];
    return {
      invokes,
      model: {
        profile: {},
        invoke: async (_input: unknown, config?: { tags?: unknown }) => {
          invokes.push(config?.tags);
          return { text: '這是摘要。' };
        },
      },
    };
  }

  async function run(options: {
    trigger: readonly SummarizationThreshold[];
    keep?: number;
    messages: readonly BaseMessage[];
    pruning?: false;
    book?: TokenAnchorBook;
    reply?: (sent: readonly BaseMessage[]) => AIMessage;
  }) {
    const { model, invokes } = fakeModel();
    const middleware = createSummarizer(
      { write: async (path: string) => ({ path }) } as never,
      {
        ...DEFAULT_SUMMARIZATION,
        trigger: options.trigger,
        keep: { type: 'messages', value: options.keep ?? 20 },
      },
      undefined,
      options.pruning,
      options.book ?? new TokenAnchorBook(),
    );
    const sent: { messages: readonly BaseMessage[]; model: unknown }[] = [];
    const result = await middleware.wrapModelCall?.(
      { messages: options.messages, state: {}, model, systemMessage: SYSTEM, tools: [] } as never,
      ((request: { messages: readonly BaseMessage[]; model: unknown }) => {
        sent.push(request);
        return options.reply?.(request.messages) ?? new AIMessage('好。');
      }) as never,
    );
    return { sent, invokes, model, result };
  }

  const SYSTEM = new SystemMessage('系統。');
  const history = (last: BaseMessage) => [
    new HumanMessage(BIG),
    new AIMessage('一'),
    new HumanMessage('二'),
    new AIMessage('三'),
    new HumanMessage('四'),
    new AIMessage('五'),
    last,
  ];

  it('超過預算：摘要剛好一次，送出去的是摘要過的那串，而且只送一次', async () => {
    const { sent, invokes, result } = await run({
      trigger: [{ type: 'tokens', value: 2_000 }],
      keep: 2,
      messages: history(new HumanMessage('短問題')),
      pruning: false,
    });
    expect(invokes).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(String(sent[0]!.messages[0]!.content)).toContain('這是摘要。');
    expect(sent[0]!.messages).toHaveLength(3);
    expect(readSummarizationEvent(result)).toBeDefined();
  });

  it('預算觸發的那次摘要照樣不上線，交下去的是本尊', async () => {
    const { sent, invokes, model } = await run({
      trigger: [{ type: 'tokens', value: 2_000 }],
      keep: 2,
      messages: history(new HumanMessage('短問題')),
      pruning: false,
    });
    expect(invokes).toEqual([['nostream']]);
    expect(sent[0]!.model).toBe(model);
  });

  it('沒超過：不摘要，原串交下去', async () => {
    const messages = history(new HumanMessage('短問題')).slice(1);
    const { sent, invokes } = await run({
      trigger: [{ type: 'tokens', value: 2_000 }],
      keep: 2,
      messages,
      pruning: false,
    });
    expect(invokes).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.messages).toHaveLength(messages.length);
  });

  /** 基座走 `messages` 那條路、又切不出東西時，`handler` 沒有 `try`——拋了就是整輪失敗。 */
  it('messages 門檻成立、則數不夠切：超過預算也不拋，原串交下去', async () => {
    const messages = history(new HumanMessage('短問題'));
    const { sent, invokes } = await run({
      trigger: [
        { type: 'tokens', value: 2_000 },
        { type: 'messages', value: 3 },
      ],
      keep: 20,
      messages,
      pruning: false,
    });
    expect(invokes).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.messages).toHaveLength(messages.length);
  });

  it('摘要完還是超過：放行，不摘第二次', async () => {
    const { sent, invokes } = await run({
      trigger: [{ type: 'tokens', value: 2_000 }],
      keep: 2,
      messages: history(new HumanMessage(BIG)),
      pruning: false,
    });
    expect(invokes).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(String(sent[0]!.messages.at(-1)!.content)).toBe(BIG);
  });

  /**
   * **剪刀不來回震盪。** 剪刀估的是沒剪的那一份、錨在上一次**送出去**（剪過）的那份上：上一次剪過，被剪掉的
   * 那一截會出現在增量裡，這一次照樣判成有壓力。錨在「這串訊息裡錨之前那段」的話，剪掉的那一截兩邊抵消，
   * 第二次會判成沒壓力、原封送出去。
   */
  it('連續兩次都超過：兩次都剪', async () => {
    const book = new TokenAnchorBook();
    const huge = '工具結果很大，剪刀要剪它。'.repeat(2_000);
    const first = [
      new HumanMessage('讀檔'),
      new AIMessage({ content: '', tool_calls: [{ id: 'c1', name: 'read_file', args: {} }] }),
      new ToolMessage({ content: huge, tool_call_id: 'c1' }),
    ];
    // 前提：沒剪之前遠超過門檻，剪過之後在門檻下。
    expect(estimateRequestTokens({ messages: first, systemMessage: SYSTEM })).toBeGreaterThan(
      10_000,
    );
    const reply = (id: string) => (sent: readonly BaseMessage[]) =>
      new AIMessage({
        id,
        content: '好。',
        usage_metadata: {
          input_tokens: estimateRequestTokens({ messages: sent, systemMessage: SYSTEM }),
          output_tokens: 1,
          total_tokens: 1,
        },
      });
    const trigger: SummarizationThreshold[] = [{ type: 'tokens', value: 10_000 }];
    const one = await run({ trigger, messages: first, book, reply: reply('r1') });
    expect(String(one.sent[0]!.messages[2]!.content)).toContain(TOOL_RESULT_PRUNE_MARKER);
    expect(
      estimateRequestTokens({ messages: one.sent[0]!.messages, systemMessage: SYSTEM }),
    ).toBeLessThan(10_000);

    const second = [...first, reply('r1')(one.sent[0]!.messages), new HumanMessage('再問一次')];
    const two = await run({ trigger, messages: second, book, reply: reply('r2') });
    expect(String(two.sent[0]!.messages[2]!.content)).toContain(TOOL_RESULT_PRUNE_MARKER);
    expect(two.invokes).toEqual([]);
  });
});

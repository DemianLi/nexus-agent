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
} from './summarization.js';
import type { SummarizationThreshold } from './summarization.js';
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

  it('門檻陣列並聯，任何一道成立就算壓力到了', () => {
    expect(isUnderCompactionPressure(longHistory(6), BY_MESSAGES)).toBe(true);
    expect(isUnderCompactionPressure(longHistory(5), BY_MESSAGES)).toBe(false);
    expect(
      isUnderCompactionPressure(longHistory(5), [...BY_MESSAGES, { type: 'tokens', value: 1 }]),
    ).toBe(true);
  });

  it('token 那道用的是訊息內容的量', () => {
    const big = [new ToolMessage({ content: 'X'.repeat(40_000), tool_call_id: 'c1' })];
    expect(isUnderCompactionPressure(big, BY_TOKENS)).toBe(true);
    expect(isUnderCompactionPressure([new HumanMessage('短')], BY_TOKENS)).toBe(false);
  });

  /**
   * **這是整組的承重條：摘要之後，長長的原串是「沒有壓力」的。**
   *
   * 同一串訊息，量原串成立、量有效串不成立。閘門要跟後者走。
   */
  it('摘要之後：原串越得過門檻，有效串越不過——閘門要跟有效串走', () => {
    const messages = [...longHistory(9), new ToolMessage({ content: '收到', tool_call_id: 'c1' })];
    const state = { _summarizationEvent: { summaryMessage: SUMMARY, cutoffIndex: 9 } };

    expect(isUnderCompactionPressure(messages, BY_MESSAGES)).toBe(true);
    expect(isUnderCompactionPressure(effectiveMessages(messages, state), BY_MESSAGES)).toBe(false);
  });

  it('摘要之後但有效串真的很大時，壓力照樣算到', () => {
    const messages = [
      ...longHistory(9),
      new ToolMessage({ content: 'X'.repeat(40_000), tool_call_id: 'c1' }),
    ];
    const state = { _summarizationEvent: { summaryMessage: SUMMARY, cutoffIndex: 9 } };

    expect(isUnderCompactionPressure(effectiveMessages(messages, state), BY_TOKENS)).toBe(true);
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

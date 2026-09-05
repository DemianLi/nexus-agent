/**
 * 圍堵自己的邏輯——直接餵它一個假的 `handler`，看它把什麼交回來。
 *
 * 這一份跟著實作從 `@nexus/plugin-validation` 搬過來
 * （[#159](https://github.com/DemianLi/nexus-agent/issues/159)）。**它掛在哪、順序排第幾**
 * 由 [`fold.test.ts`](./fold.test.ts) 釘；**掛進真的 agent 之後行為對不對**在
 * `apps/harness/src/validation.test.ts`，那一層才碰得到基座那條「工具拋錯就整場死」的路。
 */

import { ToolMessage } from '@langchain/core/messages';
import { GraphInterrupt } from '@langchain/langgraph';
import { describe, expect, it } from 'vitest';
import {
  createContainmentMiddleware,
  declaredToolTimeoutMs,
  formatToolTimeout,
  isToolTimeout,
} from './containment.js';

/** middleware 的 `wrapToolCall` 拿出來直接呼叫用的形狀。 */
type Wrapper = (
  request: unknown,
  handler: (request: unknown) => Promise<unknown>,
) => Promise<unknown>;

/** 從 middleware 上取出 `wrapToolCall`，沒有就當場失敗。 */
function wrapperOf(middleware: unknown): Wrapper {
  const wrap = (middleware as { wrapToolCall?: Wrapper }).wrapToolCall;
  if (wrap === undefined) throw new Error('這個 middleware 沒有 wrapToolCall');
  return wrap;
}

/** 一次工具呼叫的假請求。`budgetMs` 給了就當這顆工具宣告了預算。 */
function requestFor(toolName: string, budgetMs?: number): unknown {
  return {
    toolCall: { name: toolName, args: {}, id: 'call-1' },
    tool:
      budgetMs === undefined ? undefined : { name: toolName, defaultConfig: { timeout: budgetMs } },
    state: {},
    runtime: {},
  };
}

/**
 * `AbortSignal.timeout()` 逾時時真正拋出來的那顆。
 *
 * **用真的 `DOMException` 而不是 `Object.assign(new Error(), { name })`**：分類靠的是
 * `instanceof Error` 與 `name` 兩件事同時成立，而 `DOMException` 在 Node 上兩件都成立
 * 這一點正是要釘住的（`getAbortSignalError` 直接把 `signal.reason` 交出來）。
 */
function abortException(name: 'TimeoutError' | 'AbortError'): unknown {
  return new DOMException(
    name === 'TimeoutError'
      ? 'The operation was aborted due to timeout'
      : 'This operation was aborted',
    name,
  );
}

describe('圍堵', () => {
  const wrap = wrapperOf(createContainmentMiddleware());

  it('工具拋錯 → 一則 status error 的 ToolMessage，不再往外拋', async () => {
    const result = (await wrap(requestFor('probe'), () => {
      throw new Error('磁碟滿了');
    })) as ToolMessage;
    expect(ToolMessage.isInstance(result)).toBe(true);
    expect(result.status).toBe('error');
    expect(String(result.content)).toContain('probe');
    expect(String(result.content)).toContain('磁碟滿了');
    expect(result.tool_call_id).toBe('call-1');
  });

  it('訊息裡不帶堆疊、也不帶原始參數', async () => {
    const boom = new Error('炸了');
    boom.stack = 'Error: 炸了\n    at /Users/someone/secret/path.ts:1:1';
    const result = (await wrap(
      { toolCall: { name: 'probe', args: { key: 'sk-機密值' }, id: 'c' } },
      () => {
        throw boom;
      },
    )) as ToolMessage;
    expect(String(result.content)).not.toContain('/Users/someone/secret/path.ts');
    expect(String(result.content)).not.toContain('sk-機密值');
  });

  it('**中斷放行**——GraphBubbleUp 原樣往外拋', async () => {
    const interrupt = new GraphInterrupt([{ value: '要核准嗎', id: 'i1' }]);
    await expect(
      wrap(requestFor('probe'), () => {
        throw interrupt;
      }),
    ).rejects.toBe(interrupt);
  });

  it('沒出錯就原樣交回去', async () => {
    const message = new ToolMessage({ content: '好了', tool_call_id: 'call-1', name: 'probe' });
    expect(await wrap(requestFor('probe'), async () => message)).toBe(message);
  });

  it('超時被單獨認出來，訊息說得出等了多久', async () => {
    const result = (await wrap(requestFor('slow', 40), async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      throw abortException('TimeoutError');
    })) as ToolMessage;
    expect(result.status).toBe('error');
    const text = String(result.content);
    expect(text).toContain('工具 slow 超時');
    expect(text).toContain('40ms 預算');
    // **數字要接近真的等待時間，不是「有一個數字」。** 只斷言「含有數字」的話，回報 0
    // 或回報整場 run 的牆鐘都會過。
    const elapsed = Number(/等了 (\d+)ms/.exec(text)?.[1]);
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(2000);
    // 原始的英文訊息不該再出現——它就是這張卡要換掉的東西。
    expect(text).not.toContain('The operation was aborted');
  });

  it('**使用者取消不是超時**——同一個 catch，不同的 name', async () => {
    const result = (await wrap(requestFor('cancelled', 40), async () => {
      throw abortException('AbortError');
    })) as ToolMessage;
    const text = String(result.content);
    expect(text).toContain('工具 cancelled 執行失敗');
    expect(text).not.toContain('超時');
  });

  it('一般拋錯不被誤標成超時', async () => {
    const result = (await wrap(requestFor('boom', 5000), async () => {
      throw new Error('連不上');
    })) as ToolMessage;
    expect(String(result.content)).toBe('工具 boom 執行失敗：連不上');
  });

  it('沒宣告預算的工具超時了，只講等了多久', async () => {
    const result = (await wrap(requestFor('nobudget'), async () => {
      throw abortException('TimeoutError');
    })) as ToolMessage;
    const text = String(result.content);
    expect(text).toContain('工具 nobudget 超時：等了');
    expect(text).not.toContain('預算');
  });

  it('**沒有 closure 狀態**——所以 root 與每個 subagent 共用同一份實例是安全的', async () => {
    // fold 只建一次就掛遍 root 與所有 subagent（見 `fold.ts`）。這一條擋的是「哪天有人
    // 往這裡加一個跨呼叫的累計器」——那會讓兩個 agent 的狀態悄悄混在一起。
    const shared = wrapperOf(createContainmentMiddleware());
    const first = (await shared(requestFor('a'), () => {
      throw new Error('第一個');
    })) as ToolMessage;
    const second = (await shared(requestFor('b'), () => {
      throw new Error('第二個');
    })) as ToolMessage;
    expect(String(first.content)).toContain('工具 a 執行失敗：第一個');
    expect(String(second.content)).toContain('工具 b 執行失敗：第二個');
  });
});

/**
 * 分類與措辭的直接驗收。
 *
 * **`formatToolTimeout` 的條件式那一格是量出來的**：一顆宣告 5000ms 的工具，在呼叫端
 * 另外給了 120ms 預算時，`catch` 一樣收到 `TimeoutError`，而 `defaultConfig.timeout`
 * 讀出來仍是 5000——先響的是 120 那顆。所以「宣告的預算」只在它合理地可能是成因時才講。
 */
describe('超時的分類與措辭', () => {
  it('只認 name，不比對訊息', () => {
    expect(isToolTimeout(abortException('TimeoutError'))).toBe(true);
    expect(isToolTimeout(abortException('AbortError'))).toBe(false);
    expect(isToolTimeout(new Error('The operation was aborted due to timeout'))).toBe(false);
    expect(isToolTimeout('TimeoutError')).toBe(false);
    expect(isToolTimeout(undefined)).toBe(false);
  });

  it('宣告的預算讀得出來，讀不出來的都退回 undefined', () => {
    expect(declaredToolTimeoutMs({ tool: { defaultConfig: { timeout: 250 } } })).toBe(250);
    expect(declaredToolTimeoutMs({ tool: { defaultConfig: {} } })).toBeUndefined();
    expect(declaredToolTimeoutMs({ tool: { defaultConfig: { timeout: 0 } } })).toBeUndefined();
    expect(declaredToolTimeoutMs({ tool: { defaultConfig: { timeout: -1 } } })).toBeUndefined();
    expect(
      declaredToolTimeoutMs({ tool: { defaultConfig: { timeout: Number.NaN } } }),
    ).toBeUndefined();
    expect(declaredToolTimeoutMs({ tool: {} })).toBeUndefined();
    expect(declaredToolTimeoutMs({})).toBeUndefined();
  });

  it('等得比預算久 → 兩個數字都講', () => {
    expect(formatToolTimeout('t', 130, 120)).toBe(
      '工具 t 超時：等了 130ms，超過它宣告的 120ms 預算。',
    );
  });

  it('**等得比預算短 → 不講預算**：先響的是別人的計時器，兩個數字擺一起像自相矛盾', () => {
    expect(formatToolTimeout('t', 121, 5000)).toBe('工具 t 超時：等了 121ms。');
  });

  it('沒宣告預算 → 只講等了多久', () => {
    expect(formatToolTimeout('t', 300)).toBe('工具 t 超時：等了 300ms。');
  });
});

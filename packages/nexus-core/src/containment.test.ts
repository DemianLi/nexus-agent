/**
 * 圍堵自己的邏輯——直接餵它一個假的 `handler`，看它把什麼交回來。
 *
 * 這一份跟著實作從 `@nexus/plugin-validation` 搬過來
 * （[#159](https://github.com/DemianLi/nexus-agent/issues/159)）。**它掛在哪、順序排第幾**
 * 由 [`fold.test.ts`](./fold.test.ts) 釘；**掛進真的 agent 之後行為對不對**在
 * `apps/harness/src/validation.test.ts`，那一層才碰得到基座那條「工具拋錯就整場死」的路。
 */

import { ToolMessage } from '@langchain/core/messages';
import { ToolInputParsingException } from '@langchain/core/tools';
import { Command, GraphInterrupt } from '@langchain/langgraph';
import { MiddlewareError, ToolInvocationError } from 'langchain';
import { describe, expect, it } from 'vitest';
import {
  classifyThrownToolError,
  createContainmentMiddleware,
  declaredToolTimeoutMs,
  formatToolTimeout,
  isToolTimeout,
} from './containment.js';
import type { SessionLookup } from './registry.js';
import { SessionLog } from './session-log.js';
import { INVALID_TOOL_OUTPUT, markToolError } from './tool-events.js';

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
 * **工具事件**（[#264](https://github.com/DemianLi/nexus-agent/issues/264)）：圍堵自己的那一半
 * ——一次呼叫落下什麼、碼從哪裡來、什麼時候整對不記。
 *
 * 掛進真的 agent 之後落在哪一份日誌（root／subagent）、兩條路都產不產得出來，由
 * `apps/harness/src/tool-events.test.ts` 量。
 */
describe('工具事件', () => {
  /** 一顆會把事件記進 `log` 的圍堵。`lookup` 給了就用它，不給就是找到 `log`。 */
  function recorder(log: SessionLog, lookup?: SessionLookup): Wrapper {
    return wrapperOf(
      createContainmentMiddleware({
        forCall: () => lookup ?? { kind: 'ok', address: { kind: 'root' }, log },
      }),
    );
  }

  /** 一次帶參數、帶身分的請求。`tool` 省略就是一顆存在的工具。 */
  function call(options: { id?: string; tool?: unknown; args?: unknown } = {}): unknown {
    return {
      toolCall: {
        name: 'probe',
        args: options.args ?? { path: '/a', n: 1 },
        ...('id' in options ? { id: options.id } : { id: 'call-1' }),
      },
      tool: 'tool' in options ? options.tool : { name: 'probe' },
      state: {},
      runtime: { configurable: { checkpoint_ns: 'tools:x' } },
    };
  }

  /** 日誌裡的工具事件，只留型別與酬載。 */
  function toolEvents(log: SessionLog): { type: string; data: unknown }[] {
    return log.events
      .filter((event) => event.type === 'tool/call' || event.type === 'tool/result')
      .map((event) => ({ type: event.type, data: event.data }));
  }

  /** 最後一顆 `tool/result` 的酬載。 */
  function lastResult(log: SessionLog): Record<string, unknown> {
    const found = toolEvents(log)
      .filter((event) => event.type === 'tool/result')
      .at(-1);
    if (found === undefined) throw new Error('沒有 tool/result');
    return found.data as Record<string, unknown>;
  }

  it('成功 → 一對，callId 相同，arguments 是參數物件序列化後的字串', async () => {
    const log = new SessionLog('s');
    const message = new ToolMessage({ content: '好了', tool_call_id: 'call-1', name: 'probe' });
    expect(await recorder(log)(call(), async () => message)).toBe(message);
    expect(toolEvents(log)).toEqual([
      {
        type: 'tool/call',
        data: { callId: 'call-1', name: 'probe', arguments: '{"path":"/a","n":1}' },
      },
      { type: 'tool/result', data: { callId: 'call-1', isError: false } },
    ]);
  });

  it('**tool/call 在 handler 之前就記了**——擋在內層的呼叫一樣有', async () => {
    const log = new SessionLog('s');
    let seenBeforeHandler = -1;
    await recorder(log)(call(), async () => {
      seenBeforeHandler = toolEvents(log).length;
      return new ToolMessage({ content: '拒絕', tool_call_id: 'call-1', status: 'error' });
    });
    expect(seenBeforeHandler).toBe(1);
  });

  it.each([
    [
      '超時',
      () => abortException('TimeoutError'),
      { name: 'ToolTimeoutError', code: 'TOOL_TIMEOUT' },
    ],
    ['取消', () => abortException('AbortError'), { name: 'AbortError', code: 'ABORTED' }],
    [
      '參數不合',
      () =>
        new ToolInvocationError(new ToolInputParsingException('n 要是數字'), {
          name: 'probe',
          args: {},
          id: 'call-1',
        }),
      { name: 'ToolArgsError', code: 'INVALID_ARGS' },
    ],
  ])('%s → tool/result 帶 dsh 的碼', async (_label, thrown, expected) => {
    const log = new SessionLog('s');
    await recorder(log)(call(), async () => {
      throw thrown();
    });
    expect(lastResult(log)).toEqual({ callId: 'call-1', isError: true, error: expected });
  });

  it('**一般拋錯照 dsh 沒有碼**——連 `error` 這個 key 都不放', async () => {
    const log = new SessionLog('s');
    await recorder(log)(call(), async () => {
      throw new Error('連不上');
    });
    const result = lastResult(log);
    expect(result).toEqual({ callId: 'call-1', isError: true });
    expect('error' in result).toBe(false);
  });

  it('參數不合被包了幾層 `MiddlewareError` 也認得出來', () => {
    const root = new ToolInvocationError(new ToolInputParsingException('壞'), {
      name: 'probe',
      args: {},
      id: 'call-1',
    });
    const wrapped = MiddlewareError.wrap(MiddlewareError.wrap(root, 'inner'), 'outer');
    expect(MiddlewareError.isInstance(wrapped)).toBe(true);
    expect(classifyThrownToolError(wrapped)).toEqual({
      name: 'ToolArgsError',
      code: 'INVALID_ARGS',
    });
    // 名字叫 Error 的一般錯誤不能被當成參數不合——認的是品牌不是 name。
    expect(classifyThrownToolError(new Error('Error'))).toBeUndefined();
  });

  it('內層標過碼的錯誤訊息 → 帶那個碼', async () => {
    const log = new SessionLog('s');
    const rejected = markToolError(
      new ToolMessage({ content: '不合 schema', tool_call_id: 'call-1', status: 'error' }),
      { name: 'ToolOutputError', code: INVALID_TOOL_OUTPUT },
    );
    await recorder(log)(call(), async () => rejected);
    expect(lastResult(log)).toEqual({
      callId: 'call-1',
      isError: true,
      error: { name: 'ToolOutputError', code: 'INVALID_TOOL_OUTPUT' },
    });
  });

  it('**標了碼但結果不是錯誤就不帶**——碼只跟著 isError 走', async () => {
    const log = new SessionLog('s');
    const odd = markToolError(new ToolMessage({ content: '好', tool_call_id: 'call-1' }), {
      name: 'ToolOutputError',
      code: INVALID_TOOL_OUTPUT,
    });
    await recorder(log)(call(), async () => odd);
    expect(lastResult(log)).toEqual({ callId: 'call-1', isError: false });
  });

  it('工具不存在而內層回了錯誤 → UNKNOWN_TOOL；工具存在就不是', async () => {
    const unknown = new SessionLog('u');
    const known = new SessionLog('k');
    const failed = () =>
      new ToolMessage({ content: '沒這顆', tool_call_id: 'call-1', status: 'error' });
    await recorder(unknown)(call({ tool: undefined }), async () => failed());
    await recorder(known)(call(), async () => failed());
    expect(lastResult(unknown)).toEqual({
      callId: 'call-1',
      isError: true,
      error: { name: 'ToolNotFoundError', code: 'UNKNOWN_TOOL' },
    });
    expect(lastResult(known)).toEqual({ callId: 'call-1', isError: true });
  });

  it('工具回 `Command` → 讀它夾帶的那則 ToolMessage', async () => {
    const log = new SessionLog('s');
    const command = new Command({
      update: {
        messages: [
          new ToolMessage({ content: '別人的', tool_call_id: 'other' }),
          new ToolMessage({ content: '壞了', tool_call_id: 'call-1', status: 'error' }),
        ],
      },
    });
    expect(await recorder(log)(call(), async () => command)).toBe(command);
    expect(lastResult(log)).toEqual({ callId: 'call-1', isError: true });
  });

  it('**中斷不是落定**——只留一顆 tool/call，中斷原樣往外拋', async () => {
    const log = new SessionLog('s');
    const interrupt = new GraphInterrupt([{ value: '要核准嗎', id: 'i1' }]);
    await expect(
      recorder(log)(call(), () => {
        throw interrupt;
      }),
    ).rejects.toBe(interrupt);
    expect(toolEvents(log).map((event) => event.type)).toEqual(['tool/call']);
  });

  it('沒有 callId → 整對不記，結果照舊交回去', async () => {
    const log = new SessionLog('s');
    const message = new ToolMessage({ content: '好了', tool_call_id: '', name: 'probe' });
    expect(await recorder(log)(call({ id: undefined }), async () => message)).toBe(message);
    expect(toolEvents(log)).toEqual([]);
  });

  it.each([
    ['沒接會話', { kind: 'not-attached' } as const],
    ['認不出屬於誰', { kind: 'unknown-caller' } as const],
    ['不只一張註冊表', { kind: 'ambiguous', count: 2 } as const],
  ])('%s → 一顆都不記', async (_label, lookup) => {
    const log = new SessionLog('s');
    await recorder(log, lookup)(call(), async () => {
      throw new Error('照樣圍堵');
    });
    expect(toolEvents(log)).toEqual([]);
  });

  it('參數序列化不動 → 整對不記，呼叫照樣跑', async () => {
    const log = new SessionLog('s');
    let ran = false;
    await recorder(log)(call({ args: { big: 1n } }), async () => {
      ran = true;
      return new ToolMessage({ content: '好', tool_call_id: 'call-1' });
    });
    expect(ran).toBe(true);
    expect(toolEvents(log)).toEqual([]);
  });

  it('**日誌寫不進去不殺掉這次呼叫**', async () => {
    const broken = {
      append() {
        throw new Error('磁碟滿了');
      },
    } as unknown as SessionLog;
    const message = new ToolMessage({ content: '好了', tool_call_id: 'call-1', name: 'probe' });
    const wrap = wrapperOf(
      createContainmentMiddleware({
        forCall: () => ({ kind: 'ok', address: { kind: 'root' }, log: broken }),
      }),
    );
    expect(await wrap(call(), async () => message)).toBe(message);
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

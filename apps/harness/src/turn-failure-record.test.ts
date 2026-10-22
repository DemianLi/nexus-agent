/**
 * 模型失敗的紀錄：欄位驗證、凍結、供應商措辭的額度與超窗、`UNKNOWN` 失敗的原因鏈
 * （[#1557](https://github.com/DemianLi/nexus-agent/issues/1557)，成熟度地圖 #1499 的 `N0471`／`N0478`／`N0479`／`N0480`）。
 *
 * 分兩層：
 *
 * - **分類器本身**（`classifyTurnFailure`、`turnFailureOf`、`classifyFailedAttempt`）：手刻的錯誤鏈，專門造「怪值」
 *   （`toString` 會拋、`status` 是 `NaN`、`cause` 的存取子會拋）——這些今天沒有真的生產者，所以只能手刻。
 * - **整條產品路徑**（真的 `createNexusAgent`＋`ThreadPump`＋會話日誌）：工具 middleware 拋出帶 `cause` 的錯，
 *   `turn/failed.message` 看得到整條原因鏈。供應商措辭那幾列走真的 `createLiveModel`＋loopback 假端點，在
 *   `model-failure-classification.test.ts` 的最後一組。
 *
 * **零憑證、零外部連線**。
 */

import { ContextOverflowError } from '@langchain/core/errors';
import { MemorySaver } from '@langchain/langgraph';
import { createMiddleware, MiddlewareError } from 'langchain';
import type { AgentMiddleware } from 'langchain';
import { LLM_FAILURE_FALLBACK_MESSAGE, markModelCallFailure } from '@nexus/core';
import type { PluginEntry, SessionEvent } from '@nexus/core';
import { tool } from 'langchain';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import { classifyFailedAttempt, classifyTurnFailure, turnFailureOf } from './live-model.js';
import { ScriptedChatModel } from './scripted-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

/** 一顆 `toString` 會拋錯的值。 */
const hostile = (): object => ({
  toString(): string {
    throw new Error('toString 拋錯');
  },
});

/** 帶 `status` 的錯誤。 */
const withStatus = (status: unknown, message = 'x'): Error =>
  Object.assign(new Error(message), { status });

describe('N0471：怪值不能讓記失敗那一步拋錯', () => {
  it('toString 會拋錯的值：分類得出來（UNKNOWN），訊息是固定字', () => {
    const failure = classifyTurnFailure(hostile());
    expect(failure).toEqual({ message: LLM_FAILURE_FALLBACK_MESSAGE, code: 'UNKNOWN' });
    const recorded = turnFailureOf(hostile());
    expect(recorded.message).toBe(LLM_FAILURE_FALLBACK_MESSAGE);
    expect(recorded.error.message).toBe(recorded.message);
  });

  it('status 的 getter 會拋錯：照樣分類，那一格當作沒有；其他環照讀', () => {
    const broken = new Error('額度', { cause: undefined });
    Object.defineProperty(broken, 'status', {
      get() {
        throw new Error('getter 拋錯');
      },
    });
    Object.assign(broken, { type: 'insufficient_quota' });
    expect(classifyTurnFailure(broken)).toEqual({ message: '額度', code: 'QUOTA' });

    // 外層那一環的 getter 壞了，底下那一環的 429 仍然讀得到。
    const outer = new Error('外層', { cause: withStatus(429, '內層') });
    Object.defineProperty(outer, 'status', {
      get() {
        throw new Error('getter 拋錯');
      },
    });
    expect(classifyTurnFailure(outer)).toMatchObject({ code: 'RATE_LIMIT', status: 429 });
  });

  it('cause 的 getter 會拋錯：停在那一環，前面讀到的照用', () => {
    const outer = withStatus(503, '過載');
    Object.defineProperty(outer, 'cause', {
      get() {
        throw new Error('cause 拋錯');
      },
    });
    expect(classifyTurnFailure(outer)).toMatchObject({ code: 'SERVER', status: 503 });
  });

  it.each([Number.NaN, 99, 600, 429.5, 1e9, Number.POSITIVE_INFINITY])(
    'status 是 %s：回傳裡沒有 status，碼不是 HTTP_NaN 之類',
    (status) => {
      const failure = classifyTurnFailure(withStatus(status));
      expect(failure).not.toHaveProperty('status');
      expect(failure.code).toBe('UNKNOWN');
    },
  );

  it('狀態不合格的環不擋住後面合格的環', () => {
    const chain = withStatus(Number.NaN, '外');
    chain.cause = withStatus(429, '內');
    expect(classifyTurnFailure(chain)).toMatchObject({ code: 'RATE_LIMIT', status: 429 });
  });

  it('429、503 照舊是 RATE_LIMIT、SERVER', () => {
    expect(classifyTurnFailure(withStatus(429))).toMatchObject({ code: 'RATE_LIMIT', status: 429 });
    expect(classifyTurnFailure(withStatus(503))).toMatchObject({ code: 'SERVER', status: 503 });
  });

  it('回傳的 LlmFailure 是凍結的，供應商請求編號原樣保留（#1536）', () => {
    const error = Object.assign(withStatus(429), {
      headers: new Headers({ 'x-request-id': 'req-1557' }),
    });
    const failure = classifyTurnFailure(error);
    expect(Object.isFrozen(failure)).toBe(true);
    expect(failure.requestId).toBe('req-1557');
    expect(Object.isFrozen(turnFailureOf(error).error)).toBe(true);
    expect(turnFailureOf(error).error.requestId).toBe('req-1557');
  });
});

describe('N0478：額度與超窗的供應商措辭（只在模型呼叫的錯誤鏈上）', () => {
  const quota = 'You exceeded your current quota, please check your plan and billing details.';

  it('模型呼叫的 429，訊息說額度用完（沒有 insufficient_quota 碼）：QUOTA', () => {
    const error = Object.assign(withStatus(429, `429 ${quota}`), { type: 'requests' });
    markModelCallFailure(error);
    expect(classifyTurnFailure(error)).toMatchObject({ code: 'QUOTA', status: 429 });
  });

  it.each([
    'Rate limit reached for requests',
    'Too many requests, please slow down',
    'Limit 3 requests per minute',
  ])('反例：429 「%s」照舊是 RATE_LIMIT', (message) => {
    const error = withStatus(429, message);
    markModelCallFailure(error);
    expect(classifyTurnFailure(error).code).toBe('RATE_LIMIT');
  });

  it('401 帶 insufficient quota 字樣仍是 AUTH（AUTH 排在額度前面，同 dsh）', () => {
    const error = withStatus(401, 'Incorrect API key. insufficient quota');
    markModelCallFailure(error);
    expect(classifyTurnFailure(error).code).toBe('AUTH');
  });

  it('工具 middleware 拋的錯（沒標模型呼叫）：訊息帶額度字樣，碼不能是 QUOTA', () => {
    const toolError = new Error(`外部服務回：${quota}`);
    expect(classifyTurnFailure(toolError).code).toBe('UNKNOWN');
    // 狀態碼也不讓字樣翻案：同一句話，標了模型呼叫才是 QUOTA。
    const withCode = withStatus(400, quota);
    expect(classifyTurnFailure(withCode).code).toBe('INVALID_REQUEST');
    markModelCallFailure(withCode);
    expect(classifyTurnFailure(withCode).code).toBe('QUOTA');
    // 包在 MiddlewareError 裡的工具失敗一樣不算。
    expect(classifyTurnFailure(MiddlewareError.wrap(toolError, 'tools')).code).toBe('UNKNOWN');
  });

  it('模型呼叫的 400，說超出上下文（基座認不得的說法）：CONTEXT_WINDOW_EXCEEDED', () => {
    for (const message of [
      'Input is too long for this model.',
      'Your request is too large for the model context window',
      'context_length_exceeded',
    ]) {
      const error = withStatus(400, message);
      markModelCallFailure(error);
      expect(classifyTurnFailure(error)).toMatchObject({
        code: 'CONTEXT_WINDOW_EXCEEDED',
        status: 400,
      });
    }
  });

  it('反例：400 max_tokens must be less than or equal to 16384 不是超窗', () => {
    const error = Object.assign(
      withStatus(400, 'max_tokens must be less than or equal to 16384, but got 99999.'),
      { param: 'max_tokens' },
    );
    markModelCallFailure(error);
    expect(classifyTurnFailure(error).code).toBe('INVALID_REQUEST');
  });

  it('classifyFailedAttempt：措辭說超窗就拋 ContextOverflowError（基座的摘要恢復認得）', () => {
    const error = withStatus(400, 'Input is too long for this model.');
    let thrown: unknown;
    try {
      classifyFailedAttempt(error);
    } catch (caught) {
      thrown = caught;
    }
    expect(ContextOverflowError.isInstance(thrown)).toBe(true);
    expect(classifyTurnFailure(thrown)).toMatchObject({ code: 'CONTEXT_WINDOW_EXCEEDED' });
  });

  it('classifyFailedAttempt：不是超窗的 400、額度的 429 原樣拋，不包成 ContextOverflowError', () => {
    for (const error of [
      withStatus(400, 'max_tokens must be less than or equal to 16384'),
      withStatus(429, quota),
    ]) {
      let thrown: unknown;
      try {
        classifyFailedAttempt(error);
      } catch (caught) {
        thrown = caught;
      }
      expect(thrown).toBe(error);
    }
  });
});

describe('N0479：UNKNOWN 的失敗，turn/failed 帶整條原因鏈', () => {
  const permission = (): Error =>
    Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });

  /** 基座把工具 middleware 的錯一層一層包起來，每層都抄底下那層的 message（實測 14 層）。 */
  const wrapped = (inner: Error, layers = 14): unknown => {
    let current: unknown = inner;
    for (let layer = 0; layer < layers; layer += 1) {
      current = MiddlewareError.wrap(current, 'tools');
    }
    return current;
  };

  it('拆掉 MiddlewareError 再渲染：寫入失敗: EACCES: permission denied，碼是 UNKNOWN', () => {
    const error = wrapped(new Error('寫入失敗', { cause: permission() }));
    const recorded = turnFailureOf(error);
    expect(recorded.message).toBe('寫入失敗: EACCES: permission denied');
    expect(recorded.error).toMatchObject({
      code: 'UNKNOWN',
      message: '寫入失敗: EACCES: permission denied',
    });
  });

  it('cause 的 message getter 會拋錯：那一段是 <unrenderable value>，照樣記得下', () => {
    const cause = new Error('x');
    Object.defineProperty(cause, 'message', {
      get() {
        throw new Error('message 拋錯');
      },
    });
    const recorded = turnFailureOf(wrapped(new Error('外層', { cause })));
    expect(recorded.message).toBe('外層: <unrenderable value>');
  });

  it('不是 UNKNOWN 的碼維持最外層那一句：供應商的原話', () => {
    const error = withStatus(429, '429 Rate limit reached');
    error.cause = new Error('底下還有一層');
    markModelCallFailure(error);
    const recorded = turnFailureOf(error);
    expect(recorded.message).toBe('429 Rate limit reached');
    expect(recorded.error.message).toBe(recorded.message);
  });

  it('message 與 error.message 永遠同一句（含 toString 會拋的值）', () => {
    for (const value of [
      new Error('一般'),
      'string',
      hostile(),
      wrapped(new Error('深', { cause: permission() })),
    ]) {
      const recorded = turnFailureOf(value);
      expect(recorded.error.message).toBe(recorded.message);
    }
  });
});

/**
 * 一顆在模型呼叫之前就拋 `failure` 的 middleware，放進 plugin（middleware 自己的 bug、狀態錯誤那一類：不是供應商的失敗）。
 * 不用 `wrapToolCall`：工具那一層的錯會被圍堵收成工具訊息，到不了 `turn/failed`。
 */
function failingMiddlewarePlugin(failure: () => unknown): PluginEntry {
  const middleware = createMiddleware({
    name: 'FailingMiddleware',
    beforeModel: () => {
      throw failure();
    },
  }) as AgentMiddleware;
  return {
    plugin: {
      name: 'turn-failure-record-probe',
      apply: (registry) => {
        registry.middleware.use(middleware);
      },
    },
  };
}

describe('整條產品路徑（createNexusAgent＋ThreadPump）', () => {
  async function failedEvents(
    plugins: PluginEntry[],
    wrapAgent?: (agent: PumpAgent) => PumpAgent,
  ): Promise<{
    failed: { message: string; error: { code: string; message: string } }[];
    thrown: unknown;
  }> {
    const model = new ScriptedChatModel({
      turns: [{ content: '好' }],
    });
    const built = await createNexusAgent({ model, checkpointer: new MemorySaver(), plugins });
    const agent = built.agent as unknown as PumpAgent;
    const pump = new ThreadPump(
      wrapAgent === undefined ? agent : wrapAgent(agent),
      'turn-failure-record',
    );
    const detach = built.attachSession(pump.sessions);
    let thrown: unknown;
    try {
      await pump.submit({ kind: 'message', text: '做一件事' }).catch((caught: unknown) => {
        thrown = caught;
      });
      const events = [...pump.sessions.root.events] as SessionEvent[];
      return {
        failed: events
          .filter((event) => event.type === 'turn/failed')
          .map((event) => event.data as never),
        thrown,
      };
    } finally {
      detach();
      await built.dispose();
    }
  }

  it('middleware 拋帶 cause 的錯：turn/failed.message 恰好是整條原因鏈，碼是 UNKNOWN', async () => {
    const { failed } = await failedEvents([
      failingMiddlewarePlugin(
        () =>
          new Error('寫入失敗', {
            cause: Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
          }),
      ),
    ]);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.message).toBe('寫入失敗: EACCES: permission denied');
    expect(failed[0]!.error.code).toBe('UNKNOWN');
    expect(failed[0]!.error.message).toBe(failed[0]!.message);
  }, 30_000);

  it('拋出來的值 toString 會拋錯：turn/failed 照樣寫成（UNKNOWN、固定字），不丟出原本的錯誤以外的東西', async () => {
    const value = hostile();
    const { failed, thrown } = await failedEvents([], (agent) => ({
      streamEvents: () => Promise.reject(value),
      getState: (config) => agent.getState(config),
      updateState: (config, values) => agent.updateState(config, values),
    }));
    expect(failed).toHaveLength(1);
    expect(failed[0]!.error.code).toBe('UNKNOWN');
    expect(failed[0]!.message).toBe(LLM_FAILURE_FALLBACK_MESSAGE);
    expect(failed[0]!.error.message).toBe(failed[0]!.message);
    // 原本的值還在往外拋的那顆錯誤的 cause 上。
    expect((thrown as Error).cause).toBe(value);
  }, 30_000);
});

describe('收回那一步（#withdraw）失敗：同一支記法', () => {
  it('停在核准點按停止，收回時 getState 拋出 toString 會拋的值：turn/failed 照樣寫成，兩處同一句', async () => {
    const dangerPlugin: PluginEntry = {
      plugin: {
        name: 'turn-failure-danger',
        apply(registry) {
          registry.tools.register(
            tool(() => '做完了', { name: 'danger', description: '要核准。', schema: z.object({}) }),
          );
          registry.approvals.gate((exec, next) =>
            exec.name === 'danger' ? { kind: 'ask', reason: '危險' } : next(),
          );
        },
      },
    };
    const model = new ScriptedChatModel({
      turns: [{ content: '動手。', toolCalls: [{ name: 'danger', args: {} }] }],
    });
    const built = await createNexusAgent({
      model,
      checkpointer: new MemorySaver(),
      plugins: [dangerPlugin],
    });
    const real = built.agent as unknown as PumpAgent;
    let broken = false;
    const agent: PumpAgent = {
      streamEvents: (input, config) => real.streamEvents(input, config),
      getState: (config) => (broken ? Promise.reject(hostile()) : real.getState(config)),
      updateState: (config, values) => real.updateState(config, values),
    };
    const pump = new ThreadPump(agent, 'turn-failure-withdraw');
    const detach = built.attachSession(pump.sessions);
    try {
      await pump.submit({ kind: 'message', text: '做危險的事' });
      expect(pump.awaitingInput).toBe(true);
      broken = true;
      expect(pump.cancel()).toBe('withdrawn');
      await pump.whenIdle().catch(() => undefined);
      const failed = [...pump.sessions.root.events]
        .filter((event) => event.type === 'turn/failed')
        .map(
          (event) => event.data as { message: string; error: { code: string; message: string } },
        );
      expect(failed).toHaveLength(1);
      expect(failed[0]!.message).toBe(LLM_FAILURE_FALLBACK_MESSAGE);
      expect(failed[0]!.error).toMatchObject({
        code: 'UNKNOWN',
        message: LLM_FAILURE_FALLBACK_MESSAGE,
      });
    } finally {
      detach();
      await built.dispose();
    }
  }, 30_000);
});

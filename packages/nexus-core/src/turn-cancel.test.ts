/**
 * 中止這一輪的兩顆 middleware，直接呼叫鉤子量規則。
 *
 * 掛進真的組裝之後的行為（日誌上的碼、子代理、真的 `ChatOpenAI` 請求被切斷）在 `apps/harness`。
 */

import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { RunnableBinding } from '@langchain/core/runnables';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { Command, isCommand } from '@langchain/langgraph';
import { MiddlewareError } from 'langchain';
import { describe, expect, it } from 'vitest';
import {
  TOOL_ABORTED,
  TOOL_ABORTED_BEFORE_DISPATCH,
  toolErrorOf,
  toolRefusal,
} from './tool-events.js';
import {
  createTurnCancelGuard,
  createTurnCancelModelSignal,
  TOOL_ABORTED_BEFORE_DISPATCH_TEXT,
  TOOL_ABORTED_TEXT,
  TURN_CANCEL_CONFIG_KEY,
  isTurnCancelled,
  TurnCancelledError,
  turnCancelSignalOf,
} from './turn-cancel.js';

type Hook = (request: never, handler: (request: never) => Promise<unknown>) => Promise<unknown>;

function hooksOf(middleware: unknown): { wrapToolCall: Hook; wrapModelCall: Hook } {
  return middleware as { wrapToolCall: Hook; wrapModelCall: Hook };
}

const guard = hooksOf(createTurnCancelGuard());
const modelSignal = hooksOf(createTurnCancelModelSignal());

function runtime(signal?: AbortSignal) {
  return { configurable: signal === undefined ? {} : { [TURN_CANCEL_CONFIG_KEY]: signal } };
}

function toolRequest(signal?: AbortSignal) {
  return {
    toolCall: { id: 'c1', name: 'write_file', args: {} },
    runtime: runtime(signal),
  } as never;
}

function modelRequest(signal?: AbortSignal) {
  return {
    model: new FakeListChatModel({ responses: ['好'] }),
    messages: [],
    runtime: runtime(signal),
  } as never;
}

const success = () =>
  new ToolMessage({ content: '寫好了', tool_call_id: 'c1', name: 'write_file' });

function aborted(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

describe('工具：已經開始的等它落定，還沒開始的不開始', () => {
  it('這一輪沒有人放訊號：原樣交出去', async () => {
    const result = success();
    expect(await guard.wrapToolCall(toolRequest(), async () => result)).toBe(result);
  });

  it('中止之後才輪到的呼叫：本體不跑，回 before dispatch 那一句並標碼', async () => {
    let ran = false;
    const result = (await guard.wrapToolCall(toolRequest(aborted()), async () => {
      ran = true;
      return success();
    })) as ToolMessage;
    expect(ran).toBe(false);
    expect(result).toMatchObject({ content: TOOL_ABORTED_BEFORE_DISPATCH_TEXT, status: 'error' });
    expect(toolErrorOf(result)).toEqual({ name: 'AbortError', code: TOOL_ABORTED_BEFORE_DISPATCH });
  });

  it('跑到一半被中止：等本體跑完，成功的結果換成 ABORTED', async () => {
    const controller = new AbortController();
    let settled = false;
    const pending = guard.wrapToolCall(toolRequest(controller.signal), async () => {
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 20));
      settled = true;
      return success();
    });
    const result = (await pending) as ToolMessage;
    expect(settled).toBe(true);
    expect(result).toMatchObject({ content: TOOL_ABORTED_TEXT, status: 'error' });
    expect(toolErrorOf(result)).toEqual({ name: 'AbortError', code: TOOL_ABORTED });
  });

  it('工具自己回的錯照舊——中止只換成功的結果', async () => {
    const own = toolRefusal('寫不進去', { callId: 'c1', name: 'write_file' });
    const controller = new AbortController();
    const kept = await guard.wrapToolCall(toolRequest(controller.signal), async () => {
      controller.abort();
      return own;
    });
    expect(kept).toBe(own);
  });

  /**
   * **這條是翻面寫的。** 它原本釘「回 `Command` 的整個不換」，而那讓 `task`（它回的就是 `Command`）
   * 被中止之後在日誌上記成成功。翻成「狀態更新留著、只換屬於這次呼叫的那一則」。
   */
  it('回 Command 的：狀態更新原樣留著，只把屬於這次呼叫的那則換成 ABORTED', async () => {
    const controller = new AbortController();
    const other = new ToolMessage({ content: '別人的', tool_call_id: 'c9', name: 'other' });
    const command = new Command({ update: { messages: [other, success()], todos: ['保留'] } });
    const result = await guard.wrapToolCall(toolRequest(controller.signal), async () => {
      controller.abort();
      return command;
    });
    expect(isCommand(result)).toBe(true);
    const update = (result as Command).update as { messages: ToolMessage[]; todos: string[] };
    expect(update.todos).toEqual(['保留']);
    expect(update.messages[0]).toBe(other);
    expect(update.messages[1]).toMatchObject({ content: TOOL_ABORTED_TEXT, status: 'error' });
    expect(toolErrorOf(update.messages[1])).toEqual({ name: 'AbortError', code: TOOL_ABORTED });
  });

  it('沒中止時 Command 原樣交出去', async () => {
    const command = new Command({ update: { messages: [success()] } });
    const kept = await guard.wrapToolCall(
      toolRequest(new AbortController().signal),
      async () => command,
    );
    expect(kept).toBe(command);
  });

  it('子代理被同一個訊號停下而拋的那一顆：`task` 的結果是 ABORTED', async () => {
    const controller = new AbortController();
    const result = (await guard.wrapToolCall(toolRequest(controller.signal), async () => {
      controller.abort();
      throw new TurnCancelledError();
    })) as ToolMessage;
    expect(toolErrorOf(result)).toEqual({ name: 'AbortError', code: TOOL_ABORTED });
  });

  it('其餘的拋錯照拋，讓圍堵照它的規則分類', async () => {
    const controller = new AbortController();
    const boom = new Error('磁碟滿了');
    await expect(
      guard.wrapToolCall(toolRequest(controller.signal), async () => {
        controller.abort();
        throw boom;
      }),
    ).rejects.toBe(boom);
  });
});

describe('模型：中止之後不再叫，叫到一半的切斷', () => {
  it('外層那顆：中止之後的呼叫當場拋 TurnCancelledError，不叫模型', async () => {
    let called = false;
    await expect(
      guard.wrapModelCall(modelRequest(aborted()), async () => {
        called = true;
        return undefined;
      }),
    ).rejects.toBeInstanceOf(TurnCancelledError);
    expect(called).toBe(false);
  });

  it('外層那顆不碰模型：沒中止時交出去的是同一份 request', async () => {
    const request = modelRequest(new AbortController().signal);
    let seen: unknown;
    await guard.wrapModelCall(request, async (next) => {
      seen = next;
      return undefined;
    });
    expect(seen).toBe(request);
  });

  it('內層那顆把訊號綁在核心的 RunnableBinding 上，不走 withConfig', async () => {
    const signal = new AbortController().signal;
    const request = modelRequest(signal) as { model: unknown };
    let seen: { model: unknown } | undefined;
    await modelSignal.wrapModelCall(request as never, async (next) => {
      seen = next as { model: unknown };
      return undefined;
    });
    expect(RunnableBinding.isRunnableBinding(seen?.model)).toBe(true);
    const binding = seen?.model as RunnableBinding<unknown, unknown>;
    expect(binding.config.signal).toBe(signal);
    expect(binding.bound).toBe(request.model);
  });

  it('被切斷的那次換成 TurnCancelledError，原因留在 cause', async () => {
    const controller = new AbortController();
    const cut = new Error('AbortError');
    const thrown = await modelSignal
      .wrapModelCall(modelRequest(controller.signal), async () => {
        controller.abort();
        throw cut;
      })
      .catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(TurnCancelledError);
    expect((thrown as Error).cause).toBe(cut);
  });

  it('沒中止時模型自己的錯照拋——不能把失敗記成中止', async () => {
    const boom = new Error('429');
    await expect(
      modelSignal.wrapModelCall(modelRequest(new AbortController().signal), async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });

  it('這一輪沒有人放訊號：原樣交出去', async () => {
    const request = modelRequest();
    let seen: unknown;
    await modelSignal.wrapModelCall(request, async (next) => {
      seen = next;
      return undefined;
    });
    expect(seen).toBe(request);
  });
});

describe('子代理那一層不拋，正常收尾', () => {
  /** 子代理的模型呼叫：`checkpoint_ns` 兩段，同 `session-address.ts` 的判準。 */
  function subagentModelRequest(signal: AbortSignal) {
    return {
      model: new FakeListChatModel({ responses: ['好'] }),
      messages: [],
      runtime: {
        configurable: {
          [TURN_CANCEL_CONFIG_KEY]: signal,
          checkpoint_ns: 'tools:abc|model_request:def',
        },
      },
    } as never;
  }

  it('外層那顆：中止之後子代理的下一次呼叫回一則空的 AI 訊息，不拋也不叫模型', async () => {
    let called = false;
    const result = await guard.wrapModelCall(subagentModelRequest(aborted()), async () => {
      called = true;
      return undefined;
    });
    expect(called).toBe(false);
    expect(AIMessage.isInstance(result)).toBe(true);
    expect((result as AIMessage).tool_calls ?? []).toEqual([]);
  });

  it('內層那顆：子代理的模型請求被切斷，同樣回空訊息收尾', async () => {
    const controller = new AbortController();
    const result = await modelSignal.wrapModelCall(
      subagentModelRequest(controller.signal),
      async () => {
        controller.abort();
        throw new Error('AbortError');
      },
    );
    expect(AIMessage.isInstance(result)).toBe(true);
  });

  it('對照：root 那一層照樣拋——進入點要靠它收成中止', async () => {
    const root = {
      model: new FakeListChatModel({ responses: ['好'] }),
      messages: [],
      runtime: {
        configurable: { [TURN_CANCEL_CONFIG_KEY]: aborted(), checkpoint_ns: 'model_request:def' },
      },
    } as never;
    await expect(guard.wrapModelCall(root, async () => undefined)).rejects.toBeInstanceOf(
      TurnCancelledError,
    );
  });
});

describe('isTurnCancelled', () => {
  it('沿 MiddlewareError 拆到底再認——基座每經過一層可能包一層', () => {
    const cancelled = new TurnCancelledError();
    expect(isTurnCancelled(cancelled)).toBe(true);
    expect(isTurnCancelled(MiddlewareError.wrap(cancelled, 'nexusTurnCancel'))).toBe(true);
    expect(
      isTurnCancelled(MiddlewareError.wrap(MiddlewareError.wrap(cancelled, 'inner'), 'outer')),
    ).toBe(true);
  });

  it('其餘的錯不是中止，包了幾層都一樣；也不比對訊息', () => {
    expect(isTurnCancelled(MiddlewareError.wrap(new Error('429'), 'nexusTurnCancel'))).toBe(false);
    expect(isTurnCancelled(new Error('這一輪被中止了'))).toBe(false);
    expect(isTurnCancelled(undefined)).toBe(false);
  });
});

describe('turnCancelSignalOf', () => {
  it('只認 AbortSignal，別的東西放在那個鍵上當作沒有', () => {
    const signal = new AbortController().signal;
    expect(turnCancelSignalOf({ configurable: { [TURN_CANCEL_CONFIG_KEY]: signal } })).toBe(signal);
    expect(
      turnCancelSignalOf({ configurable: { [TURN_CANCEL_CONFIG_KEY]: true } }),
    ).toBeUndefined();
    expect(turnCancelSignalOf(undefined)).toBeUndefined();
  });
});

/**
 * 工具事件的生產者（[#1248](https://github.com/DemianLi/nexus-agent/issues/1248)，S1a）：直接餵假的 `handler`，看三顆
 * middleware 與圍堵的 `tools/result` 把什麼交回來、派發了什麼。
 *
 * **最重的一條是「沒人聽就跟不存在一樣」**：每顆生產者在沒有監聽者、或監聽者放行時，交回的是 handler 原本回的**同一個物件**
 * （`toBe`），而且掛在物件上的錯誤碼還在——碼住在以訊息物件為鍵的 `WeakMap` 上，複製就斷（`tool-events.ts` 檔頭）。
 *
 * 掛進產品組裝之後的位置（pre 在閘門外側、post 在輸出校驗外側、execute 在最內層）由 `fold.test.ts` 釘；
 * 組裝之後模型收到的訊息逐位元組不變由 `apps/harness/src/tool-pipeline-product.test.ts` 量。
 */

import { HumanMessage, ToolMessage } from '@langchain/core/messages';
import { Command, GraphInterrupt } from '@langchain/langgraph';
import { describe, expect, it, vi } from 'vitest';
import { createContainmentMiddleware } from './containment.js';
import { EventBus } from './events.js';
import { SessionLog } from './session-log.js';
import { FS_SANDBOX_DENIED } from './fs-tool-errors.js';
import { TOOL_ABORTED, TOOL_TIMEOUT } from './tool-error-codes.js';
import { markToolError, toolErrorOf, UNKNOWN_TOOL } from './tool-events.js';
import {
  createToolExecuteMiddleware,
  createToolPostExecuteMiddleware,
  createToolPreExecuteMiddleware,
  pipelineTextOf,
  toolResultView,
} from './tool-pipeline.js';
import type { PipelineExecution, PipelineResult } from './tool-pipeline.js';
import { TurnCancelledError } from './turn-cancel.js';

type Handler = (request: unknown) => Promise<unknown>;
type Wrapper = (request: unknown, handler: Handler) => Promise<unknown>;

function wrapperOf(middleware: unknown): Wrapper {
  const wrap = (middleware as { wrapToolCall?: Wrapper }).wrapToolCall;
  if (wrap === undefined) throw new Error('這個 middleware 沒有 wrapToolCall');
  return wrap;
}

/** 一次工具呼叫的假請求；`namespace` 決定呼叫者身分（`checkpoint_ns`）。 */
function requestFor(
  options: { namespace?: string | null; id?: string | null; signal?: AbortSignal } = {},
): unknown {
  const namespace = options.namespace === undefined ? 'tools:x' : options.namespace;
  const configurable = namespace === null ? {} : { configurable: { checkpoint_ns: namespace } };
  return {
    toolCall: {
      name: 'probe',
      args: { path: '/a' },
      ...(options.id === null ? {} : { id: options.id ?? 'call-1' }),
    },
    tool: { name: 'probe' },
    state: {},
    runtime: { ...configurable, ...(options.signal !== undefined && { signal: options.signal }) },
  };
}

/** 有碼的錯誤訊息：`handler` 會回它，檢查碼有沒有跟著走過每一層。 */
function codedError(): ToolMessage {
  return markToolError(
    new ToolMessage({ content: '沒這顆', tool_call_id: 'call-1', name: 'probe', status: 'error' }),
    { name: 'ToolNotFoundError', code: UNKNOWN_TOOL },
  );
}

describe('tools/pre-execute 的生產者', () => {
  it('沒有監聽者 → 直通，handler 回的原物件、碼還在', async () => {
    const wrap = wrapperOf(createToolPreExecuteMiddleware(new EventBus()));
    const message = codedError();
    expect(await wrap(requestFor(), async () => message)).toBe(message);
    expect(toolErrorOf(message)?.code).toBe(UNKNOWN_TOOL);
  });

  it('`next()` 放行 → handler 照跑，結果原物件', async () => {
    const bus = new EventBus();
    bus.on('tools/pre-execute', (_exec, next) => next());
    const wrap = wrapperOf(createToolPreExecuteMiddleware(bus));
    const message = codedError();
    expect(await wrap(requestFor(), async () => message)).toBe(message);
    expect(toolErrorOf(message)?.code).toBe(UNKNOWN_TOOL);
  });

  it('拒絕 → handler 不跑，模型收到 `Error: <reason>`，tool_call_id 與工具名對得上', async () => {
    const bus = new EventBus();
    bus.on('tools/pre-execute', () => Promise.resolve({ kind: 'deny', reason: '現在不能用' }));
    const wrap = wrapperOf(createToolPreExecuteMiddleware(bus));
    const handler = vi.fn(async () => new ToolMessage({ content: '跑了', tool_call_id: 'call-1' }));
    const result = (await wrap(requestFor(), handler)) as ToolMessage;
    expect(handler).not.toHaveBeenCalled();
    expect(ToolMessage.isInstance(result)).toBe(true);
    expect(result.status).toBe('error');
    expect(result.content).toBe('Error: 現在不能用');
    expect(result.tool_call_id).toBe('call-1');
    expect(result.name).toBe('probe');
  });

  it('waterfall：由外而內，外面不呼叫 `next()` 就短路後面', async () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.on('tools/pre-execute', async (_exec, next) => {
      seen.push('外');
      return next();
    });
    bus.on('tools/pre-execute', () => {
      seen.push('中（否決）');
      return Promise.resolve({ kind: 'deny', reason: '中間擋下' });
    });
    bus.on('tools/pre-execute', (_exec, next) => {
      seen.push('內（不該到）');
      return next();
    });
    const wrap = wrapperOf(createToolPreExecuteMiddleware(bus));
    const result = (await wrap(requestFor(), async () => 'x')) as ToolMessage;
    expect(seen).toEqual(['外', '中（否決）']);
    expect(result.content).toBe('Error: 中間擋下');
  });

  it('監聽者回了不認得的決定 → 拋 TypeError（交給外面的圍堵翻成訊息），不放行', async () => {
    const bus = new EventBus();
    bus.on('tools/pre-execute', (() => Promise.resolve({ kind: 'maybe' })) as unknown as Parameters<
      typeof bus.on<'tools/pre-execute'>
    >[1]);
    const wrap = wrapperOf(createToolPreExecuteMiddleware(bus));
    const handler = vi.fn(async () => 'x');
    await expect(wrap(requestFor(), handler)).rejects.toBeInstanceOf(TypeError);
    expect(handler).not.toHaveBeenCalled();
  });

  it('`ask` 型別上就不存在、執行時也不放行（核准還沒搬上來）', async () => {
    const bus = new EventBus();
    bus.on('tools/pre-execute', (() => Promise.resolve({ kind: 'ask' })) as unknown as Parameters<
      typeof bus.on<'tools/pre-execute'>
    >[1]);
    const wrap = wrapperOf(createToolPreExecuteMiddleware(bus));
    const handler = vi.fn(async () => 'x');
    await expect(wrap(requestFor(), handler)).rejects.toBeInstanceOf(TypeError);
    expect(handler).not.toHaveBeenCalled();
  });

  it('`exec` 帶名字、參數、callId 與呼叫者身分，而且是凍結的', async () => {
    const bus = new EventBus();
    const execs: PipelineExecution[] = [];
    bus.on('tools/pre-execute', (exec, next) => {
      execs.push(exec);
      return next();
    });
    const wrap = wrapperOf(createToolPreExecuteMiddleware(bus));
    await wrap(requestFor({ namespace: 'tools:t1' }), async () => 'x');
    await wrap(requestFor({ namespace: 'tools:t1|tools:t2' }), async () => 'x');
    await wrap(requestFor({ namespace: null }), async () => 'x');
    await wrap(requestFor({ id: null }), async () => 'x');
    expect(execs.map((exec) => exec.agent)).toEqual([
      { kind: 'root' },
      { kind: 'subagent', runId: 'tools:t1' },
      undefined,
      { kind: 'root' },
    ]);
    expect(execs[0]).toMatchObject({ callId: 'call-1', name: 'probe', args: { path: '/a' } });
    expect(execs[3]?.callId).toBe('');
    expect(Object.isFrozen(execs[0])).toBe(true);
  });

  it('`exec.signal` 是這次呼叫的那一支，唯讀；沒有就是 undefined', async () => {
    const bus = new EventBus();
    const execs: PipelineExecution[] = [];
    bus.on('tools/pre-execute', (exec, next) => {
      execs.push(exec);
      return next();
    });
    const wrap = wrapperOf(createToolPreExecuteMiddleware(bus));
    const controller = new AbortController();
    await wrap(requestFor({ signal: controller.signal }), async () => 'x');
    await wrap(requestFor(), async () => 'x');
    expect(execs[0]?.signal).toBe(controller.signal);
    expect(execs[1]?.signal).toBeUndefined();
    expect(() => {
      (execs[0] as { signal: unknown }).signal = undefined;
    }).toThrow(TypeError);
  });

  it('拒絕帶 `error` → 那則訊息掛它的碼；`error` 形狀不對 → 拋 TypeError', async () => {
    const bus = new EventBus();
    let error: unknown = { name: 'PolicyDenied', code: FS_SANDBOX_DENIED };
    bus.on('tools/pre-execute', () =>
      Promise.resolve({ kind: 'deny', reason: '不准', error } as never),
    );
    const wrap = wrapperOf(createToolPreExecuteMiddleware(bus));
    const refused = (await wrap(requestFor(), async () => 'x')) as ToolMessage;
    expect(refused.content).toBe('Error: 不准');
    expect(toolErrorOf(refused)).toEqual({ name: 'PolicyDenied', code: FS_SANDBOX_DENIED });
    error = { name: 'PolicyDenied' };
    await expect(wrap(requestFor(), async () => 'x')).rejects.toBeInstanceOf(TypeError);
  });

  it('`exec.args` 是深凍結的複本：監聽者改不動，handler 收到的參數不變', async () => {
    const bus = new EventBus();
    let attempted: unknown;
    bus.on('tools/pre-execute', (exec, next) => {
      const args = exec.args as { path: string; nested: { n: number } };
      try {
        args.path = '被改了';
        attempted = 'no-throw';
      } catch (error) {
        attempted = error;
      }
      expect(() => {
        args.nested.n = 2;
      }).toThrow(TypeError);
      expect(Object.isFrozen(args)).toBe(true);
      expect(Object.isFrozen(args.nested)).toBe(true);
      return next();
    });
    const wrap = wrapperOf(createToolPreExecuteMiddleware(bus));
    const request = requestFor() as {
      toolCall: { args: { path: string; nested?: { n: number } } };
    };
    request.toolCall.args = { path: '/a', nested: { n: 1 } };
    let received: unknown;
    await wrap(request, async (inner) => {
      received = (inner as typeof request).toolCall.args;
      return 'x';
    });
    expect(attempted).toBeInstanceOf(TypeError);
    // 複本不是原物件，原物件沒被凍、沒被改。
    expect(received).toBe(request.toolCall.args);
    expect(received).toEqual({ path: '/a', nested: { n: 1 } });
    expect(Object.isFrozen(received)).toBe(false);
  });

  it('核准的中斷穿過去：handler 拋 GraphInterrupt，不被吞', async () => {
    const bus = new EventBus();
    bus.on('tools/pre-execute', (_exec, next) => next());
    const wrap = wrapperOf(createToolPreExecuteMiddleware(bus));
    const interrupt = new GraphInterrupt([{ value: '要不要？' } as never]);
    await expect(
      wrap(requestFor(), async () => {
        throw interrupt;
      }),
    ).rejects.toBe(interrupt);
  });

  it('resume 重進同一個 callId → 監聽者再跑一次（已知差異，監聽者必須冪等）', async () => {
    const bus = new EventBus();
    const calls: string[] = [];
    bus.on('tools/pre-execute', (exec, next) => {
      calls.push(exec.callId);
      return next();
    });
    const wrap = wrapperOf(createToolPreExecuteMiddleware(bus));
    await wrap(requestFor(), async () => 'x');
    await wrap(requestFor(), async () => 'x');
    expect(calls).toEqual(['call-1', 'call-1']);
  });
});

describe('tools/execute 的生產者', () => {
  it('沒有監聽者 → 直通，原物件、碼還在', async () => {
    const wrap = wrapperOf(createToolExecuteMiddleware(new EventBus()));
    const message = codedError();
    expect(await wrap(requestFor(), async () => message)).toBe(message);
  });

  it('監聽者原樣回 `next()` → handler 回的原物件，不是重建的；碼還在', async () => {
    const bus = new EventBus();
    const views: PipelineResult[] = [];
    bus.on('tools/execute', async (_exec, next) => {
      const view = await next();
      views.push(view);
      return view;
    });
    const wrap = wrapperOf(createToolExecuteMiddleware(bus));
    const message = codedError();
    expect(await wrap(requestFor(), async () => message)).toBe(message);
    expect(toolErrorOf(message)?.code).toBe(UNKNOWN_TOOL);
    expect(views).toEqual([
      {
        kind: 'message',
        blocks: [{ type: 'text', text: '沒這顆' }],
        content: '沒這顆',
        isError: true,
        error: { name: 'ToolNotFoundError', code: UNKNOWN_TOOL },
      },
    ]);
    expect(Object.isFrozen(views[0])).toBe(true);
  });

  it('監聽者能計時：看得到本體跑完之後的結果；`Command` 也交回原物件', async () => {
    const bus = new EventBus();
    const kinds: string[] = [];
    bus.on('tools/execute', async (_exec, next) => {
      const view = await next();
      kinds.push(view.kind);
      return view;
    });
    const wrap = wrapperOf(createToolExecuteMiddleware(bus));
    const command = new Command({
      update: { messages: [new ToolMessage({ content: '好', tool_call_id: 'call-1' })] },
    });
    expect(await wrap(requestFor(), async () => command)).toBe(command);
    expect(kinds).toEqual(['command']);
  });

  it('短路：不呼叫 `next()`、回自己的結果 → 本體不跑，模型收到那一句', async () => {
    const bus = new EventBus();
    bus.on('tools/execute', () =>
      Promise.resolve({ kind: 'message', content: '快取的', isError: false }),
    );
    const wrap = wrapperOf(createToolExecuteMiddleware(bus));
    const handler = vi.fn(async () => new ToolMessage({ content: '真的', tool_call_id: 'call-1' }));
    const result = (await wrap(requestFor(), handler)) as ToolMessage;
    expect(handler).not.toHaveBeenCalled();
    expect(result.content).toBe('快取的');
    expect(result.tool_call_id).toBe('call-1');
    expect(result.name).toBe('probe');
    expect(result.status).toBe('success');
  });

  it('叫了 `next()` 又交回別的訊息結果 → 從本體那則造：只換內容與狀態，其餘沿用', async () => {
    const bus = new EventBus();
    bus.on('tools/execute', async (_exec, next) => {
      await next();
      return { kind: 'message', content: '換過的', isError: false };
    });
    const wrap = wrapperOf(createToolExecuteMiddleware(bus));
    const original = markToolError(
      new ToolMessage({
        content: '原本的',
        tool_call_id: 'call-1',
        name: 'probe',
        status: 'error',
        artifact: { n: 1 },
        id: 'msg-1',
        additional_kwargs: { mark: true },
      }),
      { name: 'FsSandboxDenied', code: FS_SANDBOX_DENIED },
    );
    const result = (await wrap(requestFor(), async () => original)) as ToolMessage;
    expect(result).not.toBe(original);
    expect(result.content).toBe('換過的');
    expect(result.status).toBe('success');
    expect(toolErrorOf(result)).toBeUndefined();
    expect([result.tool_call_id, result.name, result.id]).toEqual(['call-1', 'probe', 'msg-1']);
    expect(result.artifact).toEqual({ n: 1 });
    expect(result.additional_kwargs).toEqual({ mark: true });
  });

  it('短路交回 `blocks` → 訊息內容是那串區塊；`content` 與 `blocks` 都在時以 `blocks` 為準', async () => {
    const bus = new EventBus();
    const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } };
    bus.on('tools/execute', () =>
      Promise.resolve({
        kind: 'message',
        blocks: [{ type: 'text', text: '區塊' }, image],
        content: '字串',
        isError: false,
      } as never),
    );
    const wrap = wrapperOf(createToolExecuteMiddleware(bus));
    const result = (await wrap(requestFor(), async () => 'x')) as ToolMessage;
    expect(result.content).toEqual([{ type: 'text', text: '區塊' }, image]);
    expect(result.text).toBe('區塊');
  });

  it('短路回 `command` 結果 → 拋 TypeError，訊息說工具本體沒有跑', async () => {
    const bus = new EventBus();
    bus.on('tools/execute', () => Promise.resolve({ kind: 'command', isError: false }));
    const wrap = wrapperOf(createToolExecuteMiddleware(bus));
    const handler = vi.fn(async () => 'x');
    const failure = wrap(requestFor(), handler);
    await expect(failure).rejects.toBeInstanceOf(TypeError);
    await expect(failure).rejects.toThrow(
      'tools/execute 的監聽者回了 command 結果，但工具本體沒有跑：Command 造不出來（偏離 2）',
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it('兩位監聽者：外層叫了 `next()`、內層短路，外層交回 `command` 結果 → 訊息說工具本體沒有跑', async () => {
    const bus = new EventBus();
    const order: string[] = [];
    bus.on('tools/execute', async (_exec, next) => {
      order.push('外層');
      await next();
      return { kind: 'command', isError: false };
    });
    bus.on('tools/execute', () => {
      order.push('內層');
      return Promise.resolve({ kind: 'message', content: '快取的', isError: false });
    });
    const wrap = wrapperOf(createToolExecuteMiddleware(bus));
    const handler = vi.fn(async () => 'x');
    const failure = wrap(requestFor(), handler);
    await expect(failure).rejects.toThrow(
      'tools/execute 的監聽者回了 command 結果，但工具本體沒有跑：Command 造不出來（偏離 2）',
    );
    expect(order).toEqual(['外層', '內層']);
    expect(handler).not.toHaveBeenCalled();
  });

  it('叫了 `next()`、本體回 `Command`，卻交回另造的 `command` 結果 → 拋 TypeError，訊息說不是 next() 回的那一個', async () => {
    const bus = new EventBus();
    bus.on('tools/execute', async (_exec, next) => {
      const view = await next();
      return { ...view };
    });
    const wrap = wrapperOf(createToolExecuteMiddleware(bus));
    const command = new Command({
      update: { messages: [new ToolMessage({ content: '好', tool_call_id: 'call-1' })] },
    });
    const failure = wrap(requestFor(), async () => command);
    await expect(failure).rejects.toBeInstanceOf(TypeError);
    await expect(failure).rejects.toThrow(
      'tools/execute 的監聽者交回的 command 結果不是 next() 回的那一個：Command 造不出來（偏離 2）',
    );
  });

  it('叫了 `next()`、本體回 `ToolMessage`，卻交回 `command` 結果 → 拋 TypeError，訊息說不是 next() 回的那一個', async () => {
    const bus = new EventBus();
    bus.on('tools/execute', async (_exec, next) => {
      await next();
      return { kind: 'command', isError: false };
    });
    const wrap = wrapperOf(createToolExecuteMiddleware(bus));
    const handler = vi.fn(async () => new ToolMessage({ content: '真的', tool_call_id: 'call-1' }));
    const failure = wrap(requestFor(), handler);
    await expect(failure).rejects.toThrow(
      'tools/execute 的監聽者交回的 command 結果不是 next() 回的那一個：Command 造不出來（偏離 2）',
    );
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('本體拋錯 → 原樣往外拋（翻成訊息是圍堵的事）', async () => {
    const bus = new EventBus();
    bus.on('tools/execute', (_exec, next) => next());
    const wrap = wrapperOf(createToolExecuteMiddleware(bus));
    const boom = new Error('壞了');
    await expect(
      wrap(requestFor(), async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });
});

describe('tools/post-execute 的生產者', () => {
  it('沒有監聽者 → 直通，原物件、碼還在', async () => {
    const wrap = wrapperOf(createToolPostExecuteMiddleware(new EventBus()));
    const message = codedError();
    expect(await wrap(requestFor(), async () => message)).toBe(message);
    expect(toolErrorOf(message)?.code).toBe(UNKNOWN_TOOL);
  });

  it('接受（`next()`）→ 原物件，碼還在；監聽者看到結果的視圖', async () => {
    const bus = new EventBus();
    const views: PipelineResult[] = [];
    bus.on('tools/post-execute', (_exec, result, next) => {
      views.push(result);
      return next();
    });
    const wrap = wrapperOf(createToolPostExecuteMiddleware(bus));
    const message = codedError();
    expect(await wrap(requestFor(), async () => message)).toBe(message);
    expect(toolErrorOf(message)?.code).toBe(UNKNOWN_TOOL);
    expect(views[0]).toMatchObject({ kind: 'message', content: '沒這顆', isError: true });
  });

  it('替換 → 新訊息，文字換掉，tool_call_id／name／status／artifact／id／錯誤碼沿用', async () => {
    const bus = new EventBus();
    bus.on('tools/post-execute', () => Promise.resolve({ kind: 'replace', content: '改過的' }));
    const wrap = wrapperOf(createToolPostExecuteMiddleware(bus));
    const original = markToolError(
      new ToolMessage({
        content: '原本的',
        tool_call_id: 'call-1',
        name: 'probe',
        status: 'error',
        artifact: { n: 1 },
        id: 'msg-1',
      }),
      { name: 'FsSandboxDenied', code: FS_SANDBOX_DENIED },
    );
    const result = (await wrap(requestFor(), async () => original)) as ToolMessage;
    expect(result).not.toBe(original);
    expect(result.content).toBe('改過的');
    expect(result.tool_call_id).toBe('call-1');
    expect(result.name).toBe('probe');
    expect(result.status).toBe('error');
    expect(result.artifact).toEqual({ n: 1 });
    expect(result.id).toBe('msg-1');
    expect(toolErrorOf(result)).toEqual({ name: 'FsSandboxDenied', code: FS_SANDBOX_DENIED });
    // 原本那則沒被動到。
    expect(original.content).toBe('原本的');
  });

  it('替換也沿用 `additional_kwargs`', async () => {
    const bus = new EventBus();
    bus.on('tools/post-execute', () => Promise.resolve({ kind: 'replace', content: '改過的' }));
    const wrap = wrapperOf(createToolPostExecuteMiddleware(bus));
    const original = new ToolMessage({
      content: '原本的',
      tool_call_id: 'call-1',
      additional_kwargs: { mark: true },
    });
    const result = (await wrap(requestFor(), async () => original)) as ToolMessage;
    expect(result.additional_kwargs).toEqual({ mark: true });
  });

  it('以 `blocks` 替換 → 訊息內容是那串區塊（可改的複本）；`content` 與 `blocks` 都給或都不給 → 拋 TypeError', async () => {
    const bus = new EventBus();
    let decision: unknown = {
      kind: 'replace',
      blocks: Object.freeze([Object.freeze({ type: 'text', text: '新' })]),
    };
    bus.on('tools/post-execute', () => Promise.resolve(decision as never));
    const wrap = wrapperOf(createToolPostExecuteMiddleware(bus));
    const call = () =>
      wrap(requestFor(), async () => new ToolMessage({ content: '舊', tool_call_id: 'call-1' }));
    const result = (await call()) as ToolMessage;
    expect(result.content).toEqual([{ type: 'text', text: '新' }]);
    expect(Object.isFrozen((result.content as unknown[])[0])).toBe(false);
    decision = { kind: 'replace', blocks: [{ type: 'text', text: '新' }], content: '新' };
    await expect(call()).rejects.toBeInstanceOf(TypeError);
    decision = { kind: 'replace' };
    await expect(call()).rejects.toBeInstanceOf(TypeError);
  });

  it('`Command` 結果不派發（偏離 2）→ 原物件，監聽者沒被叫', async () => {
    const bus = new EventBus();
    const listener = vi.fn((_exec: unknown, _result: unknown, next: () => Promise<unknown>) =>
      next(),
    );
    bus.on('tools/post-execute', listener as never);
    const wrap = wrapperOf(createToolPostExecuteMiddleware(bus));
    const command = new Command({
      update: { messages: [new HumanMessage('插進來的')] },
    });
    expect(await wrap(requestFor(), async () => command)).toBe(command);
    expect(listener).not.toHaveBeenCalled();
  });

  it('本體拋錯、沒有監聽者 → 同一個錯原樣往外拋', async () => {
    const wrap = wrapperOf(createToolPostExecuteMiddleware(new EventBus()));
    const boom = new Error('壞了');
    await expect(
      wrap(requestFor(), async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });

  it('本體拋錯、監聽者接受 → 看到圍堵會翻的那則錯誤訊息；再拋的是同一個錯物件（偏離 3）', async () => {
    const bus = new EventBus();
    const views: PipelineResult[] = [];
    bus.on('tools/post-execute', (_exec, result, next) => {
      views.push(result);
      return next();
    });
    const wrap = wrapperOf(createToolPostExecuteMiddleware(bus));
    const boom = new Error('壞了');
    await expect(
      wrap(requestFor(), async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(views).toEqual([
      {
        kind: 'message',
        blocks: [{ type: 'text', text: 'Error: 工具 probe 執行失敗：壞了' }],
        content: 'Error: 工具 probe 執行失敗：壞了',
        isError: true,
      },
    ]);
  });

  it('本體拋錯、監聽者替換 → 回替換過的那則：status 是 error，碼照拋的錯分類', async () => {
    const bus = new EventBus();
    bus.on('tools/post-execute', () => Promise.resolve({ kind: 'replace', content: '補了上下文' }));
    const wrap = wrapperOf(createToolPostExecuteMiddleware(bus));
    const aborted = Object.assign(new Error('停了'), { name: 'AbortError' });
    const result = (await wrap(requestFor(), async () => {
      throw aborted;
    })) as ToolMessage;
    expect(ToolMessage.isInstance(result)).toBe(true);
    expect(result.content).toBe('補了上下文');
    expect([result.tool_call_id, result.name, result.status]).toEqual(['call-1', 'probe', 'error']);
    expect(toolErrorOf(result)).toEqual({ name: 'AbortError', code: TOOL_ABORTED });
  });

  it('逾時 → 監聽者看到逾時那句與 TOOL_TIMEOUT 的碼', async () => {
    const bus = new EventBus();
    const views: PipelineResult[] = [];
    bus.on('tools/post-execute', (_exec, result, next) => {
      views.push(result);
      return next();
    });
    const wrap = wrapperOf(createToolPostExecuteMiddleware(bus));
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), {
      name: 'TimeoutError',
    });
    await expect(
      wrap(requestFor(), async () => {
        throw timeout;
      }),
    ).rejects.toBe(timeout);
    expect(views[0]).toMatchObject({ isError: true, error: { code: TOOL_TIMEOUT } });
    expect((views[0] as { content: string }).content).toMatch(
      /^Error: 工具 probe 超時：等了 \d+ms。$/,
    );
  });

  it.each([
    ['核准的中斷（GraphInterrupt）', () => new GraphInterrupt()],
    ['這一輪被中止（TurnCancelledError）', () => new TurnCancelledError()],
  ])('本體拋 %s → 同一個錯原樣往外拋，監聽者沒被叫', async (_label, make) => {
    const bus = new EventBus();
    const listener = vi.fn();
    bus.on('tools/post-execute', listener as never);
    const wrap = wrapperOf(createToolPostExecuteMiddleware(bus));
    const thrown = make();
    await expect(
      wrap(requestFor(), async () => {
        throw thrown;
      }),
    ).rejects.toBe(thrown);
    expect(listener).not.toHaveBeenCalled();
  });

  it('經圍堵：接受 → 模型收到圍堵翻的那則；替換 → 收到替換過的那則，`tool/result` 記它的碼', async () => {
    const bus = new EventBus();
    let replace = false;
    bus.on('tools/post-execute', (_exec, _result, next) =>
      replace ? Promise.resolve({ kind: 'replace', content: '換掉了' }) : next(),
    );
    const post = wrapperOf(createToolPostExecuteMiddleware(bus));
    const contain = wrapperOf(createContainmentMiddleware());
    const aborted = Object.assign(new Error('停了'), { name: 'AbortError' });
    const run = () =>
      contain(requestFor(), (request) =>
        post(request, async () => {
          throw aborted;
        }),
      ) as Promise<ToolMessage>;
    const accepted = await run();
    expect(accepted.content).toBe('Error: 工具 probe 執行失敗：停了');
    replace = true;
    const replaced = await run();
    expect(replaced.content).toBe('換掉了');
    expect(toolErrorOf(replaced)).toEqual({ name: 'AbortError', code: TOOL_ABORTED });
  });

  it('回了不認得的決定 → 拋 TypeError', async () => {
    const bus = new EventBus();
    bus.on('tools/post-execute', (() =>
      Promise.resolve({ kind: 'block' })) as unknown as Parameters<
      typeof bus.on<'tools/post-execute'>
    >[1]);
    const wrap = wrapperOf(createToolPostExecuteMiddleware(bus));
    await expect(
      wrap(requestFor(), async () => new ToolMessage({ content: 'x', tool_call_id: 'call-1' })),
    ).rejects.toBeInstanceOf(TypeError);
  });
});

describe('tools/result（圍堵派發）', () => {
  function containment(
    bus: EventBus,
    log?: SessionLog,
    report?: (message: string) => void,
  ): Wrapper {
    return wrapperOf(
      createContainmentMiddleware(
        log === undefined
          ? undefined
          : { forCall: () => ({ kind: 'ok', address: { kind: 'root' }, log }) },
        bus,
        report,
      ),
    );
  }

  it('沒有監聽者 / 沒給 events → 結果原物件', async () => {
    const message = codedError();
    expect(await containment(new EventBus())(requestFor(), async () => message)).toBe(message);
    const bare = wrapperOf(createContainmentMiddleware());
    expect(await bare(requestFor(), async () => message)).toBe(message);
  });

  it('成功、錯誤訊息、拋錯翻出來的訊息 → 三條路都派發，帶 exec 與結果視圖，兩者都凍結', async () => {
    const bus = new EventBus();
    const seen: { exec: PipelineExecution; result: PipelineResult }[] = [];
    bus.on('tools/result', (exec, result) => {
      seen.push({ exec, result });
    });
    const wrap = containment(bus);
    await wrap(
      requestFor({ namespace: 'tools:a|tools:b' }),
      async () => new ToolMessage({ content: '好了', tool_call_id: 'call-1' }),
    );
    await wrap(requestFor(), async () => codedError());
    await wrap(requestFor(), async () => {
      throw new Error('磁碟滿了');
    });
    expect(seen.map((each) => [each.result.kind, each.result.isError])).toEqual([
      ['message', false],
      ['message', true],
      ['message', true],
    ]);
    expect(seen[0]?.exec.agent).toEqual({ kind: 'subagent', runId: 'tools:a' });
    expect(seen[1]?.result).toMatchObject({ error: { code: UNKNOWN_TOOL } });
    expect(seen[2]?.result).toMatchObject({ kind: 'message' });
    expect((seen[2]?.result as { content: string }).content).toContain('磁碟滿了');
    expect(Object.isFrozen(seen[0]?.exec)).toBe(true);
    expect(Object.isFrozen(seen[0]?.result)).toBe(true);
  });

  it('`Command` → `kind: command`', async () => {
    const bus = new EventBus();
    const kinds: string[] = [];
    bus.on('tools/result', (_exec, result) => {
      kinds.push(result.kind);
    });
    const command = new Command({
      update: {
        messages: [new ToolMessage({ content: '壞了', tool_call_id: 'call-1', status: 'error' })],
      },
    });
    expect(await containment(bus)(requestFor(), async () => command)).toBe(command);
    expect(kinds).toEqual(['command']);
  });

  it('在記 `tool/result` 之前派發：監聽者看得到 `tool/call`，看不到 `tool/result`', async () => {
    const bus = new EventBus();
    const log = new SessionLog('s');
    const types: string[][] = [];
    bus.on('tools/result', () => {
      types.push(log.events.map((event) => event.type));
    });
    await containment(bus, log)(
      requestFor(),
      async () => new ToolMessage({ content: '好', tool_call_id: 'call-1' }),
    );
    expect(types).toEqual([['tool/call']]);
    expect(log.events.map((event) => event.type)).toEqual(['tool/call', 'tool/result']);
  });

  it('監聽者同步拋錯 / promise 拒絕 → 結果不變、`tool/result` 照記、其餘監聽者照跑、有回報', async () => {
    const bus = new EventBus();
    const ran: string[] = [];
    bus.on('tools/result', () => {
      throw new Error('同步壞了');
    });
    bus.on('tools/result', () => Promise.reject(new Error('非同步壞了')) as unknown as void);
    bus.on('tools/result', () => {
      ran.push('第三位');
    });
    const log = new SessionLog('s');
    const reports: string[] = [];
    const message = new ToolMessage({ content: '好', tool_call_id: 'call-1' });
    const result = await containment(bus, log, (line) => reports.push(line))(
      requestFor(),
      async () => message,
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(result).toBe(message);
    expect(ran).toEqual(['第三位']);
    expect(log.events.map((event) => event.type)).toEqual(['tool/call', 'tool/result']);
    expect(reports).toHaveLength(2);
    expect(reports[0]).toContain('同步壞了');
    expect(reports[1]).toContain('非同步壞了');
  });

  it('回報函式自己拋錯也不外洩', async () => {
    const bus = new EventBus();
    bus.on('tools/result', () => {
      throw new Error('壞了');
    });
    const message = new ToolMessage({ content: '好', tool_call_id: 'call-1' });
    const result = await containment(bus, undefined, () => {
      throw new Error('回報也壞了');
    })(requestFor(), async () => message);
    expect(result).toBe(message);
  });

  it('中斷穿過圍堵，不派發 `tools/result`', async () => {
    const bus = new EventBus();
    const listener = vi.fn();
    bus.on('tools/result', listener);
    const interrupt = new GraphInterrupt([{ value: '要不要？' } as never]);
    await expect(
      containment(bus)(requestFor(), async () => {
        throw interrupt;
      }),
    ).rejects.toBe(interrupt);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('結果視圖：`content` 由 `blocks` 導出', () => {
  const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } };
  const cases: [string, ToolMessage['content']][] = [
    ['字串內容', '一段字'],
    [
      '純文字陣列',
      [
        { type: 'text', text: '前' },
        { type: 'text', text: '後' },
      ],
    ],
    ['含圖片的陣列', [{ type: 'text', text: '看圖：' }, image, { type: 'text', text: '完' }]],
  ];
  it.each(cases)(
    '%s：`content` 等於那則訊息的 `text`，也等於 `pipelineTextOf(blocks)`',
    (_label, content) => {
      const message = new ToolMessage({ content, tool_call_id: 'call-1' });
      const view = toolResultView(message, 'call-1');
      if (view.kind !== 'message') throw new Error('應該是 message');
      expect(view.content).toBe(message.text);
      expect(pipelineTextOf(view.blocks)).toBe(view.content);
      expect(view.blocks).toEqual(
        typeof content === 'string' ? [{ type: 'text', text: content }] : content,
      );
    },
  );

  it('`blocks` 是凍結的複本：讀兩次是同一份，原訊息的陣列沒被凍', () => {
    const content = [{ type: 'text', text: '前' }, image];
    const message = new ToolMessage({ content, tool_call_id: 'call-1' });
    const view = toolResultView(message, 'call-1');
    if (view.kind !== 'message') throw new Error('應該是 message');
    const blocks = view.blocks;
    expect(view.blocks).toBe(blocks);
    expect(blocks).not.toBe(message.content);
    expect(Object.isFrozen(blocks)).toBe(true);
    expect(Object.isFrozen(blocks[1])).toBe(true);
    expect(Object.isFrozen(message.content)).toBe(false);
    expect(Object.isFrozen((message.content as unknown[])[1])).toBe(false);
  });
});

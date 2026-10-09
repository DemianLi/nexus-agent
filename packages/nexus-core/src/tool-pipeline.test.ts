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
import { markToolError, toolErrorOf, UNKNOWN_TOOL } from './tool-events.js';
import {
  createToolExecuteMiddleware,
  createToolPostExecuteMiddleware,
  createToolPreExecuteMiddleware,
} from './tool-pipeline.js';
import type { PipelineExecution, PipelineResult } from './tool-pipeline.js';

type Handler = (request: unknown) => Promise<unknown>;
type Wrapper = (request: unknown, handler: Handler) => Promise<unknown>;

function wrapperOf(middleware: unknown): Wrapper {
  const wrap = (middleware as { wrapToolCall?: Wrapper }).wrapToolCall;
  if (wrap === undefined) throw new Error('這個 middleware 沒有 wrapToolCall');
  return wrap;
}

/** 一次工具呼叫的假請求；`namespace` 決定呼叫者身分（`checkpoint_ns`）。 */
function requestFor(options: { namespace?: string | null; id?: string | null } = {}): unknown {
  const namespace = options.namespace === undefined ? 'tools:x' : options.namespace;
  return {
    toolCall: {
      name: 'probe',
      args: { path: '/a' },
      ...(options.id === null ? {} : { id: options.id ?? 'call-1' }),
    },
    tool: { name: 'probe' },
    state: {},
    runtime: namespace === null ? {} : { configurable: { checkpoint_ns: namespace } },
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

  it('短路回 `command` 結果 → 拋 TypeError（Command 造不出來）', async () => {
    const bus = new EventBus();
    bus.on('tools/execute', () => Promise.resolve({ kind: 'command', isError: false }));
    const wrap = wrapperOf(createToolExecuteMiddleware(bus));
    await expect(wrap(requestFor(), async () => 'x')).rejects.toBeInstanceOf(TypeError);
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

  it('本體拋錯 → 原樣往外拋，監聽者沒被叫（偏離 3）', async () => {
    const bus = new EventBus();
    const listener = vi.fn();
    bus.on('tools/post-execute', listener as never);
    const wrap = wrapperOf(createToolPostExecuteMiddleware(bus));
    const boom = new Error('壞了');
    await expect(
      wrap(requestFor(), async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(listener).not.toHaveBeenCalled();
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

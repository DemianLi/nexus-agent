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
import type { PipelineExecution, PipelineResult, PipelineResultView } from './tool-pipeline.js';
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
        shape: 'text',
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

  it('叫了 `next()`、本體回不含這次呼叫那則的 `Command`，卻交回另造的 `command` 結果 → 拋 TypeError，訊息說不是 next() 回的那一個', async () => {
    const bus = new EventBus();
    bus.on('tools/execute', async (_exec, next) => {
      const view = await next();
      return { ...view };
    });
    const wrap = wrapperOf(createToolExecuteMiddleware(bus));
    const command = new Command({
      update: { messages: [new ToolMessage({ content: '好', tool_call_id: 'call-2' })] },
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
    await expect(failure).rejects.toBeInstanceOf(TypeError);
    await expect(failure).rejects.toThrow(
      'tools/execute 的監聽者交回的 command 結果不是 next() 回的那一個：Command 造不出來（偏離 2）',
    );
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('本體拋錯、監聽者接住再回 `command` 結果 → 本體跑過了，訊息說不是 next() 回的那一個', async () => {
    const bus = new EventBus();
    bus.on('tools/execute', async (_exec, next) => {
      try {
        await next();
      } catch {
        // 接住本體的錯，改交回 `command` 結果。
      }
      return { kind: 'command', isError: false };
    });
    const wrap = wrapperOf(createToolExecuteMiddleware(bus));
    const handler = vi.fn(async () => {
      throw new Error('壞了');
    });
    const failure = wrap(requestFor(), handler);
    await expect(failure).rejects.toBeInstanceOf(TypeError);
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

describe('tools/execute 交回改過的結果：內容的形狀', () => {
  const IMAGE = { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } };
  const STRING_RAW = () =>
    new ToolMessage({ content: '原文', tool_call_id: 'call-1', name: 'probe' });
  const ARRAY_RAW = () =>
    new ToolMessage({
      content: [{ type: 'text', text: '原文' }, IMAGE],
      tool_call_id: 'call-1',
      name: 'probe',
    });

  type Rewrite = (view: PipelineResult & { kind: 'message' }) => unknown;
  /** 兩種寫法：展開視圖，與明寫 `blocks: view.blocks`。兩者的 `blocks` 都是收到的那一份。 */
  const STYLES: [string, (patch: { content?: string; isError?: boolean }) => Rewrite][] = [
    ['{ ...view, … }', (patch) => (view) => ({ ...view, ...patch })],
    [
      'blocks: view.blocks',
      (patch) => (view) => ({
        kind: 'message',
        isError: patch.isError ?? view.isError,
        content: patch.content ?? view.content,
        blocks: view.blocks,
      }),
    ],
  ];

  async function run(raw: ToolMessage, rewrite: Rewrite): Promise<ToolMessage> {
    const bus = new EventBus();
    bus.on('tools/execute', async (_exec, next) => {
      const view = await next();
      if (view.kind !== 'message') throw new Error('應該是訊息');
      return rewrite(view) as never;
    });
    const out = await wrapperOf(createToolExecuteMiddleware(bus))(requestFor(), async () => raw);
    if (!ToolMessage.isInstance(out)) throw new Error('應該是 ToolMessage');
    return out;
  }

  describe.each(STYLES)('%s', (_name, patched) => {
    it('字串、content 沒換：沿用原本的字串', async () => {
      const out = await run(STRING_RAW(), patched({ isError: true }));
      expect(out.content).toBe('原文');
      expect(out.status).toBe('error');
    });

    it('字串、content 換了：新的字串', async () => {
      expect((await run(STRING_RAW(), patched({ content: '新的' }))).content).toBe('新的');
    });

    it('陣列、content 沒換：沿用原本的陣列，圖片塊也在', async () => {
      const out = await run(ARRAY_RAW(), patched({ isError: true }));
      expect(out.content).toEqual([{ type: 'text', text: '原文' }, IMAGE]);
      expect(out.status).toBe('error');
    });

    it('陣列、content 換了：只剩一個文字塊，圖片塊不留', async () => {
      expect((await run(ARRAY_RAW(), patched({ content: '新的' }))).content).toEqual([
        { type: 'text', text: '新的' },
      ]);
    });
  });

  it('給了新的 blocks（不同參照）：照 blocks，字串的原文也變成陣列', async () => {
    const out = await run(STRING_RAW(), (view) => ({
      ...view,
      blocks: [{ type: 'text', text: '甲' }, IMAGE],
    }));
    expect(out.content).toEqual([{ type: 'text', text: '甲' }, IMAGE]);
  });

  it('只給 content、不給 blocks：新的字串，陣列的原文也一樣', async () => {
    const out = await run(ARRAY_RAW(), (view) => ({
      kind: 'message',
      isError: view.isError,
      content: '新的',
    }));
    expect(out.content).toBe('新的');
  });
});

describe('視圖的 `shape` 與 `command` 視圖的內容', () => {
  it('字串內容是 `text`、陣列內容是 `blocks`', () => {
    const text = toolResultView(
      new ToolMessage({ content: '一', tool_call_id: 'call-1' }),
      'call-1',
    );
    const blocks = toolResultView(
      new ToolMessage({ content: [{ type: 'text', text: '一' }], tool_call_id: 'call-1' }),
      'call-1',
    );
    expect(text).toMatchObject({ kind: 'message', shape: 'text', content: '一' });
    expect(blocks).toMatchObject({ kind: 'message', shape: 'blocks', content: '一' });
  });

  it('`Command` 裡有這次呼叫那則：視圖帶它的內容與形狀；別的呼叫的訊息不算', () => {
    const command = new Command({
      update: {
        messages: [
          new ToolMessage({ content: '別人的', tool_call_id: 'call-2' }),
          new ToolMessage({ content: [{ type: 'text', text: '我的' }], tool_call_id: 'call-1' }),
          new HumanMessage('附帶的'),
        ],
      },
    });
    expect(toolResultView(command, 'call-1')).toEqual({
      kind: 'command',
      blocks: [{ type: 'text', text: '我的' }],
      content: '我的',
      shape: 'blocks',
      isError: false,
    });
  });

  it('`Command` 裡沒有這次呼叫那則：視圖不帶內容三格', () => {
    const command = new Command({ update: { messages: [new HumanMessage('附帶的')] } });
    const view = toolResultView(command, 'call-1');
    expect(view).toEqual({ kind: 'command', isError: false });
    expect(Object.keys(view)).toEqual(['kind', 'isError']);
  });
});

describe('tools/execute 交回帶內容的 `command` 結果：只換 `Command` 裡這次呼叫那則', () => {
  /** 本體回的 `Command`：前後各一則別人的訊息，這次呼叫那則帶 `artifact`、`id`。 */
  function bodyCommand(): Command {
    return new Command({
      graph: Command.PARENT,
      goto: 'next-node',
      update: {
        files: { '/a': '寫了' },
        messages: [
          new HumanMessage('前面的'),
          new ToolMessage({
            content: '子代理說完了',
            tool_call_id: 'call-1',
            name: 'probe',
            artifact: { kept: true },
            id: 'msg-1',
          }),
          new HumanMessage('後面的'),
        ],
      },
    });
  }

  function messagesOf(result: unknown): unknown[] {
    return ((result as Command).update as { messages?: unknown[] } | undefined)?.messages ?? [];
  }

  it('那則在原位換掉，`update` 其餘鍵與 `graph`、`goto` 原樣；沒帶 `fresh` 時沿用 `artifact`、`id`', async () => {
    const bus = new EventBus();
    bus.on('tools/execute', async (_exec, next) => {
      await next();
      return { kind: 'command', content: 'Error: 撞限', isError: true };
    });
    const wrap = wrapperOf(createToolExecuteMiddleware(bus));
    const original = bodyCommand();
    const result = (await wrap(requestFor(), async () => original)) as Command;
    expect(result).not.toBe(original);
    expect(result.graph).toBe(Command.PARENT);
    expect(result.goto).toEqual(original.goto);
    expect((result.update as { files?: unknown }).files).toEqual({ '/a': '寫了' });
    const [before, replaced, after] = messagesOf(result);
    expect(before).toBe(messagesOf(original)[0]);
    expect(after).toBe(messagesOf(original)[2]);
    expect(messagesOf(result)).toHaveLength(3);
    expect(ToolMessage.isInstance(replaced)).toBe(true);
    const message = replaced as ToolMessage;
    expect(message.content).toBe('Error: 撞限');
    expect(message.status).toBe('error');
    expect(message.tool_call_id).toBe('call-1');
    expect(message.artifact).toEqual({ kept: true });
    expect(message.id).toBe('msg-1');
  });

  it('帶 `fresh: true`：那則是新造的，不帶 `artifact`、`id`', async () => {
    const bus = new EventBus();
    bus.on('tools/execute', async (_exec, next) => {
      await next();
      return { kind: 'command', content: 'Error: 撞限', isError: true, fresh: true };
    });
    const wrap = wrapperOf(createToolExecuteMiddleware(bus));
    const result = await wrap(requestFor(), async () => bodyCommand());
    const message = messagesOf(result)[1] as ToolMessage;
    expect(message.content).toBe('Error: 撞限');
    expect(message.name).toBe('probe');
    expect(message.artifact).toBeUndefined();
    expect(message.id).toBeUndefined();
  });

  it('`Command` 裡沒有這次呼叫那則：加在 `update.messages` 最後', async () => {
    const bus = new EventBus();
    bus.on('tools/execute', async (_exec, next) => {
      await next();
      return { kind: 'command', content: '補上的', isError: false };
    });
    const wrap = wrapperOf(createToolExecuteMiddleware(bus));
    const human = new HumanMessage('附帶的');
    const result = await wrap(
      requestFor(),
      async () => new Command({ update: { messages: [human] } }),
    );
    const [first, added] = messagesOf(result);
    expect(first).toBe(human);
    expect((added as ToolMessage).content).toBe('補上的');
    expect((added as ToolMessage).tool_call_id).toBe('call-1');
  });

  it('`{ ...view }` 換掉 `content`：形狀照原本那則（陣列就給一格文字）', async () => {
    const bus = new EventBus();
    bus.on('tools/execute', async (_exec, next) => {
      const view = await next();
      return { ...view, content: '換了' };
    });
    const wrap = wrapperOf(createToolExecuteMiddleware(bus));
    const command = new Command({
      update: {
        messages: [
          new ToolMessage({
            content: [
              { type: 'text', text: '原本' },
              { type: 'image_url', image_url: 'x' },
            ],
            tool_call_id: 'call-1',
          }),
        ],
      },
    });
    const result = await wrap(requestFor(), async () => command);
    expect((messagesOf(result)[0] as ToolMessage).content).toEqual([
      { type: 'text', text: '換了' },
    ]);
  });

  it('本體回的 `Command` 的 `update` 不是物件、或回的不是 `Command` → 換成新造的一則', async () => {
    const bus = new EventBus();
    bus.on('tools/execute', async (_exec, next) => {
      await next();
      return { kind: 'command', content: '換了', isError: true };
    });
    const wrap = wrapperOf(createToolExecuteMiddleware(bus));
    for (const raw of [new Command({ update: [['messages', []]] }), '純文字']) {
      const result = (await wrap(requestFor(), async () => raw)) as ToolMessage;
      expect(ToolMessage.isInstance(result)).toBe(true);
      expect(result.content).toBe('換了');
      expect(result.status).toBe('error');
    }
  });

  it('本體沒跑（短路）就交回帶內容的 `command` 結果 → 照舊拋「工具本體沒有跑」', async () => {
    const bus = new EventBus();
    bus.on('tools/execute', () =>
      Promise.resolve({ kind: 'command' as const, content: '換了', isError: false }),
    );
    const wrap = wrapperOf(createToolExecuteMiddleware(bus));
    await expect(wrap(requestFor(), async () => bodyCommand())).rejects.toThrow(
      'tools/execute 的監聽者回了 command 結果，但工具本體沒有跑：Command 造不出來（偏離 2）',
    );
  });
});

describe('tools/execute 交回 `fresh: true` 的 `message` 結果：新造一則', () => {
  function bodyMessage(): ToolMessage {
    return new ToolMessage({
      content: '{"ok":1}',
      tool_call_id: 'call-1',
      name: 'probe',
      artifact: { raw: true },
      id: 'msg-1',
      additional_kwargs: { extra: 1 },
    });
  }

  it('本體回 `ToolMessage`：不沿用 `artifact`、`id`、`additional_kwargs`，碼照交回的', async () => {
    const bus = new EventBus();
    bus.on('tools/execute', async (_exec, next) => {
      await next();
      return {
        kind: 'message',
        content: 'Error: 不合',
        isError: true,
        error: { name: 'ToolOutputError', code: 'X' },
        fresh: true,
      };
    });
    const wrap = wrapperOf(createToolExecuteMiddleware(bus));
    const message = (await wrap(requestFor(), async () => bodyMessage())) as ToolMessage;
    expect(message.content).toBe('Error: 不合');
    expect(message.status).toBe('error');
    expect(message.name).toBe('probe');
    expect(message.artifact).toBeUndefined();
    expect(message.id).toBeUndefined();
    expect(message.additional_kwargs).toEqual({});
    expect(toolErrorOf(message)).toEqual({ name: 'ToolOutputError', code: 'X' });
  });

  it('沒帶 `fresh`：照舊沿用本體那則的 `artifact`、`id`、`additional_kwargs`', async () => {
    const bus = new EventBus();
    bus.on('tools/execute', async (_exec, next) => {
      await next();
      return { kind: 'message', content: 'Error: 不合', isError: true };
    });
    const wrap = wrapperOf(createToolExecuteMiddleware(bus));
    const message = (await wrap(requestFor(), async () => bodyMessage())) as ToolMessage;
    expect(message.artifact).toEqual({ raw: true });
    expect(message.id).toBe('msg-1');
    expect(message.additional_kwargs).toEqual({ extra: 1 });
  });

  it('本體回 `Command`：整個 `Command` 不採用，換成新造的那一則', async () => {
    const bus = new EventBus();
    bus.on('tools/execute', async (_exec, next) => {
      await next();
      return { kind: 'message', content: 'Error: 不合', isError: true, fresh: true };
    });
    const wrap = wrapperOf(createToolExecuteMiddleware(bus));
    const command = new Command({
      update: {
        messages: [
          new ToolMessage({ content: '好', tool_call_id: 'call-1' }),
          new HumanMessage('附帶的'),
        ],
      },
    });
    const result = await wrap(requestFor(), async () => command);
    expect(ToolMessage.isInstance(result)).toBe(true);
    expect((result as ToolMessage).content).toBe('Error: 不合');
  });
});

describe('型別：只帶舊欄位的值照樣編得過', () => {
  it('不帶 `shape` 的 `PipelineResult`、`tools/execute` 的交回值', async () => {
    const result: PipelineResult = { kind: 'message', blocks: [], content: '', isError: false };
    const command: PipelineResult = { kind: 'command', isError: false };
    const bus = new EventBus();
    bus.on('tools/execute', async () => result);
    bus.on('tools/execute', async () => ({ kind: 'message', content: '舊的', isError: false }));
    bus.on('tools/execute', async () => ({ kind: 'message', blocks: [], isError: false }));
    bus.on('tools/execute', async (_exec, next) => {
      await next();
      return command;
    });
    const view: PipelineResultView = toolResultView(
      new ToolMessage({ content: '一', tool_call_id: 'call-1' }),
      'call-1',
    );
    const widened: PipelineResult = view;
    // @ts-expect-error 視圖的 `shape` 必填。
    const missing: PipelineResultView = result;
    expect([widened, missing, command]).toHaveLength(3);
    expect(bus.count('tools/execute')).toBe(4);
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
        shape: 'text',
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

describe('core 監聽者的兩段：外層在每位插件監聽者外側，內層在內側', () => {
  /** 記下誰被叫、依序；每位都放行。 */
  const tracer = (log: string[], who: string) => (_exec: unknown, next: () => unknown) => {
    log.push(who);
    return next();
  };

  it('pre：外層 core → 插件（含 `prepend`、晚掛的）→ 內層 core → 本體', async () => {
    const log: string[] = [];
    const bus = new EventBus();
    bus.on('tools/pre-execute', tracer(log, 'plugin') as never);
    const wrap = wrapperOf(
      createToolPreExecuteMiddleware(bus, {
        outer: [tracer(log, 'outer') as never],
        inner: [tracer(log, 'inner') as never],
      }),
    );
    // 建好之後才掛的、帶 `prepend` 的，也只排在插件那一段裡。
    bus.on('tools/pre-execute', tracer(log, 'late') as never, { prepend: true });
    await wrap(requestFor(), async () => {
      log.push('body');
      return codedError();
    });
    expect(log).toEqual(['outer', 'late', 'plugin', 'inner', 'body']);
  });

  it('execute 與 post：同一個順序', async () => {
    const log: string[] = [];
    const bus = new EventBus();
    bus.on('tools/execute', tracer(log, 'plugin') as never);
    bus.on('tools/post-execute', ((_exec: unknown, _view: unknown, next: () => unknown) => {
      log.push('post-plugin');
      return next();
    }) as never);
    const post = (who: string) => (_exec: unknown, _view: unknown, next: () => unknown) => {
      log.push(who);
      return next();
    };
    const execute = wrapperOf(
      createToolExecuteMiddleware(bus, {
        outer: [tracer(log, 'outer') as never],
        inner: [tracer(log, 'inner') as never],
      }),
    );
    const postExecute = wrapperOf(
      createToolPostExecuteMiddleware(bus, {
        outer: [post('post-outer') as never],
        inner: [post('post-inner') as never],
      }),
    );
    const message = codedError();
    expect(
      await postExecute(requestFor(), () =>
        execute(requestFor(), async () => {
          log.push('body');
          return message;
        }),
      ),
    ).toBe(message);
    expect(log).toEqual([
      'outer',
      'plugin',
      'inner',
      'body',
      'post-outer',
      'post-plugin',
      'post-inner',
    ]);
  });

  it('外層 core 不叫 `next()` → 插件與內層都不跑', async () => {
    const log: string[] = [];
    const bus = new EventBus();
    bus.on('tools/pre-execute', tracer(log, 'plugin') as never);
    const wrap = wrapperOf(
      createToolPreExecuteMiddleware(bus, {
        outer: [(() => Promise.resolve({ kind: 'deny', reason: '不准' })) as never],
        inner: [tracer(log, 'inner') as never],
      }),
    );
    const answer = (await wrap(requestFor(), async () => codedError())) as ToolMessage;
    expect(answer.status).toBe('error');
    expect(log).toEqual([]);
  });

  it('core 監聽者叫第二次 `next()` → 拋', async () => {
    const wrap = wrapperOf(
      createToolPreExecuteMiddleware(new EventBus(), {
        outer: [
          (async (_exec: unknown, next: () => Promise<unknown>) => {
            await next();
            return next();
          }) as never,
        ],
      }),
    );
    await expect(wrap(requestFor(), async () => codedError())).rejects.toThrow(
      'tools/pre-execute 的監聽者呼叫了第二次 next()',
    );
  });

  it('沒給派發面：core 兩段照跑；兩段都空 → 直通，原物件', async () => {
    const log: string[] = [];
    const wrap = wrapperOf(
      createToolPreExecuteMiddleware(undefined, { outer: [tracer(log, 'outer') as never] }),
    );
    await wrap(requestFor(), async () => codedError());
    expect(log).toEqual(['outer']);
    const message = codedError();
    expect(
      await wrapperOf(createToolPreExecuteMiddleware(undefined))(requestFor(), async () => message),
    ).toBe(message);
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

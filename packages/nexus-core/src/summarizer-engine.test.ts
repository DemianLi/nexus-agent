/**
 * 摘要器引擎對照基座（[#2416](https://github.com/DemianLi/nexus-agent/issues/2416)）：同一組請求同時餵 `deepagents@1.13.1` 的
 * `createSummarizationMiddleware` 與 {@link createSummarizerEngine}，逐項比 handler 收到的訊息、摘要模型的輸入、歷史檔的寫入、
 * 回傳值與拋錯。基座拿掉時（c-2）這一支跟著刪。
 */

import { ContextOverflowError } from '@langchain/core/errors';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { isCommand } from '@langchain/langgraph';
import { createSummarizationMiddleware } from 'deepagents';
import { tool } from 'langchain';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createSummarizerEngine } from './summarizer-engine.js';
import type { SummarizerEngineOptions } from './summarizer-engine.js';

type Options = Omit<SummarizerEngineOptions, 'backend'>;

/** 記下每一次讀寫的記憶體 backend。`failWrite` 為真時 `write` 回錯。 */
function memoryBackend(seed: Record<string, string> = {}, failWrite = false) {
  const files = new Map(Object.entries(seed));
  const calls: string[] = [];
  return {
    files,
    calls,
    backend: {
      read: async () => ({ error: 'not used' }),
      ls: async () => ({ files: [] }),
      grep: async () => ({ matches: [] }),
      glob: async () => ({ files: [] }),
      write: async (path: string, content: string) => {
        calls.push(`write ${path}`);
        if (failWrite) return { error: '寫不進去' };
        files.set(path, content);
        return { path };
      },
      edit: async (path: string, _old: string, content: string) => {
        calls.push(`edit ${path}`);
        files.set(path, content);
        return { path };
      },
      downloadFiles: async (paths: string[]) => {
        calls.push(`download ${paths.join(',')}`);
        return paths.map((path) =>
          files.has(path)
            ? { path, content: new TextEncoder().encode(files.get(path)!), error: null }
            : { path, content: null, error: 'file_not_found' },
        );
      },
      uploadFiles: async (entries: [string, Uint8Array][]) => {
        calls.push(`upload ${entries.map(([path]) => path).join(',')}`);
        for (const [path, bytes] of entries) files.set(path, new TextDecoder().decode(bytes));
        return entries.map(([path]) => ({ path, error: null }));
      },
    },
  };
}

const stamp = (text: string) => text.replace(/## Summarized at \S+/g, '## Summarized at <t>');
const show = (messages: readonly BaseMessage[]) =>
  messages.map((m) => ({
    type: m.getType(),
    content: m.content,
    kwargs: m.additional_kwargs,
    tools: (m as AIMessage).tool_calls,
    id: (m as ToolMessage).tool_call_id,
  }));

interface Step {
  readonly messages: BaseMessage[];
  readonly state?: Record<string, unknown>;
  /** 第幾次 handler 呼叫（1 起算）拋什麼。 */
  readonly handlerThrows?: (call: number) => Error | undefined;
  readonly withTools?: boolean;
}

/** 照順序跑幾步，回每一步的觀察；兩邊各一套，同一顆實例跑完全部步驟（看 closure 的壽命）。 */
async function observe(
  make: (backend: never) => unknown,
  steps: readonly Step[],
  options: { profile?: object; seed?: Record<string, string>; failWrite?: boolean } = {},
) {
  const store = memoryBackend(options.seed, options.failWrite);
  const middleware = make(store.backend as never) as {
    wrapModelCall: (request: unknown, handler: unknown) => Promise<unknown>;
  };
  const prompts: string[] = [];
  const model = {
    profile: options.profile ?? {},
    invoke: async (input: BaseMessage[]) => {
      prompts.push(String(input[0]!.content));
      return { text: `摘要 ${String(prompts.length)}` };
    },
  };
  const echo = tool(async () => 'ok', {
    name: 'echo',
    description: '回聲',
    schema: z.object({ message: z.string() }),
  });
  const warns: string[] = [];
  const spy = vi.spyOn(console, 'warn').mockImplementation((...args) => {
    warns.push(String(args[0]));
  });
  const out: unknown[] = [];
  try {
    for (const step of steps) {
      const handled: unknown[] = [];
      let result: unknown;
      let error: unknown;
      try {
        result = await middleware.wrapModelCall(
          {
            messages: step.messages,
            state: {
              messages: step.messages,
              _summarizationSessionId: 'session_fixed',
              ...step.state,
            },
            model,
            systemMessage: new SystemMessage('系統。'),
            tools: step.withTools === true ? [echo] : [],
          },
          async (request: { messages: BaseMessage[] }) => {
            handled.push(show(request.messages));
            const thrown = step.handlerThrows?.(handled.length);
            if (thrown !== undefined) throw thrown;
            return new AIMessage('好。');
          },
        );
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
      const update = isCommand(result) ? (result.update as Record<string, unknown>) : undefined;
      const event = update?._summarizationEvent as
        { cutoffIndex: number; filePath: string | null; summaryMessage: BaseMessage } | undefined;
      out.push({
        handled,
        error,
        result: isCommand(result) ? 'command' : (result as AIMessage | undefined)?.content,
        event:
          event === undefined
            ? undefined
            : { ...event, summaryMessage: show([event.summaryMessage]) },
        sessionId: update?._summarizationSessionId,
      });
    }
  } finally {
    spy.mockRestore();
  }
  return {
    out,
    prompts,
    warns,
    calls: store.calls,
    files: Object.fromEntries([...store.files].map(([path, text]) => [path, stamp(text)])),
  };
}

async function same(
  settings: Options,
  steps: readonly Step[],
  options?: Parameters<typeof observe>[2],
) {
  const base = await observe(
    (backend) =>
      createSummarizationMiddleware({
        backend,
        summaryPrompt: settings.summaryPrompt,
        trigger: settings.trigger.map((t) => ({ ...t })) as never,
        keep: { ...settings.keep } as never,
        ...(settings.historyPathPrefix !== undefined && {
          historyPathPrefix: settings.historyPathPrefix,
        }),
        truncateArgsSettings: settings.truncateArgsSettings as never,
      }),
    steps,
    options,
  );
  const ours = await observe(
    (backend) => createSummarizerEngine({ ...settings, backend }),
    steps,
    options,
  );
  expect(ours).toEqual(base);
  return ours;
}

const PROMPT = '摘要這段：\n{conversation}\n完。';
const turns = (count: number, pad = '') =>
  Array.from({ length: count }, (_, i) =>
    i % 2 === 0
      ? new HumanMessage(`人 ${String(i)}${pad}`)
      : new AIMessage(`答 ${String(i)}${pad}`),
  );
const settings = (over: Partial<Options> = {}): Options => ({
  summaryPrompt: PROMPT,
  trigger: [{ type: 'messages', value: 6 }],
  keep: { type: 'messages', value: 2 },
  historyPathPrefix: '/conversation_history',
  truncateArgsSettings: {
    trigger: { type: 'messages', value: 1_000 },
    keep: { type: 'messages', value: 20 },
  },
  ...over,
});

describe('引擎與基座逐項相同', () => {
  it('沒到門檻：原樣交下去', async () => {
    const { out } = await same(settings(), [{ messages: turns(3) }]);
    expect((out[0] as { result: unknown }).result).toBe('好。');
  });

  it('訊息數門檻：摘要、寫檔、回 Command', async () => {
    const { prompts, files } = await same(settings(), [{ messages: turns(8) }]);
    expect(prompts).toHaveLength(1);
    expect(Object.keys(files)).toEqual(['/conversation_history/session_fixed.md']);
  });

  it('連三步帶著上一次的切點：prev + cutoff − 1，歷史檔接著寫', async () => {
    const first = turns(8);
    const event = (cutoffIndex: number) => ({
      cutoffIndex,
      summaryMessage: new HumanMessage({
        content: '舊摘要',
        additional_kwargs: { lc_source: 'summarization' },
      }),
      filePath: '/conversation_history/session_fixed.md',
    });
    await same(
      settings(),
      [
        { messages: first },
        { messages: turns(12), state: { _summarizationEvent: event(6) } },
        { messages: turns(16), state: { _summarizationEvent: event(9) } },
      ],
      { seed: { '/conversation_history/session_fixed.md': '## Summarized at x\n\n舊的\n\n' } },
    );
  });

  it('摘要之後端點回超窗：retain 0 重摘再送', async () => {
    const { out } = await same(settings(), [
      {
        messages: turns(8),
        handlerThrows: (call) => (call === 1 ? new ContextOverflowError('太長') : undefined),
      },
    ]);
    expect((out[0] as { handled: unknown[] }).handled).toHaveLength(2);
  });

  it('沒到門檻卻超窗：估算倍率記在實例上，下一步照倍率判', async () => {
    await same(
      settings({ trigger: [{ type: 'tokens', value: 50 }] }),
      [
        {
          messages: turns(4),
          handlerThrows: (call) => (call === 1 ? new ContextOverflowError('太長') : undefined),
        },
        { messages: turns(4) },
      ],
      { profile: { maxInputTokens: 200 } },
    );
  });

  it('其他錯：原樣拋', async () => {
    const { out } = await same(settings(), [
      { messages: turns(8), handlerThrows: () => new Error('503') },
    ]);
    expect((out[0] as { error: unknown }).error).toBe('503');
  });

  it('工具配對：切點不拆開 AI 與它的工具結果', async () => {
    const messages: BaseMessage[] = [
      new HumanMessage('一'),
      new AIMessage('二'),
      new HumanMessage('三'),
      new AIMessage({
        content: '',
        tool_calls: [{ id: 'c1', name: 'echo', args: { message: 'x' } }],
      }),
      new ToolMessage({ content: '結果', tool_call_id: 'c1' }),
      new AIMessage('收尾'),
    ];
    await same(settings({ keep: { type: 'messages', value: 2 } }), [{ messages, withTools: true }]);
    await same(settings({ keep: { type: 'messages', value: 3 } }), [{ messages, withTools: true }]);
  });

  it('token 保留量與門檻，帶工具一起估', async () => {
    await same(
      settings({ trigger: [{ type: 'tokens', value: 60 }], keep: { type: 'tokens', value: 30 } }),
      [{ messages: turns(10, '內容'.repeat(10)), withTools: true }],
    );
  });

  it('參數截斷：舊的 write_file 長參數被截，之後的工具呼叫重建', async () => {
    const big = 'x'.repeat(50);
    const messages: BaseMessage[] = [
      new HumanMessage('寫'),
      new AIMessage({
        content: '',
        tool_calls: [{ id: 'w1', name: 'write_file', args: { file_path: '/a', content: big } }],
      }),
      new ToolMessage({ content: 'ok', tool_call_id: 'w1' }),
      new AIMessage({
        content: '',
        tool_calls: [{ id: 'e1', name: 'echo', args: { message: big } }],
      }),
      new ToolMessage({ content: 'ok', tool_call_id: 'e1' }),
      new HumanMessage('再來'),
    ];
    await same(
      settings({
        trigger: [],
        truncateArgsSettings: {
          trigger: { type: 'messages', value: 2 },
          keep: { type: 'messages', value: 1 },
          maxLength: 10,
        },
      }),
      [{ messages }],
    );
  });

  it('留下的是空的、有 profile：先壓工具結果再送', async () => {
    const messages: BaseMessage[] = [
      new HumanMessage('讀'),
      new AIMessage({
        content: '',
        tool_calls: [{ id: 'r1', name: 'echo', args: { message: 'a' } }],
      }),
      new ToolMessage({ content: '大'.repeat(20_000), tool_call_id: 'r1' }),
    ];
    await same(
      settings({ trigger: [{ type: 'messages', value: 1 }], keep: { type: 'messages', value: 0 } }),
      [{ messages }],
      {
        profile: { maxInputTokens: 2_000 },
      },
    );
  });

  it('歷史檔寫不進去：filePath 是 null、warn、照樣摘要', async () => {
    const { warns } = await same(settings(), [{ messages: turns(8) }], { failWrite: true });
    expect(warns.length).toBeGreaterThan(0);
  });

  it('state 沒有 session id：實例自己的 id 在同一顆實例上不變', async () => {
    const steps: Step[] = [
      { messages: turns(8), state: { _summarizationSessionId: undefined } },
      { messages: turns(8), state: { _summarizationSessionId: undefined } },
    ];
    const store = memoryBackend();
    const engine = createSummarizerEngine({ ...settings(), backend: store.backend as never });
    const ids: unknown[] = [];
    for (const step of steps) {
      const result = await engine.wrapModelCall?.(
        {
          messages: step.messages,
          state: { messages: step.messages },
          model: { profile: {}, invoke: async () => ({ text: '摘' }) },
          systemMessage: new SystemMessage('系統。'),
          tools: [],
        } as never,
        (async () => new AIMessage('好。')) as never,
      );
      ids.push(
        (result as { update: { _summarizationSessionId: unknown } }).update._summarizationSessionId,
      );
    }
    expect(ids[0]).toMatch(/^session_[0-9a-f]{8}$/);
    expect(ids[1]).toBe(ids[0]);
  });

  it('沒有訊息：原樣交下去；沒有模型：同一句錯', async () => {
    await same(settings(), [{ messages: [] }]);
    const engine = createSummarizerEngine({
      ...settings(),
      backend: memoryBackend().backend as never,
    });
    const base = createSummarizationMiddleware({
      backend: memoryBackend().backend as never,
      trigger: [{ type: 'messages', value: 1 }],
    });
    const request = {
      messages: turns(2),
      state: {},
      systemMessage: new SystemMessage('s'),
      tools: [],
    };
    const handler = async () => new AIMessage('好。');
    const [a, b] = await Promise.allSettled([
      engine.wrapModelCall?.(request as never, handler as never),
      (
        base as unknown as { wrapModelCall: (r: unknown, h: unknown) => Promise<unknown> }
      ).wrapModelCall(request, handler),
    ]);
    expect(a.status).toBe('rejected');
    expect((a as PromiseRejectedResult).reason.message).toBe(
      (b as PromiseRejectedResult).reason.message,
    );
  });
});

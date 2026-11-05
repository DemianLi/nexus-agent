/**
 * 摘要器引擎對照基座：同一組請求同時餵 `deepagents@1.13.1` 的
 * `createSummarizationMiddleware` 與 {@link createSummarizerEngine}，逐項比 handler 收到的訊息、摘要模型的輸入、歷史檔的寫入、
 * 回傳值、拋錯與切點。基座的上一次切點放在 state，引擎的放在切點表（{@link withSummaryCutoffs}）；基座的切點讀它回的 `Command`，
 * 引擎的照 `withCompactionLog` 的算法（{@link summaryCutoffIndex}）從交下去的那份算。基座的依賴拿掉時這一支跟著刪。
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
import {
  applySummaryCutoff,
  summaryCutoffIndex,
  SummaryCutoffTable,
  withSummaryCutoffs,
} from './summary-cutoffs.js';
import type { SummaryCutoff } from './summary-cutoffs.js';

type Options = Omit<SummarizerEngineOptions, 'backend' | 'sessionId'>;

const ROOT = { configurable: { thread_id: 't', checkpoint_ns: 'model_request:x' } };

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
  /** 這一步開始時的上一次切點。 */
  readonly previous?: SummaryCutoff;
  /** 第幾次 handler 呼叫（1 起算）拋什麼。 */
  readonly handlerThrows?: (call: number) => Error | undefined;
  readonly withTools?: boolean;
}

/** 照順序跑幾步，回每一步的觀察；兩邊各一套，同一顆實例跑完全部步驟（看 closure 的壽命）。 */
async function observe(
  kind: 'base' | 'engine',
  make: (backend: never) => unknown,
  steps: readonly Step[],
  options: { profile?: object; seed?: Record<string, string>; failWrite?: boolean } = {},
) {
  const store = memoryBackend(options.seed, options.failWrite);
  type Wrap = { wrapModelCall: (request: unknown, handler: unknown) => Promise<unknown> };
  const made = make(store.backend as never);
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
      let sent: BaseMessage[] = [];
      let result: unknown;
      let error: unknown;
      // 引擎：每一步一張新表，只放這一步的上一次切點（同基座只看這一步交進來的 state）。
      const table = new SummaryCutoffTable();
      if (step.previous !== undefined) table.record(ROOT, step.messages, step.previous);
      const middleware = (
        kind === 'engine' ? withSummaryCutoffs(made as never, table) : made
      ) as Wrap;
      try {
        result = await middleware.wrapModelCall(
          {
            messages: step.messages,
            state: {
              messages: step.messages,
              ...(kind === 'base' && {
                _summarizationSessionId: 'session_fixed',
                _summarizationEvent: step.previous,
              }),
            },
            model,
            systemMessage: new SystemMessage('系統。'),
            tools: step.withTools === true ? [echo] : [],
            runtime: ROOT,
          },
          async (request: { messages: BaseMessage[] }) => {
            sent = request.messages;
            handled.push(show(request.messages));
            const thrown = step.handlerThrows?.(handled.length);
            if (thrown !== undefined) throw thrown;
            return new AIMessage('好。');
          },
        );
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
      let cutoff: number | undefined;
      if (kind === 'base') {
        const update = isCommand(result) ? (result.update as Record<string, unknown>) : undefined;
        cutoff = (update?._summarizationEvent as { cutoffIndex: number } | undefined)?.cutoffIndex;
      } else if (
        error === undefined &&
        sent[0] !== undefined &&
        sent[0].additional_kwargs?.lc_source === 'summarization' &&
        sent[0] !== step.previous?.summaryMessage
      ) {
        cutoff = summaryCutoffIndex(
          step.previous?.cutoffIndex,
          applySummaryCutoff(step.messages, step.previous).length,
          sent.length,
        );
      }
      out.push({
        handled,
        error,
        // 基座摘要過回 `Command`，引擎回交下去那次的回覆，兩邊比的是交下去那次的回覆。
        result: isCommand(result) ? '好。' : (result as AIMessage | undefined)?.content,
        cutoff,
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
  options?: Parameters<typeof observe>[3],
) {
  const base = await observe(
    'base',
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
    'engine',
    (backend) => createSummarizerEngine({ ...settings, sessionId: 'session_fixed', backend }),
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
        { messages: turns(12), previous: event(6) },
        { messages: turns(16), previous: event(9) },
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

  it('session id 是建構參數：同一顆實例兩次摘要寫同一個檔', async () => {
    const store = memoryBackend();
    const engine = createSummarizerEngine({
      ...settings(),
      sessionId: 'session_abcd1234',
      backend: store.backend as never,
    });
    for (let i = 0; i < 2; i += 1) {
      const messages = turns(8);
      await engine.wrapModelCall?.(
        {
          messages,
          state: { messages },
          model: { profile: {}, invoke: async () => ({ text: '摘' }) },
          systemMessage: new SystemMessage('系統。'),
          tools: [],
        } as never,
        (async () => new AIMessage('好。')) as never,
      );
    }
    expect([...store.files.keys()]).toEqual(['/conversation_history/session_abcd1234.md']);
  });

  it('沒有訊息：原樣交下去；沒有模型：同一句錯', async () => {
    await same(settings(), [{ messages: [] }]);
    const engine = createSummarizerEngine({
      ...settings(),
      sessionId: 'session_fixed',
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

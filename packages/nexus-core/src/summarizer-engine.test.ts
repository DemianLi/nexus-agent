/**
 * 摘要器引擎：判斷、切點、歷史檔、溢出重摘、估算倍率、參數截斷與工具結果壓縮。上一次切點經切點表（{@link withSummaryCutoffs}）
 * 交進來；這一步的切點照 `withCompactionLog` 的算法（{@link summaryCutoffIndex}）從交下去的那份算。
 */

import { ContextOverflowError } from '@langchain/core/errors';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { tool } from 'langchain';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { summaryFilePathOf } from './summarization.js';
import { createSummarizerEngine } from './summarizer-engine.js';
import type { SummarizerEngineOptions } from './summarizer-engine.js';
import {
  applySummaryCutoff,
  summaryCutoffIndex,
  SummaryCutoffTable,
  withSummaryCutoffs,
} from './summary-cutoffs.js';
import type { SummaryCutoff } from './summary-cutoffs.js';

type Options = Omit<SummarizerEngineOptions, 'backend' | 'sessionIdOf'>;

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

const PROMPT = '摘要這段：\n{conversation}\n完。';
const PATH = '/conversation_history/session_fixed.md';
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

const echo = tool(async () => 'ok', {
  name: 'echo',
  description: '回聲',
  schema: z.object({ message: z.string() }),
});

/** 摘要模型：記下每次收到的提示，回「摘要 N」。 */
function summaryModel(profile: object = {}) {
  const prompts: string[] = [];
  return {
    prompts,
    model: {
      profile,
      invoke: async (input: BaseMessage[]) => {
        prompts.push(String(input[0]!.content));
        return { text: `摘要 ${String(prompts.length)}` };
      },
    },
  };
}

interface StepOptions {
  readonly previous?: SummaryCutoff;
  /** 第幾次 handler 呼叫（1 起算）拋什麼。 */
  readonly handlerThrows?: (call: number) => Error | undefined;
  readonly withTools?: boolean;
  readonly model?: unknown;
}

/**
 * 經切點表跑一步：表上先記上一次切點。回 handler 每次收到的訊息、回傳值，與照 `withCompactionLog` 算出的切點
 * （最後一次交下去的開頭是這一步新的摘要才有）。摘要過的步驟順便斷言留下的尾巴等於 state 從切點起的那段。
 */
async function engineStep(
  engine: ReturnType<typeof createSummarizerEngine>,
  messages: BaseMessage[],
  options: StepOptions = {},
) {
  const { previous } = options;
  const table = new SummaryCutoffTable();
  if (previous !== undefined) table.record(ROOT, messages, previous);
  const handled: BaseMessage[][] = [];
  const result = await (
    withSummaryCutoffs(engine, table) as unknown as {
      wrapModelCall: (request: unknown, handler: unknown) => Promise<unknown>;
    }
  ).wrapModelCall(
    {
      messages,
      state: { messages },
      model: options.model ?? summaryModel().model,
      systemMessage: new SystemMessage('系統。'),
      tools: options.withTools === true ? [echo] : [],
      runtime: ROOT,
    },
    async (request: { messages: BaseMessage[] }) => {
      handled.push(request.messages);
      const thrown = options.handlerThrows?.(handled.length);
      if (thrown !== undefined) throw thrown;
      return new AIMessage('好。');
    },
  );
  const sent = handled.at(-1) ?? [];
  const summarized =
    sent[0]?.additional_kwargs?.lc_source === 'summarization' &&
    sent[0] !== previous?.summaryMessage;
  const cutoff = summarized
    ? summaryCutoffIndex(
        previous?.cutoffIndex,
        applySummaryCutoff(messages, previous).length,
        sent.length,
      )
    : undefined;
  const contents = sent.map((m) => String(m.content));
  // 反推出的切點就是留下的尾巴在 state 裡的座標：每一條摘要過的情境都經過這裡。
  if (cutoff !== undefined)
    expect(contents.slice(1)).toEqual(messages.slice(cutoff).map((m) => String(m.content)));
  return { result, handled, sent, contents, cutoff };
}

function engineWith(options: { failWrite?: boolean; sessionId?: string } & Partial<Options> = {}) {
  const { failWrite, sessionId, ...over } = options;
  const store = memoryBackend({}, failWrite);
  const engine = createSummarizerEngine({
    ...settings(over),
    sessionIdOf: () => sessionId ?? 'session_fixed',
    backend: store.backend as never,
  });
  return { store, engine };
}

/** 有歷史檔時交下去的那則摘要，全文。 */
const summaryWithFile = (summary: string) =>
  'You are in the middle of a conversation that has been summarized.\n\n' +
  `The full conversation history has been saved to ${PATH} should you need to refer back to it for details.\n\n` +
  `A condensed summary follows:\n\n<summary>\n${summary}\n</summary>`;

const sections = (text: string | undefined) =>
  stamp(text ?? '')
    .split('## Summarized at <t>')
    .slice(1);

describe('摘要器引擎', () => {
  it('沒到門檻：原樣交下去，不叫摘要模型', async () => {
    const { engine, store } = engineWith();
    const { model, prompts } = summaryModel();
    const messages = turns(3);
    const step = await engineStep(engine, messages, { model });
    expect(step.handled).toEqual([messages]);
    expect((step.result as AIMessage).content).toBe('好。');
    expect(prompts).toEqual([]);
    expect(store.calls).toEqual([]);
  });

  it('訊息數門檻：摘要前段、寫歷史檔，交下去的是摘要＋留下的', async () => {
    const { engine, store } = engineWith();
    const { model, prompts } = summaryModel();
    const step = await engineStep(engine, turns(8), { model });
    expect(step.cutoff).toBe(6);
    expect((step.result as AIMessage).content).toBe('好。');
    expect(step.contents).toEqual([summaryWithFile('摘要 1'), '人 6', '答 7']);
    expect(summaryFilePathOf(step.sent[0]!)).toBe(PATH);
    expect(prompts).toEqual([
      '摘要這段：\nHuman: 人 0\nAI: 答 1\nHuman: 人 2\nAI: 答 3\nHuman: 人 4\nAI: 答 5\n完。',
    ]);
    // 沒有舊檔：先下載（不存在）再寫新檔。
    expect(store.calls).toEqual([`download ${PATH}`, `write ${PATH}`]);
    expect(stamp(store.files.get(PATH)!)).toBe(
      '## Summarized at <t>\n\nHuman: 人 0\nAI: 答 1\nHuman: 人 2\nAI: 答 3\nHuman: 人 4\nAI: 答 5\n\n',
    );
  });

  it('連三步帶著上一次的切點：從上一則摘要接著摘，歷史檔接著寫', async () => {
    const { engine, store } = engineWith();
    const { model, prompts } = summaryModel();
    const cutoffs: (number | undefined)[] = [];
    let previous: SummaryCutoff | undefined;
    for (const count of [8, 12, 16]) {
      const step = await engineStep(engine, turns(count), { previous, model });
      cutoffs.push(step.cutoff);
      previous = {
        cutoffIndex: step.cutoff!,
        summaryMessage: step.sent[0]!,
        filePath: PATH,
      };
    }
    // 8 則：有效串 8、留 2，切在 6；12 則：有效串 [摘要, 6..11] 共 7、留 2，本地切在 5，6 + 5 − 1 = 10；
    // 16 則：有效串 [摘要, 10..15] 共 7，10 + 5 − 1 = 14。
    expect(cutoffs).toEqual([6, 10, 14]);
    // 第二、三步摘要的是「上一則摘要＋切點之後」，不是從頭。
    expect(prompts[1]).toContain('摘要 1');
    expect(prompts[1]).toContain('人 6');
    expect(prompts[1]).not.toContain('人 4');
    expect(prompts[2]).toContain('摘要 2');
    expect(prompts[2]).not.toContain('人 8');
    // 歷史檔接著寫同一個檔，一步一段，摘要訊息本身不寫進去。
    expect([...store.files.keys()]).toEqual([PATH]);
    const written = sections(store.files.get(PATH));
    expect(written).toHaveLength(3);
    expect(written[1]).toContain('人 6');
    expect(written[1]).not.toContain('人 4');
    expect(written[1]).not.toContain('摘要 1');
  });

  it('已有舊檔、上一次切點由外面給：照給的切點接著摘，歷史檔下載後整份上傳', async () => {
    const { engine, store } = engineWith();
    store.files.set(PATH, '## Summarized at x\n\n舊的\n\n');
    const { model, prompts } = summaryModel();
    const old = () =>
      new HumanMessage({ content: '舊摘要', additional_kwargs: { lc_source: 'summarization' } });
    const cutoffs: (number | undefined)[] = [];
    // 第三步給的切點 9 不是第二步算出的 10：引擎照交進來的那一個切有效串。
    for (const [count, given] of [
      [8, undefined],
      [12, 6],
      [16, 9],
    ] as const) {
      const previous =
        given === undefined
          ? undefined
          : { cutoffIndex: given, summaryMessage: old(), filePath: PATH };
      cutoffs.push((await engineStep(engine, turns(count), { model, previous })).cutoff);
    }
    // 16 則、給 9：有效串 [舊摘要, 9..15] 共 8、留 2，本地切在 6，9 + 6 − 1 = 14。
    expect(cutoffs).toEqual([6, 10, 14]);
    expect(prompts).toEqual([
      '摘要這段：\nHuman: 人 0\nAI: 答 1\nHuman: 人 2\nAI: 答 3\nHuman: 人 4\nAI: 答 5\n完。',
      '摘要這段：\nHuman: 舊摘要\nHuman: 人 6\nAI: 答 7\nHuman: 人 8\nAI: 答 9\n完。',
      '摘要這段：\nHuman: 舊摘要\nAI: 答 9\nHuman: 人 10\nAI: 答 11\nHuman: 人 12\nAI: 答 13\n完。',
    ]);
    expect(store.calls).toEqual(
      Array.from({ length: 3 }, () => [`download ${PATH}`, `upload ${PATH}`]).flat(),
    );
    expect(stamp(store.files.get(PATH)!)).toBe(
      '## Summarized at <t>\n\n舊的\n\n' +
        '## Summarized at <t>\n\nHuman: 人 0\nAI: 答 1\nHuman: 人 2\nAI: 答 3\nHuman: 人 4\nAI: 答 5\n\n' +
        '## Summarized at <t>\n\nHuman: 人 6\nAI: 答 7\nHuman: 人 8\nAI: 答 9\n\n' +
        '## Summarized at <t>\n\nAI: 答 9\nHuman: 人 10\nAI: 答 11\nHuman: 人 12\nAI: 答 13\n\n',
    );
  });

  it('session id 是建構參數：同一顆實例兩次摘要寫同一個檔', async () => {
    const { engine, store } = engineWith({ sessionId: 'session_abcd1234' });
    for (let i = 0; i < 2; i += 1) await engineStep(engine, turns(8));
    const path = '/conversation_history/session_abcd1234.md';
    expect([...store.files.keys()]).toEqual([path]);
    expect(sections(store.files.get(path))).toHaveLength(2);
  });

  it('摘要之後端點回超窗：連留下的一起重摘，只交一則摘要', async () => {
    const { engine, store } = engineWith();
    const { model, prompts } = summaryModel();
    const step = await engineStep(engine, turns(8), {
      model,
      handlerThrows: (call) => (call === 1 ? new ContextOverflowError('太長') : undefined),
    });
    expect(step.handled.map((sent) => sent.length)).toEqual([3, 1]);
    expect(step.cutoff).toBe(8);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('人 6');
    expect(sections(store.files.get(PATH))).toHaveLength(2);
  });

  it('沒到門檻卻超窗：估算倍率記在實例上，下一步照倍率判', async () => {
    const over = { trigger: [{ type: 'tokens', value: 50 }] } as const;
    const { engine } = engineWith(over);
    const model = summaryModel({ maxInputTokens: 200 }).model;
    const overflow = (call: number) => (call === 1 ? new ContextOverflowError('太長') : undefined);
    const first = await engineStep(engine, turns(4), { model, handlerThrows: overflow });
    // 照原樣送一次超窗，摘要後再送。
    expect(first.handled.map((sent) => sent.length)).toEqual([4, 3]);
    // 同一顆實例：同樣的四則這次直接摘要。
    const second = await engineStep(engine, turns(4), { model });
    expect(second.handled).toHaveLength(1);
    expect(second.cutoff).toBe(2);
    // 新的實例沒有倍率：照原樣交下去。
    const fresh = await engineStep(engineWith(over).engine, turns(4), { model });
    expect(fresh.cutoff).toBeUndefined();
    expect(fresh.handled[0]).toHaveLength(4);
  });

  it('超窗後的倍率多抓一成：估算 × (窗 ÷ 估算) × 1.1 正好是窗的 1.1 倍', async () => {
    const model = summaryModel({ maxInputTokens: 200 }).model;
    const overflow = (call: number) => (call === 1 ? new ContextOverflowError('太長') : undefined);
    /** 超窗一次之後，同一顆實例下一步的切點；沒摘要就是 `undefined`。 */
    const nextCutoff = async (fraction: number) => {
      const { engine } = engineWith({ trigger: [{ type: 'fraction', value: fraction }] });
      await engineStep(engine, turns(4), { model, handlerThrows: overflow });
      return (await engineStep(engine, turns(4), { model })).cutoff;
    };
    // 下一步估出來是窗的 1.1 倍：門檻 1.05 倍會摘要（沒有那一成就剛好等於窗），1.15 倍不會。
    expect(await nextCutoff(1.05)).toBe(2);
    expect(await nextCutoff(1.15)).toBeUndefined();
  });

  it('其他錯：原樣拋', async () => {
    const { engine } = engineWith();
    const error = new Error('503');
    await expect(engineStep(engine, turns(8), { handlerThrows: () => error })).rejects.toBe(error);
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
    // 留 2 則會落在工具結果上；往前退一則就是發出呼叫的那則（沒超過切點的一半），所以退到它。留 3 則切點本來就落在那則。
    for (const value of [2, 3]) {
      const { engine } = engineWith({ keep: { type: 'messages', value } });
      const step = await engineStep(engine, messages, { withTools: true });
      expect(step.cutoff).toBe(3);
      expect(step.sent.slice(1)).toEqual(messages.slice(3));
    }
  });

  it('token 保留量與門檻，帶工具一起估', async () => {
    const { engine } = engineWith({
      trigger: [{ type: 'tokens', value: 60 }],
      keep: { type: 'tokens', value: 30 },
    });
    const messages = turns(10, '內容'.repeat(10));
    // 門檻 60 只有連工具 schema 一起估才過（不帶工具估 59）。
    const step = await engineStep(engine, messages, { withTools: true });
    expect(step.cutoff).toBe(5);
    expect(step.sent.slice(1)).toEqual(messages.slice(5));
  });

  it('參數截斷：保留區外 write_file／edit_file 的長字串參數截成前 20 字加標記，別的工具與保留區不動', async () => {
    const big = 'x'.repeat(50);
    const cut = `${'x'.repeat(20)}...(argument truncated)`;
    const messages: BaseMessage[] = [
      new HumanMessage('寫'),
      new AIMessage({
        content: '',
        tool_calls: [{ id: 'w1', name: 'write_file', args: { file_path: '/a', content: big } }],
        additional_kwargs: { mark: 1 },
      }),
      new ToolMessage({ content: 'ok', tool_call_id: 'w1' }),
      new AIMessage({
        content: '',
        tool_calls: [
          {
            id: 'd1',
            name: 'edit_file',
            args: { file_path: '/a', old_string: 'o', new_string: big },
          },
        ],
      }),
      new ToolMessage({ content: 'ok', tool_call_id: 'd1' }),
      new AIMessage({
        content: '',
        tool_calls: [{ id: 'e1', name: 'echo', args: { message: big } }],
      }),
      new ToolMessage({ content: 'ok', tool_call_id: 'e1' }),
      // 保留區（最後一則）：同樣的長參數不截。
      new AIMessage({
        content: '',
        tool_calls: [{ id: 'w2', name: 'write_file', args: { file_path: '/b', content: big } }],
      }),
    ];
    const { engine } = engineWith({
      trigger: [],
      truncateArgsSettings: {
        trigger: { type: 'messages', value: 2 },
        keep: { type: 'messages', value: 1 },
        maxLength: 10,
      },
    });
    const step = await engineStep(engine, messages);
    expect(step.cutoff).toBeUndefined();
    const argsAt = (i: number) => (step.sent[i] as AIMessage).tool_calls?.[0]?.args;
    expect(argsAt(1)).toEqual({ file_path: '/a', content: cut });
    // 截過參數的那則是重建的：只照搬 content 與 additional_kwargs。
    expect(step.sent[1]!.additional_kwargs).toEqual({ mark: 1 });
    expect(argsAt(3)).toEqual({ file_path: '/a', old_string: 'o', new_string: cut });
    expect(argsAt(5)).toEqual({ message: big });
    expect(argsAt(7)).toEqual({ file_path: '/b', content: big });
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
    const { engine } = engineWith({
      trigger: [{ type: 'messages', value: 1 }],
      keep: { type: 'messages', value: 0 },
    });
    const { model, prompts } = summaryModel({ maxInputTokens: 2_000 });
    const step = await engineStep(engine, messages, { model });
    // 壓過就裝得下：只交一次、不生摘要。
    expect(step.handled).toHaveLength(1);
    expect(prompts).toEqual([]);
    // 唯一一則工具結果的預算：max(2000 × 0.7 − 非工具訊息與系統段 14, 1000) 個 token × 4 字元 = 5544（倍率 1）。
    expect(String(step.sent[2]!.content)).toBe(`${'大'.repeat(5_544)}\n...(result truncated)`);
  });

  it('歷史檔寫不進去：warn、摘要不帶歷史檔那句、照樣摘要', async () => {
    const { engine } = engineWith({ failWrite: true });
    const warns: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...args) => {
      warns.push(String(args[0]));
    });
    try {
      const step = await engineStep(engine, turns(8));
      expect(step.cutoff).toBe(6);
      expect(step.contents[0]).toBe('Here is a summary of the conversation to date:\n\n摘要 1');
    } finally {
      spy.mockRestore();
    }
    expect(warns).toEqual([
      `Failed to offload conversation history to ${PATH}: 寫不進去`,
      '[SummarizationMiddleware] Backend offload failed during summarization. Proceeding with summary generation.',
    ]);
  });

  it('沒有訊息：原樣交下去；沒有模型：拋錯', async () => {
    const empty = await engineStep(engineWith().engine, []);
    expect(empty.handled).toEqual([[]]);
    const { engine } = engineWith({ trigger: [{ type: 'messages', value: 1 }] });
    await expect(
      engine.wrapModelCall?.(
        {
          messages: turns(2),
          state: {},
          systemMessage: new SystemMessage('s'),
          tools: [],
        } as never,
        (async () => new AIMessage('好。')) as never,
      ),
    ).rejects.toMatchObject({
      message:
        'Summarization middleware could not resolve a model. Provide `options.model` or ensure `request.model` is present.',
    });
  });
});

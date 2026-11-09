import { HumanMessage, ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import {
  BACKGROUND_SESSION_CONFIG_KEY,
  callThreadId,
  MESSAGE_SOURCE_KWARG,
  concludeTurn,
  HUMAN_INPUT_CONFIG_KEY,
  NO_HUMAN_INPUT,
  toolCallSessionAddress,
  toolErrorOf,
  TURN_CANCEL_CONFIG_KEY,
} from '@nexus/core';
import { createEchoTool } from '@nexus/plugin-echo';
import { isHumanInputUnavailable } from '@nexus/tools';
import type { NexusTool, NexusToolResult, ToolExec } from '@nexus/tools';
import { isCommand } from '@langchain/langgraph';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { langChainToolOf, toLangChainTool, toolExecOf } from './index.js';

vi.mock('@nexus/core', async (original) => ({
  ...(await original<typeof import('@nexus/core')>()),
  concludeTurn: vi.fn(),
}));

/** 遷到 `NexusTool` 之前的 echo（`develop` `06d679ee` 的 `createEchoTool`），逐字照抄當對照組。 */
const legacyEcho = (prefix = '回聲') =>
  tool(({ message }) => `${prefix}：${message}`, {
    name: 'echo',
    description: '把收到的訊息原樣回聲，用來確認工具接線是通的。',
    schema: z.object({ message: z.string().describe('要回聲的訊息') }),
  });

const call = (args: unknown, id = 'call-1') => ({
  name: 'echo',
  args: args as Record<string, unknown>,
  id,
  type: 'tool_call' as const,
});

/** 一次呼叫的結果攤平成可比的形狀：拋的錯只留類別與訊息。 */
async function outcome(run: () => Promise<unknown>): Promise<unknown> {
  try {
    const result = await run();
    return ToolMessage.isInstance(result)
      ? { content: result.content, status: result.status, id: result.tool_call_id }
      : result;
  } catch (error) {
    return { threw: (error as Error).constructor.name, message: (error as Error).message };
  }
}

const tinyTool = (
  result: NexusToolResult,
  parameters = createEchoTool().parameters,
): NexusTool => ({
  name: 'tiny',
  description: 'd',
  parameters,
  execute: () => Promise.resolve(result),
});

describe('NexusTool 轉 LangChain 工具：echo 試點', () => {
  it('送上線的工具定義與遷移前逐字相同', () => {
    expect(JSON.stringify(convertToOpenAITool(toLangChainTool(createEchoTool())))).toBe(
      JSON.stringify(convertToOpenAITool(legacyEcho())),
    );
  });

  it.each([
    ['合格', { message: '嗨' }],
    ['錯型別', { message: 3 }],
    ['缺欄位', {}],
    ['多帶一個鍵（收下、丟掉）', { message: '嗨', extra: 1 }],
    ['不是物件', '嗨'],
    ['null', null],
  ])('驗證語意與遷移前相同：%s', async (_, args) => {
    const adapted = toLangChainTool(createEchoTool());
    const legacy = legacyEcho();
    expect(await outcome(() => adapted.invoke(call(args)))).toEqual(
      await outcome(() => legacy.invoke(call(args))),
    );
    expect(await outcome(() => adapted.invoke(args as never))).toEqual(
      await outcome(() => legacy.invoke(args as never)),
    );
  });

  it('同一個 NexusTool 每次轉出同一個實例；LangChain 的工具原樣交回', () => {
    const echo = createEchoTool();
    expect(toLangChainTool(echo)).toBe(toLangChainTool(echo));
    expect(langChainToolOf(echo)).toBe(toLangChainTool(echo));
    const legacy = legacyEcho();
    expect(langChainToolOf(legacy)).toBe(legacy);
  });

  it.each([
    ['不認得的關鍵字', { type: 'string', minLength: 1 }, /轉接器不認得的 minLength/],
    ['不認得的 type', { type: 'integer' }, /有一格轉接器不認得/],
    [
      '物件同時帶 properties 與 additionalProperties schema',
      { type: 'object', properties: {}, additionalProperties: { type: 'string' } },
      /同時帶 properties 與 additionalProperties/,
    ],
  ])('轉換器碰到%s就拋，不默默放寬', (_, message, expected) => {
    const { $schema, ...rest } = createEchoTool().parameters;
    const parameters = { $schema, ...rest, properties: { message } } as never;
    expect(() => toLangChainTool(tinyTool({ ok: true, content: '' }, parameters))).toThrow(
      expected,
    );
  });

  it('轉回去送上線的 schema 跟 parameters 不同就拋，不送另一份位元組', () => {
    const { $schema: _, ...withoutDialect } = createEchoTool().parameters;
    expect(() => toLangChainTool(tinyTool({ ok: true, content: '' }, withoutDialect))).toThrow(
      /工具 tiny 的 parameters/,
    );
  });
});

describe('驗證：寫了 additionalProperties: false 的拒，沒寫的收下丟掉', () => {
  const strictInside = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      loose: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
      strict: {
        type: 'object',
        properties: { b: { type: 'string' } },
        required: ['b'],
        additionalProperties: false,
      },
    },
    required: ['loose', 'strict'],
  };
  const seen: unknown[] = [];
  const shaped: NexusTool = {
    ...tinyTool({ ok: true, content: 'ok' }, strictInside),
    execute: (args) => {
      seen.push(args);
      return Promise.resolve({ ok: true, content: 'ok' });
    },
  };

  it('沒寫的物件多帶鍵：收下，交給本體時已丟掉', async () => {
    seen.length = 0;
    await toLangChainTool(shaped).invoke({ loose: { a: 'x', extra: 1 }, strict: { b: 'y' } });
    expect(seen).toEqual([{ loose: { a: 'x' }, strict: { b: 'y' } }]);
  });

  it('寫了 false 的物件多帶鍵：拒，本體沒被叫到', async () => {
    seen.length = 0;
    await expect(
      toLangChainTool(shaped).invoke({ loose: { a: 'x' }, strict: { b: 'y', extra: 1 } }),
    ).rejects.toThrow(/extra/);
    expect(seen).toEqual([]);
  });
});

describe('rawParameters：JSON Schema 原樣上線、原樣驗', () => {
  const booking = {
    type: 'object',
    $defs: { who: { type: 'object', properties: { email: { type: 'string', format: 'email' } } } },
    properties: {
      room: { anyOf: [{ type: 'string' }, { type: 'integer', minimum: 1 }] },
      who: { $ref: '#/$defs/who' },
    },
    required: ['room'],
  } as const;
  const seen: unknown[] = [];
  const raw = (parameters: NexusTool['parameters'], rawParameters = true): NexusTool => ({
    ...tinyTool({ ok: true, content: 'ok' }, parameters),
    rawParameters,
    execute: (args) => {
      seen.push(args);
      return Promise.resolve({ ok: true, content: 'ok' });
    },
  });

  it('送上線的就是 parameters，不補 additionalProperties；沒有 properties 的補空的', () => {
    expect(convertToOpenAITool(toLangChainTool(raw(booking))).function.parameters).toEqual(booking);
    expect(
      convertToOpenAITool(toLangChainTool(raw({ type: 'object' }))).function.parameters,
    ).toEqual({ type: 'object', properties: {} });
  });

  it('沒宣告的同一份 schema 走 zod 的轉換，碰到認不得的關鍵字就拋', () => {
    expect(() => toLangChainTool(raw(booking, false))).toThrow(/不認得的 \$defs/);
  });

  it('合格的參數原樣交給本體，沒寫 additionalProperties 的多帶鍵也留著', async () => {
    seen.length = 0;
    await toLangChainTool(raw(booking)).invoke({ room: 3, who: { email: 'a@b.c' }, extra: 1 });
    expect(seen).toEqual([{ room: 3, who: { email: 'a@b.c' }, extra: 1 }]);
  });

  it.each([
    ['缺必填', { who: {} }],
    ['anyOf 都不合', { room: 0 }],
    ['$ref 指到的型別不合', { room: 'A', who: { email: 3 } }],
  ])('不合格（%s）：拒，本體沒被叫到', async (_, args) => {
    seen.length = 0;
    await expect(toLangChainTool(raw(booking)).invoke(args)).rejects.toThrow(
      /did not match expected schema/,
    );
    expect(seen).toEqual([]);
  });
});

describe('timeoutMs：轉成基座的呼叫預算', () => {
  const stalling = (timeoutMs?: number): NexusTool => ({
    ...tinyTool({ ok: true, content: '' }),
    ...(timeoutMs !== undefined && { timeoutMs }),
    execute: (_, exec) =>
      new Promise((_resolve, reject) => {
        exec.signal?.addEventListener('abort', () => {
          reject(exec.signal?.reason as Error);
        });
      }),
  });

  it('宣告了就落在 defaultConfig.timeout，到期 exec.signal 舉起、拋 TimeoutError；送上線的不變', async () => {
    const adapted = toLangChainTool(stalling(30));
    expect(adapted.defaultConfig?.timeout).toBe(30);
    await expect(adapted.invoke(call({ message: 'x' }))).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    expect(JSON.stringify(convertToOpenAITool(adapted))).toBe(
      JSON.stringify(convertToOpenAITool(toLangChainTool(stalling()))),
    );
  });

  it('沒宣告就沒有 defaultConfig', () => {
    expect(toLangChainTool(stalling()).defaultConfig).toBeUndefined();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('%s 不是正的有限數：轉換時就拋', (ms) => {
    expect(() => toLangChainTool(stalling(ms))).toThrow(/timeoutMs/);
  });
});

describe('artifact：跟著成功的結果落到 ToolMessage，不送模型', () => {
  it('帶了就落在 artifact，內容不變；沒帶就是 undefined', async () => {
    const withArtifact = (await toLangChainTool(
      tinyTool({ ok: true, content: '文字', artifact: [{ type: 'image' }] }),
    ).invoke(call({ message: 'x' }))) as ToolMessage;
    expect([withArtifact.content, withArtifact.artifact]).toEqual(['文字', [{ type: 'image' }]]);
    const bare = (await toLangChainTool(tinyTool({ ok: true, content: '文字' })).invoke(
      call({ message: 'x' }),
    )) as ToolMessage;
    expect(bare.artifact).toBeUndefined();
  });

  it('包成 Command 時那則 ToolMessage 也帶著', async () => {
    const deferring: NexusTool = {
      ...tinyTool({ ok: true, content: '' }),
      execute: (_, exec) => {
        exec.deferContext('補');
        return Promise.resolve({ ok: true, content: '文字', artifact: [] });
      },
    };
    const result = await toLangChainTool(deferring).invoke(call({ message: 'x' }));
    const [message] = (result as { update: { messages: ToolMessage[] } }).update.messages;
    expect(message?.artifact).toEqual([]);
  });
});

describe('結果：錯誤是資料欄', () => {
  it('ok: false 轉成帶 Error: 前綴的錯誤結果，碼掛在訊息上，id 是這次呼叫的', async () => {
    const adapted = toLangChainTool(
      tinyTool({ ok: false, content: '不行', error: { name: 'SomeError', code: 'SOME_CODE' } }),
    );
    const result = (await adapted.invoke(call({ message: 'x' }, 'c-9'))) as ToolMessage;
    expect(ToolMessage.isInstance(result)).toBe(true);
    expect([result.content, result.status, result.tool_call_id, result.name]).toEqual([
      'Error: 不行',
      'error',
      'c-9',
      'tiny',
    ]);
    expect(toolErrorOf(result)).toEqual({ name: 'SomeError', code: 'SOME_CODE' });
  });

  it('ok: false 不帶碼：沒有碼', async () => {
    const adapted = toLangChainTool(tinyTool({ ok: false, content: '不行' }));
    const result = (await adapted.invoke(call({ message: 'x' }))) as ToolMessage;
    expect(result.status).toBe('error');
    expect(toolErrorOf(result)).toBeUndefined();
  });

  it('ok: true 的 content 原樣交給 LangChain（同一個 LangChain 工具回這個值）', async () => {
    const blocks = [{ type: 'text', text: '區塊' }];
    const adapted = toLangChainTool(tinyTool({ ok: true, content: blocks }));
    const legacy = tool(() => blocks, {
      name: 'tiny',
      description: 'd',
      schema: z.object({ message: z.string().describe('要回聲的訊息') }),
    });
    expect(await outcome(() => adapted.invoke(call({ message: 'x' })))).toEqual(
      await outcome(() => legacy.invoke(call({ message: 'x' }))),
    );
  });
});

describe('ToolExec：身分是資料，forCall 認得的與收呼叫設定時相同', () => {
  const configs: readonly (readonly [string, unknown])[] = [
    ['root 的工具呼叫', { configurable: { thread_id: 't1', checkpoint_ns: 'tools:a' } }],
    ['前景子代理', { configurable: { thread_id: 't1', checkpoint_ns: 'tools:p|tools:a' } }],
    [
      '背景子代理',
      {
        configurable: {
          thread_id: 't1/bg-1',
          checkpoint_ns: 'tools:a',
          [BACKGROUND_SESSION_CONFIG_KEY]: 'bg-1',
        },
      },
    ],
    [
      '背景身分鍵壞了（不退回 root）',
      {
        configurable: {
          thread_id: 't1',
          checkpoint_ns: 'tools:a',
          [BACKGROUND_SESSION_CONFIG_KEY]: '',
        },
      },
    ],
    ['不在圖裡', { configurable: { thread_id: 't1' } }],
    ['thread_id 是空字串', { configurable: { thread_id: '', checkpoint_ns: 'tools:a' } }],
    ['沒有 configurable', {}],
    ['沒有設定', undefined],
  ];

  it.each(configs)('%s', (_, config) => {
    const exec = toolExecOf('echo', config as never);
    expect(callThreadId(exec)).toBe(callThreadId(config));
    expect(toolCallSessionAddress(exec)).toEqual(toolCallSessionAddress(config));
  });

  it('callId 照呼叫設定；凍結', () => {
    const exec = toolExecOf('echo', { toolCall: call({}, 'c-2') } as never);
    expect(exec.callId).toBe('c-2');
    expect(toolExecOf('echo', undefined).callId).toBe('');
    expect(Object.isFrozen(exec)).toBe(true);
  });

  it('signal：這一輪的停止訊號（configurable 裡的）併上 LangGraph 的，任一個舉起都算', () => {
    const own = new AbortController();
    const turn = new AbortController();
    const configOf = (withOwn: boolean, withTurn: boolean): never =>
      ({
        ...(withOwn && { signal: own.signal }),
        configurable: {
          thread_id: 't',
          ...(withTurn && { [TURN_CANCEL_CONFIG_KEY]: turn.signal }),
        },
      }) as never;
    expect(toolExecOf('echo', configOf(false, false)).signal).toBeUndefined();
    expect(toolExecOf('echo', configOf(true, false)).signal).toBe(own.signal);
    expect(toolExecOf('echo', configOf(false, true)).signal).toBe(turn.signal);
    const both = toolExecOf('echo', configOf(true, true)).signal;
    expect(both?.aborted).toBe(false);
    turn.abort();
    expect(both?.aborted).toBe(true);
    const other = new AbortController();
    const both2 = toolExecOf('echo', {
      signal: other.signal,
      configurable: { [TURN_CANCEL_CONFIG_KEY]: new AbortController().signal },
    } as never).signal;
    other.abort();
    expect(both2?.aborted).toBe(true);
  });

  it('agent 形狀不對就認不出來，不退回 root', () => {
    const shaped = (agent: unknown): ToolExec =>
      ({ callId: 'c', threadId: 't', agent, signal: undefined, concludeTurn() {} }) as ToolExec;
    expect(toolCallSessionAddress(shaped({ kind: 'root' }))).toEqual({ kind: 'root' });
    expect(toolCallSessionAddress(shaped({ kind: 'subagent', runId: 'r' }))).toEqual({
      kind: 'subagent',
      runId: 'r',
    });
    for (const broken of [
      undefined,
      null,
      'root',
      { kind: 'subagent' },
      { kind: 'subagent', runId: '' },
      { kind: 'x' },
    ]) {
      expect(toolCallSessionAddress(shaped(broken))).toBeUndefined();
    }
  });

  it('工具本體拿到的 exec 就是從這次呼叫設定算的那一份；concludeTurn() 報的是自己的名字', async () => {
    let seen: ToolExec | undefined;
    const probe: NexusTool = {
      ...tinyTool({ ok: true, content: '' }),
      name: 'probe',
      execute: (_, exec) => {
        seen = exec;
        exec.concludeTurn();
        return Promise.resolve({ ok: true, content: '' });
      },
    };
    await toLangChainTool(probe).invoke(call({ message: 'x' }, 'c-3'), {
      configurable: { thread_id: 't9', checkpoint_ns: 'tools:p|tools:a' },
    });
    expect([seen?.callId, seen?.threadId, seen?.agent]).toEqual([
      'c-3',
      't9',
      { kind: 'subagent', runId: 'tools:p' },
    ]);
    expect(vi.mocked(concludeTurn)).toHaveBeenCalledWith('probe');
  });

  it('宣告了 concludesTurn 的才帶 returnDirect：基座的路由只認這個靜態名單', () => {
    const plain = tinyTool({ ok: true, content: '' });
    expect(toLangChainTool(plain).returnDirect).toBe(false);
    expect(toLangChainTool({ ...plain, concludesTurn: false }).returnDirect).toBe(false);
    expect(toLangChainTool({ ...plain, concludesTurn: true }).returnDirect).toBe(true);
  });
});

describe('deferContext：結果之後補一則插件來源的人話', () => {
  const deferring = (ok: boolean): NexusTool => ({
    ...tinyTool({ ok: true, content: '' }),
    name: 'defer',
    execute: (_, exec) => {
      exec.deferContext('收尾', { mark: { action: 'complete' } });
      exec.deferContext('第二則');
      return Promise.resolve(
        ok ? { ok: true, content: '{"x":1}' } : { ok: false, content: '不行' },
      );
    },
  });

  it('成功：包成 Command，工具結果不帶 status、帶這次的 id，記號在前、來源在後，照呼叫順序', async () => {
    const result = await toLangChainTool(deferring(true)).invoke(call({ message: 'x' }, 'c-5'));
    expect(isCommand(result)).toBe(true);
    const messages = (result as { update: { messages: unknown[] } }).update.messages;
    expect(messages).toHaveLength(3);
    const [first, second, third] = messages as [ToolMessage, HumanMessage, HumanMessage];
    expect(ToolMessage.isInstance(first)).toBe(true);
    expect([first.content, first.tool_call_id, first.name, first.status]).toEqual([
      '{"x":1}',
      'c-5',
      'defer',
      undefined,
    ]);
    expect([second.content, Object.keys(second.additional_kwargs)]).toEqual([
      '收尾',
      ['mark', MESSAGE_SOURCE_KWARG],
    ]);
    expect(second.additional_kwargs[MESSAGE_SOURCE_KWARG]).toEqual({
      kind: 'plugin',
      plugin: 'defer',
    });
    expect(third.content).toBe('第二則');
  });

  it('失敗：不補，照一般拒絕', async () => {
    const result = (await toLangChainTool(deferring(false)).invoke(
      call({ message: 'x' }),
    )) as ToolMessage;
    expect([ToolMessage.isInstance(result), result.status]).toEqual([true, 'error']);
  });

  it('沒有 tool_call_id 卻要補：拋，不靜靜退回一句話', async () => {
    await expect(toLangChainTool(deferring(true)).invoke({ message: 'x' })).rejects.toThrow(
      /沒有 tool_call_id/,
    );
  });
});

describe('interrupt：讀得到等人服務就問它，否則 LangGraph 的 interrupt()', () => {
  it('config 上放的是「這裡沒人可問」：以 HumanInputUnavailable 拒絕，不退回 interrupt()', async () => {
    const execOf = toolExecOf('ask', { configurable: { [HUMAN_INPUT_CONFIG_KEY]: NO_HUMAN_INPUT } });
    await expect(execOf.interrupt({ q: 1 })).rejects.toSatisfy(isHumanInputUnavailable);
  });

  it('config 上有等人服務：問它、拿它的答覆，本體不重跑', async () => {
    const runs: unknown[] = [];
    const asking: NexusTool = {
      ...tinyTool({ ok: true, content: '' }),
      name: 'ask',
      execute: async (_, exec) => {
        runs.push('run');
        return { ok: true, content: String(await exec.interrupt({ q: 1 })) };
      },
    };
    const asked: unknown[] = [];
    const service = {
      ask: (value: unknown) => {
        asked.push(value);
        return Promise.resolve('A');
      },
      idle: <T>(waiting: Promise<T>) => waiting,
      onResumed: () => () => {},
    };
    const message = await toLangChainTool(asking).invoke(call({ message: 'x' }), {
      configurable: { [HUMAN_INPUT_CONFIG_KEY]: service },
    });

    expect(asked).toEqual([{ q: 1 }]);
    expect(runs).toEqual(['run']);
    expect(JSON.stringify(message)).toContain('"content":"A"');
  });

  it('不在圖裡呼叫就照 LangGraph 拋，不吞掉', async () => {
    const asking: NexusTool = {
      ...tinyTool({ ok: true, content: '' }),
      name: 'ask',
      execute: async (_, exec) => ({ ok: true, content: String(await exec.interrupt({ q: 1 })) }),
    };
    await expect(toLangChainTool(asking).invoke(call({ message: 'x' }))).rejects.toThrow();
  });
});

import { ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import {
  BACKGROUND_SESSION_CONFIG_KEY,
  callThreadId,
  concludeTurn,
  toolCallSessionAddress,
  toolErrorOf,
  TURN_CANCEL_CONFIG_KEY,
} from '@nexus/core';
import { createEchoTool } from '@nexus/plugin-echo';
import type { NexusTool, NexusToolResult, ToolExec } from '@nexus/tools';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { langChainToolOf, toLangChainTool, toolExecOf } from './nexus-tool-adapter.js';

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

  it('轉回去送上線的 schema 跟 parameters 不同就拋，不送另一份位元組', () => {
    const { $schema: _, ...withoutDialect } = createEchoTool().parameters;
    expect(() => toLangChainTool(tinyTool({ ok: true, content: '' }, withoutDialect))).toThrow(
      /工具 tiny 的 parameters/,
    );
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
});

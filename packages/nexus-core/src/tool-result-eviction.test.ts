/**
 * 80k 搬移那一格對著真的基座逐字比（[#2415](https://github.com/DemianLi/nexus-agent/issues/2415) W3）：同一個請求、同一個
 * handler 結果，各交給基座 `FilesystemMiddleware` 的 `wrapToolCall` 與 {@link toolResultEvictionWrap}，比換出來的那則與寫進
 * backend 的路徑和位元組。升級基座時字變了就紅在這裡。
 */

import { createHash } from 'node:crypto';

import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { Command, isCommand } from '@langchain/langgraph';
import { createFilesystemMiddleware } from 'deepagents';
import { describe, expect, it } from 'vitest';

import {
  evictedToolResultText,
  stringifyToolContent,
  TOOL_RESULT_EVICTION_THRESHOLD_CHARS,
  toolResultEvictionPath,
  toolResultEvictionWrap,
} from './tool-result-eviction.js';

interface Written {
  readonly path: string;
  readonly sha256: string;
}

/** 記下每次 `write` 的 backend；`fail` 時回錯誤，`filesUpdate` 時像以 runtime 建的 `StateBackend` 那樣回 `filesUpdate`。 */
function recordingBackend(mode: 'plain' | 'filesUpdate' | 'fail'): {
  readonly backend: object;
  readonly written: Written[];
} {
  const written: Written[] = [];
  const backend = {
    ls: async () => [],
    read: async () => '',
    readRaw: async () => ({ content: [], created_at: '', modified_at: '' }),
    glob: async () => [],
    grep: async () => [],
    edit: async () => ({}),
    write: async (path: string, content: string) => {
      written.push({ path, sha256: createHash('sha256').update(content).digest('hex') });
      if (mode === 'fail') return { error: `disk full at ${path}` };
      if (mode === 'filesUpdate')
        return { path, filesUpdate: { [path]: { size: content.length } } };
      return { path, filesUpdate: null };
    },
  };
  return { backend, written };
}

/** 結果攤成可比的形狀：`ToolMessage` 取建構子收的那幾格，`Command` 取 `update`。 */
function shape(result: unknown): unknown {
  if (ToolMessage.isInstance(result)) {
    return {
      kind: 'tool',
      content: result.content,
      tool_call_id: result.tool_call_id,
      name: result.name,
      id: result.id,
      artifact: result.artifact,
      status: result.status,
      metadata: result.metadata,
      additional_kwargs: result.additional_kwargs,
      response_metadata: result.response_metadata,
    };
  }
  if (isCommand(result)) {
    const update = result.update as { messages?: unknown[]; [key: string]: unknown };
    return {
      kind: 'command',
      update: { ...update, messages: update.messages?.map(shape) },
      goto: result.goto,
      graph: result.graph,
    };
  }
  if (AIMessage.isInstance(result)) return { kind: 'ai', content: result.content };
  return result;
}

interface Case {
  readonly toolName: string;
  readonly requestId?: string;
  readonly result: () => unknown;
  readonly mode?: 'plain' | 'filesUpdate' | 'fail';
}

/** 同一個案例各跑一次基座與 core，回兩邊的結果形狀、寫入紀錄，與 core 是否原樣交回 handler 的那一個。 */
async function both(c: Case) {
  const run = async (wrap: (request: never, handler: never) => Promise<unknown>) => {
    const { written } = recorder;
    written.length = 0;
    const produced = c.result();
    const request = {
      toolCall: { name: c.toolName, id: c.requestId, args: {} },
      state: { messages: [] },
      runtime: {},
    };
    const out = await wrap(request as never, (async () => produced) as never);
    return { shape: shape(out), written: [...written], same: out === produced };
  };
  const recorder = recordingBackend(c.mode ?? 'plain');
  const base = createFilesystemMiddleware({ backend: recorder.backend as never });
  const baseWrap = base.wrapToolCall as unknown as (r: never, h: never) => Promise<unknown>;
  const fromBase = await run(baseWrap);
  const fromCore = await run(
    toolResultEvictionWrap(recorder.backend) as unknown as (r: never, h: never) => Promise<unknown>,
  );
  return { fromBase, fromCore };
}

const big = (prefix: string, lines = 40) =>
  Array.from(
    { length: lines },
    (_, i) => `${prefix} ${i} ${'x'.repeat(TOOL_RESULT_EVICTION_THRESHOLD_CHARS / lines)}`,
  ).join('\n');

const tool = (content: ToolMessage['content'], extra: Record<string, unknown> = {}) =>
  new ToolMessage({ content, tool_call_id: 'call.a/b\\c', name: 'execute', id: 'm1', ...extra });

const cases: Record<string, Case> = {
  沒過門檻的原樣交回: { toolName: 'execute', result: () => tool('small') },
  剛好等於門檻的不搬: {
    toolName: 'execute',
    result: () => tool('y'.repeat(TOOL_RESULT_EVICTION_THRESHOLD_CHARS)),
  },
  'execute 過門檻：搬走、換預覽': { toolName: 'execute', result: () => tool(big('line')) },
  '回 filesUpdate 的 backend：包成 Command': {
    toolName: 'execute',
    mode: 'filesUpdate',
    result: () =>
      tool(big('line'), {
        artifact: { a: 1 },
        status: 'success',
        metadata: { m: 1 },
        additional_kwargs: { k: 1 },
        response_metadata: { r: 1 },
      }),
  },
  'read_file 超過 80k：請求名在不搬名單，不看結果': {
    toolName: 'read_file',
    result: () => tool(big('line'), { name: 'read_file' }),
  },
  '請求名不在名單、結果名在名單：照結果名不搬': {
    toolName: 'mcp_x',
    result: () => tool(big('line'), { name: 'grep' }),
  },
  '寫不進去：換成存不進去那句': {
    toolName: 'execute',
    mode: 'fail',
    result: () => tool(big('line')),
  },
  "內容帶 $& 與 $'：照 String.replace 的樣式展開": {
    toolName: 'execute',
    result: () => tool(`$& head $' $\` $$ $1\n${big('tail $&')}`),
  },
  路徑用請求上的呼叫編號: {
    toolName: 'execute',
    requestId: 'req.1/2',
    result: () => tool(big('line')),
  },
  '十行以內：不切中間，結尾空行照留': {
    toolName: 'execute',
    result: () => tool(`${'z'.repeat(TOOL_RESULT_EVICTION_THRESHOLD_CHARS)}\n\n`),
  },
  '區塊內容：文字取 text、其他 JSON': {
    toolName: 'execute',
    result: () =>
      tool([
        { type: 'text', text: big('blk', 12) },
        { type: 'image_url', image_url: { url: 'data:x' } },
      ]),
  },
  'task 回 Command：逐則換，非工具訊息原樣': {
    toolName: 'task',
    mode: 'filesUpdate',
    result: () =>
      new Command({
        update: {
          files: { '/keep': { size: 1 } },
          messages: [
            tool(big('sub'), { name: 'task', tool_call_id: 't1' }),
            new AIMessage('aside'),
          ],
          todos: ['kept'],
        },
      }),
  },
  'task 回 Command、都沒過門檻：交回原來那個': {
    toolName: 'task',
    mode: 'filesUpdate',
    result: () => new Command({ update: { messages: [tool('tiny', { name: 'task' })] } }),
  },
  'task 回 Command、plain backend：搬了但沒有 filesUpdate，交回原來那個': {
    toolName: 'task',
    result: () => new Command({ update: { messages: [tool(big('sub'), { name: 'task' })] } }),
  },
  '沒有 messages 的 Command 原樣': {
    toolName: 'task',
    result: () => new Command({ update: { todos: [] } }),
  },
  '不是訊息也不是 Command 的原樣': { toolName: 'execute', result: () => 'raw' },
};

describe('toolResultEvictionWrap 對著基座的 wrapToolCall', () => {
  for (const [title, c] of Object.entries(cases)) {
    it(title, async () => {
      const { fromBase, fromCore } = await both(c);
      expect(fromCore.shape).toEqual(fromBase.shape);
      expect(fromCore.written).toEqual(fromBase.written);
      expect(fromCore.same).toBe(fromBase.same);
    });
  }

  it('有搬的案例真的搬了：比對不是兩邊都沒動', async () => {
    const { fromCore } = await both(cases['execute 過門檻：搬走、換預覽']!);
    expect(fromCore.written).toEqual([
      expect.objectContaining({ path: '/large_tool_results/call_a_b_c.txt' }),
    ]);
    expect(fromCore.same).toBe(false);
  });
});

describe('toolResultEvictionPath', () => {
  it('不搬名單、門檻、路徑的 sanitize', () => {
    const content = 'x'.repeat(TOOL_RESULT_EVICTION_THRESHOLD_CHARS + 1);
    expect(toolResultEvictionPath({ name: 'ls', content, tool_call_id: 'a' })).toBeUndefined();
    expect(
      toolResultEvictionPath({ name: 'execute', content: 'x', tool_call_id: 'a' }),
    ).toBeUndefined();
    expect(toolResultEvictionPath({ name: '', content, tool_call_id: 'a.b' })).toBe(
      '/large_tool_results/a_b.txt',
    );
    expect(toolResultEvictionPath({ content, tool_call_id: 'a' }, 'r/1')).toBe(
      '/large_tool_results/r_1.txt',
    );
  });

  it('evictedToolResultText 就是基座換上的那段', async () => {
    const text = big('line');
    const { fromBase } = await both({ toolName: 'execute', result: () => tool(text) });
    expect((fromBase.shape as { content: string }).content).toBe(
      evictedToolResultText(
        stringifyToolContent(text),
        'call.a/b\\c',
        '/large_tool_results/call_a_b_c.txt',
      ),
    );
  });
});

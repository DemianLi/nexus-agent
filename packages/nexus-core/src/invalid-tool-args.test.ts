/**
 * 解不開的工具參數：改寫與拒絕兩條規則本身（[#281](https://github.com/DemianLi/nexus-agent/issues/281)）。
 *
 * 這一份用手搭的訊息量規則；真的 `ChatOpenAI` 產出的形狀、兩條產品路徑與核准、子代理，量在
 * `apps/harness/src/invalid-tool-args.test.ts`。
 */

import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createInvalidArgumentsCarrier,
  createInvalidToolArgsMiddleware,
  INVALID_ARGUMENTS_REFUSAL,
  repairInvalidToolCalls,
} from './invalid-tool-args.js';
import { INVALID_ARGS, toolErrorOf } from './tool-events.js';

const RAW = '{"text": 嗨}';

/**
 * CLI 那條（非串流 `_generate`）的形狀，照 `@langchain/openai` 的轉換器：原字串留在
 * `additional_kwargs.tool_calls`，解不開的那顆在 `invalid_tool_calls`，`tool_calls` 是空的。
 */
function cliShape(raw: string = RAW): AIMessage {
  return new AIMessage({
    content: '',
    additional_kwargs: {
      tool_calls: [
        { id: 'call_bad', type: 'function', function: { name: 'echo', arguments: raw } },
      ],
    },
    tool_calls: [],
    invalid_tool_calls: [
      {
        id: 'call_bad',
        name: 'echo',
        args: raw,
        error: 'Malformed args.',
        type: 'invalid_tool_call',
      },
    ],
  });
}

/** v3 那條（`streamEvents`）的形狀：只有一個 `invalid_tool_call` content block，兩個欄位都是空的。 */
function v3Shape(raw: string = RAW): AIMessage {
  return new AIMessage({
    content: [
      { type: 'text', text: '我來叫。' },
      {
        type: 'invalid_tool_call',
        id: 'call_bad',
        name: 'echo',
        args: raw,
        error: 'Malformed args.',
      },
    ] as never,
    response_metadata: { output_version: 'v1' },
  });
}

describe('改寫：解不開的那顆變成參數 {} 的正常呼叫', () => {
  it('CLI 那條：清掉 invalid_tool_calls 與 additional_kwargs.tool_calls，原字串進載體', () => {
    const carrier = createInvalidArgumentsCarrier();
    const repaired = repairInvalidToolCalls(cliShape(), carrier);
    expect(repaired.tool_calls).toEqual([
      { id: 'call_bad', name: 'echo', args: {}, type: 'tool_call' },
    ]);
    expect(repaired.invalid_tool_calls).toEqual([]);
    expect(repaired.additional_kwargs.tool_calls).toBeUndefined();
    expect(carrier.rawOf('call_bad')).toBe(RAW);
  });

  it('v3 那條：拿掉 content block，文字留著，建構子補上 tool_call block', () => {
    const carrier = createInvalidArgumentsCarrier();
    const repaired = repairInvalidToolCalls(v3Shape(), carrier);
    expect(repaired.tool_calls).toEqual([
      { id: 'call_bad', name: 'echo', args: {}, type: 'tool_call' },
    ]);
    const types = repaired.contentBlocks.map((block) => block.type);
    expect(types).not.toContain('invalid_tool_call');
    expect(types).toEqual(['text', 'tool_call']);
    expect(carrier.rawOf('call_bad')).toBe(RAW);
  });

  it('截斷的 JSON 同樣處理，原字串一字不改', () => {
    const truncated = '{"text": "嗨';
    const carrier = createInvalidArgumentsCarrier();
    repairInvalidToolCalls(cliShape(truncated), carrier);
    expect(carrier.rawOf('call_bad')).toBe(truncated);
  });

  it('同一批裡合法的那顆留著，壞的那顆接在後面', () => {
    const message = new AIMessage({
      content: '',
      tool_calls: [{ id: 'call_ok', name: 'echo', args: { text: '好' }, type: 'tool_call' }],
      invalid_tool_calls: [
        { id: 'call_bad', name: 'echo', args: RAW, error: 'x', type: 'invalid_tool_call' },
      ],
    });
    const repaired = repairInvalidToolCalls(message, createInvalidArgumentsCarrier());
    expect(repaired.tool_calls?.map((call) => [call.id, call.args])).toEqual([
      ['call_ok', { text: '好' }],
      ['call_bad', {}],
    ]);
  });

  it('沒有解不開的就原樣回同一則，載體不動', () => {
    const carrier = createInvalidArgumentsCarrier();
    const message = new AIMessage({
      content: '好',
      tool_calls: [{ id: 'call_ok', name: 'echo', args: { text: '好' }, type: 'tool_call' }],
    });
    expect(repairInvalidToolCalls(message, carrier)).toBe(message);
    expect(carrier.rawOf('call_ok')).toBeUndefined();
  });

  it('沒有 id 的那顆不動：配不起 tool 訊息', () => {
    const message = new AIMessage({
      content: '',
      invalid_tool_calls: [{ name: 'echo', args: RAW, error: 'x', type: 'invalid_tool_call' }],
    });
    expect(repairInvalidToolCalls(message, createInvalidArgumentsCarrier())).toBe(message);
  });
});

describe('拒絕：照常派發，工具換成同名的樁', () => {
  /** 本體被叫到就記一筆。 */
  function countingEcho() {
    const calls: unknown[] = [];
    const echo = tool(
      (args: { text: string }) => {
        calls.push(args);
        return `回聲：${args.text}`;
      },
      { name: 'echo', description: '回聲。', schema: z.object({ text: z.string() }) },
    );
    return { echo, calls };
  }

  /** 照 ToolNode 的 `baseHandler`：優先用 request 上的工具，以 `ToolCall` 形式 invoke。 */
  async function baseHandler(request: {
    toolCall: { id?: string; name: string; args: unknown };
    tool?: unknown;
  }): Promise<unknown> {
    const target = request.tool as { invoke: (input: unknown) => Promise<unknown> };
    return target.invoke({ ...request.toolCall, type: 'tool_call' });
  }

  function wrap(carrier = createInvalidArgumentsCarrier()) {
    const middleware = createInvalidToolArgsMiddleware(carrier) as unknown as {
      wrapToolCall: (request: unknown, handler: typeof baseHandler) => Promise<unknown>;
    };
    return { carrier, wrapToolCall: middleware.wrapToolCall };
  }

  it('載體裡有的那顆：回 dsh 那句、碼 INVALID_ARGS，本體零次', async () => {
    const { echo, calls } = countingEcho();
    const { carrier, wrapToolCall } = wrap();
    carrier.remember('call_bad', RAW);
    const result = await wrapToolCall(
      { toolCall: { id: 'call_bad', name: 'echo', args: {} }, tool: echo },
      baseHandler,
    );
    expect(ToolMessage.isInstance(result)).toBe(true);
    const message = result as ToolMessage;
    expect(message.content).toBe(INVALID_ARGUMENTS_REFUSAL);
    expect(message.status).toBe('error');
    expect(message.tool_call_id).toBe('call_bad');
    expect(message.name).toBe('echo');
    expect(toolErrorOf(message)).toEqual({ name: 'ToolArgsError', code: INVALID_ARGS });
    expect(calls).toEqual([]);
  });

  it('樁收到的參數是歷史裡的 {}，不是原字串（v3 串流轉換器會 JSON.parse 它）', async () => {
    const { echo } = countingEcho();
    const { carrier, wrapToolCall } = wrap();
    carrier.remember('call_bad', RAW);
    let seen: unknown;
    await wrapToolCall(
      { toolCall: { id: 'call_bad', name: 'echo', args: {} }, tool: echo },
      async (request) => {
        seen = request.toolCall.args;
        return baseHandler(request);
      },
    );
    expect(seen).toEqual({});
  });

  it('載體裡沒有的照常執行，request 原樣交下去', async () => {
    const { echo, calls } = countingEcho();
    const { wrapToolCall } = wrap();
    const request = { toolCall: { id: 'call_ok', name: 'echo', args: { text: '好' } }, tool: echo };
    let handed: unknown;
    await wrapToolCall(request, async (next) => {
      handed = next;
      return baseHandler(next);
    });
    expect(handed).toBe(request);
    expect(calls).toEqual([{ text: '好' }]);
  });

  it('未知工具不換樁：交給基座回「沒有這顆工具」', async () => {
    const { carrier, wrapToolCall } = wrap();
    carrier.remember('call_bad', RAW);
    const request = { toolCall: { id: 'call_bad', name: 'nope', args: {} }, tool: undefined };
    let handed: unknown;
    await wrapToolCall(request, async (next) => {
      handed = next;
      return 'base';
    });
    expect(handed).toBe(request);
  });
});

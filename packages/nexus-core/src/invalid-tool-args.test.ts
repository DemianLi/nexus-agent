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
  createInvalidToolArgsMiddleware,
  INVALID_ARGUMENTS_KEY,
  INVALID_ARGUMENTS_REFUSAL,
  rawArgumentsOf,
  repairInvalidToolCalls,
} from './invalid-tool-args.js';
import { fromLoggedMessage, toLoggedMessage } from './logged-message.js';
import { INVALID_ARGS, markToolError, toolErrorOf, UNKNOWN_TOOL } from './tool-events.js';

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
  it('CLI 那條：清掉 invalid_tool_calls 與 additional_kwargs.tool_calls，原字串記在訊息的 additional_kwargs 上', () => {
    const repaired = repairInvalidToolCalls(cliShape());
    expect(repaired.tool_calls).toEqual([
      { id: 'call_bad', name: 'echo', args: {}, type: 'tool_call' },
    ]);
    expect(repaired.invalid_tool_calls).toEqual([]);
    expect(repaired.additional_kwargs.tool_calls).toBeUndefined();
    expect(repaired.additional_kwargs[INVALID_ARGUMENTS_KEY]).toEqual({ call_bad: RAW });
  });

  it('v3 那條：拿掉 content block，文字留著，建構子補上 tool_call block', () => {
    const repaired = repairInvalidToolCalls(v3Shape());
    expect(repaired.tool_calls).toEqual([
      { id: 'call_bad', name: 'echo', args: {}, type: 'tool_call' },
    ]);
    const types = repaired.contentBlocks.map((block) => block.type);
    expect(types).not.toContain('invalid_tool_call');
    expect(types).toEqual(['text', 'tool_call']);
    expect(repaired.additional_kwargs[INVALID_ARGUMENTS_KEY]).toEqual({ call_bad: RAW });
  });

  it('截斷的 JSON 同樣處理，原字串一字不改', () => {
    const truncated = '{"text": "嗨';
    const repaired = repairInvalidToolCalls(cliShape(truncated));
    expect(repaired.additional_kwargs[INVALID_ARGUMENTS_KEY]).toEqual({ call_bad: truncated });
  });

  it('同一批裡合法的那顆留著，壞的那顆接在後面', () => {
    const message = new AIMessage({
      content: '',
      tool_calls: [{ id: 'call_ok', name: 'echo', args: { text: '好' }, type: 'tool_call' }],
      invalid_tool_calls: [
        { id: 'call_bad', name: 'echo', args: RAW, error: 'x', type: 'invalid_tool_call' },
      ],
    });
    const repaired = repairInvalidToolCalls(message);
    expect(repaired.tool_calls?.map((call) => [call.id, call.args])).toEqual([
      ['call_ok', { text: '好' }],
      ['call_bad', {}],
    ]);
  });

  it('沒有解不開的就原樣回同一則，不加記號', () => {
    const message = new AIMessage({
      content: '好',
      tool_calls: [{ id: 'call_ok', name: 'echo', args: { text: '好' }, type: 'tool_call' }],
    });
    expect(repairInvalidToolCalls(message)).toBe(message);
    expect(message.additional_kwargs[INVALID_ARGUMENTS_KEY]).toBeUndefined();
  });

  it('沒有 id 的那顆不動：配不起 tool 訊息', () => {
    const message = new AIMessage({
      content: '',
      invalid_tool_calls: [{ name: 'echo', args: RAW, error: 'x', type: 'invalid_tool_call' }],
    });
    expect(repairInvalidToolCalls(message)).toBe(message);
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

  function wrap() {
    const middleware = createInvalidToolArgsMiddleware() as unknown as {
      wrapToolCall: (request: unknown, handler: typeof baseHandler) => Promise<unknown>;
    };
    return { wrapToolCall: middleware.wrapToolCall };
  }

  /** ToolNode 執行時 `request.state` 的樣子：改寫過的那則 AI 訊息在尾巴。 */
  const badState = () => ({ messages: [repairInvalidToolCalls(cliShape())] });

  it('訊息上有記號的那顆：回 dsh 那句、碼 INVALID_ARGS，本體零次', async () => {
    const { echo, calls } = countingEcho();
    const { wrapToolCall } = wrap();
    const result = await wrapToolCall(
      { toolCall: { id: 'call_bad', name: 'echo', args: {} }, tool: echo, state: badState() },
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
    const { wrapToolCall } = wrap();
    let seen: unknown;
    await wrapToolCall(
      { toolCall: { id: 'call_bad', name: 'echo', args: {} }, tool: echo, state: badState() },
      async (request) => {
        seen = request.toolCall.args;
        return baseHandler(request);
      },
    );
    expect(seen).toEqual({});
  });

  it('沒有記號的照常執行，request 原樣交下去', async () => {
    const { echo, calls } = countingEcho();
    const { wrapToolCall } = wrap();
    const request = {
      toolCall: { id: 'call_ok', name: 'echo', args: { text: '好' } },
      tool: echo,
      state: { messages: [okMessage('call_ok')] },
    };
    let handed: unknown;
    await wrapToolCall(request, async (next) => {
      handed = next;
      return baseHandler(next);
    });
    expect(handed).toBe(request);
    expect(calls).toEqual([{ text: '好' }]);
  });

  it('未知工具不換樁：交給基座回「沒有這顆工具」', async () => {
    const { wrapToolCall } = wrap();
    const request = {
      toolCall: { id: 'call_bad', name: 'nope', args: {} },
      tool: undefined,
      state: badState(),
    };
    let handed: unknown;
    await wrapToolCall(request, async (next) => {
      handed = next;
      return 'base';
    });
    expect(handed).toBe(request);
  });
});

/**
 * 未知工具的碼在這一層標（[#1024](https://github.com/DemianLi/nexus-agent/issues/1024)）：交到這裡時還沒有工具的
 * 那次，基座回的錯誤標 `UNKNOWN_TOOL`；有工具的、成功的、已經有碼的都不動。
 */
describe('未知工具：基座回的錯誤在這一層標 UNKNOWN_TOOL', () => {
  const wrapToolCall = (
    createInvalidToolArgsMiddleware() as unknown as {
      wrapToolCall: (request: unknown, handler: () => Promise<unknown>) => Promise<unknown>;
    }
  ).wrapToolCall;
  const notFound = () =>
    new ToolMessage({
      content: 'Error: nope is not a valid tool',
      tool_call_id: 'call_1',
      name: 'nope',
      status: 'error',
    });
  const request = (tool: unknown) => ({
    toolCall: { id: 'call_1', name: 'nope', args: {} },
    tool,
    state: { messages: [okMessage('call_1')] },
  });

  it('交到這裡時沒有工具、基座回了錯誤 → UNKNOWN_TOOL，回的是同一則', async () => {
    const message = notFound();
    const result = await wrapToolCall(request(undefined), async () => message);
    expect(result).toBe(message);
    expect(toolErrorOf(result)).toEqual({ name: 'ToolNotFoundError', code: UNKNOWN_TOOL });
  });

  it('有工具：本體回的沒碼錯誤不標', async () => {
    const result = await wrapToolCall(request({ name: 'nope' }), async () => notFound());
    expect(toolErrorOf(result)).toBeUndefined();
  });

  it('沒有工具但結果是成功的：不標', async () => {
    const ok = new ToolMessage({ content: '好', tool_call_id: 'call_1' });
    expect(toolErrorOf(await wrapToolCall(request(undefined), async () => ok))).toBeUndefined();
  });

  it('沒有工具、結果已經有碼：原碼不被蓋掉', async () => {
    const coded = markToolError(notFound(), { name: 'AbortError', code: 'ABORTED' });
    const result = await wrapToolCall(request(undefined), async () => coded);
    expect(toolErrorOf(result)).toEqual({ name: 'AbortError', code: 'ABORTED' });
  });
});

/** 一則帶合法呼叫的 AI 訊息。 */
function okMessage(id: string): AIMessage {
  return new AIMessage({
    content: '',
    tool_calls: [{ id, name: 'echo', args: { text: '好' }, type: 'tool_call' }],
  });
}

describe('rawArgumentsOf：從 request.state 讀記號', () => {
  const request = (state: unknown, id: string | null = 'call_bad') => ({
    toolCall: id === null ? {} : { id },
    state,
  });

  it('找得到帶這個 callId 的那則，讀出原字串', () => {
    const state = { messages: [repairInvalidToolCalls(cliShape())] };
    expect(rawArgumentsOf(request(state))).toBe(RAW);
  });

  it('供應商重用 callId：最近那則說了算，上一則的記號不會讓這一顆被拒', () => {
    const state = { messages: [repairInvalidToolCalls(cliShape()), okMessage('call_bad')] };
    expect(rawArgumentsOf(request(state))).toBeUndefined();
  });

  it('同一批裡別顆的記號不外溢到合法的那顆', () => {
    const batch = repairInvalidToolCalls(
      new AIMessage({
        content: '',
        tool_calls: [{ id: 'call_ok', name: 'echo', args: { text: '好' }, type: 'tool_call' }],
        invalid_tool_calls: [
          { id: 'call_bad', name: 'echo', args: RAW, error: 'x', type: 'invalid_tool_call' },
        ],
      }),
    );
    const state = { messages: [batch] };
    expect(rawArgumentsOf(request(state, 'call_bad'))).toBe(RAW);
    expect(rawArgumentsOf(request(state, 'call_ok'))).toBeUndefined();
  });

  it('沒有 state、沒有 callId、找不到那則：undefined，不拋', () => {
    expect(rawArgumentsOf(request(undefined))).toBeUndefined();
    expect(rawArgumentsOf(request({}))).toBeUndefined();
    expect(rawArgumentsOf(request({ messages: [] }))).toBeUndefined();
    expect(
      rawArgumentsOf(request({ messages: [repairInvalidToolCalls(cliShape())] }, null)),
    ).toBeUndefined();
    expect(rawArgumentsOf(request({ messages: [null, 'x', {}] }))).toBeUndefined();
  });

  it('記號撐得過日誌來回：toLoggedMessage → fromLoggedMessage 之後還讀得到', () => {
    const logged = toLoggedMessage(repairInvalidToolCalls(cliShape()));
    const back = fromLoggedMessage(logged);
    expect(rawArgumentsOf(request({ messages: [back] }))).toBe(RAW);
  });
});

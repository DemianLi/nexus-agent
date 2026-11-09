/**
 * 宿主頁工具的上限與形狀（[#2374](https://github.com/DemianLi/nexus-agent/issues/2374)）：每個上限各量剛好在上限的與多一個的；reducer 怎麼收 `hostCalls` 也在這裡。
 * 接到 serve 的那一段在 `apps/harness/src/host-tools-wire.test.ts`。
 */

import { describe, expect, it } from 'vitest';

import { emptyConversation, reduceConversation, settleHostCall } from './conversation.js';
import {
  HOST_TOOL_LIMITS,
  hostToolResponseProblem,
  hostToolResultProblem,
  hostToolsProblem,
} from './host-tools.js';
import type { HostToolDeclaration } from './host-tools.js';
import type { Event } from './index.js';

const tool = (overrides: Partial<HostToolDeclaration> = {}): HostToolDeclaration => ({
  name: 'focus_device',
  description: '轉到設備',
  parameters: { type: 'object', properties: { id: { type: 'string' } } },
  ...overrides,
});

/** 說明是空字串的參數 schema 序列化後幾個位元組。 */
const EMPTY = JSON.stringify({ type: 'object', description: '' }).length;

/** `JSON.stringify` 之後恰好 `bytes` 個 UTF-8 位元組的參數 schema。 */
function parametersOfBytes(bytes: number): HostToolDeclaration['parameters'] {
  return { type: 'object', description: 'a'.repeat(bytes - EMPTY) };
}

describe('hostToolsProblem', () => {
  it('合格的回 undefined', () => {
    expect(hostToolsProblem([tool()])).toBeUndefined();
    expect(hostToolsProblem([])).toBeUndefined();
  });

  it(`每輪 ${String(HOST_TOOL_LIMITS.tools)} 支收、多一支拒`, () => {
    const many = (count: number) =>
      Array.from({ length: count }, (_, index) => tool({ name: `t_${String(index)}` }));
    expect(hostToolsProblem(many(HOST_TOOL_LIMITS.tools))).toBeUndefined();
    expect(hostToolsProblem(many(HOST_TOOL_LIMITS.tools + 1))).toMatch(/最多 8 支/u);
  });

  it('名字 32 個字收、33 個字拒；開頭要是小寫字母；不能重名', () => {
    expect(hostToolsProblem([tool({ name: `a${'b'.repeat(31)}` })])).toBeUndefined();
    expect(hostToolsProblem([tool({ name: `a${'b'.repeat(32)}` })])).toMatch(/name/u);
    expect(hostToolsProblem([tool({ name: '1abc' })])).toMatch(/name/u);
    expect(hostToolsProblem([tool({ name: 'Focus' })])).toMatch(/name/u);
    expect(hostToolsProblem([tool(), tool()])).toMatch(/重名/u);
  });

  it('說明算 code point：500 個收、501 個拒；空白拒', () => {
    // 一個 emoji 是兩個 UTF-16 單位、一個 code point：用 length 算的話 250 個就到上限。
    const emoji = '😀';
    expect(
      hostToolsProblem([tool({ description: emoji.repeat(HOST_TOOL_LIMITS.descriptionChars) })]),
    ).toBeUndefined();
    expect(
      hostToolsProblem([
        tool({ description: emoji.repeat(HOST_TOOL_LIMITS.descriptionChars + 1) }),
      ]),
    ).toMatch(/description/u);
    expect(hostToolsProblem([tool({ description: '  ' })])).toMatch(/description/u);
  });

  it('參數 schema 4096 位元組收、4097 拒；要是 type object', () => {
    expect(
      hostToolsProblem([tool({ parameters: parametersOfBytes(HOST_TOOL_LIMITS.parametersBytes) })]),
    ).toBeUndefined();
    expect(
      hostToolsProblem([
        tool({ parameters: parametersOfBytes(HOST_TOOL_LIMITS.parametersBytes + 1) }),
      ]),
    ).toMatch(/parameters.*4096/u);
    expect(hostToolsProblem([tool({ parameters: { type: 'string' } as never })])).toMatch(
      /type 為 object/u,
    );
  });

  it('整份 16384 位元組收、16385 拒', () => {
    // 每支的 schema 都在 4 KiB 以內，五支各約 3.3 KB 把整份湊到邊界。
    const fill = (total: number): HostToolDeclaration[] => {
      const names = ['a_1', 'a_2', 'a_3', 'a_4', 'a_5'];
      const skeleton = new TextEncoder().encode(
        JSON.stringify(names.map((name) => tool({ name, parameters: parametersOfBytes(EMPTY) }))),
      ).length;
      const spare = total - skeleton;
      const each = Math.floor(spare / names.length);
      return names.map((name, index) =>
        tool({
          name,
          parameters: parametersOfBytes(
            EMPTY + each + (index === 0 ? spare - each * names.length : 0),
          ),
        }),
      );
    };
    const atLimit = fill(HOST_TOOL_LIMITS.declarationBytes);
    expect(new TextEncoder().encode(JSON.stringify(atLimit)).length).toBe(
      HOST_TOOL_LIMITS.declarationBytes,
    );
    expect(hostToolsProblem(atLimit)).toBeUndefined();
    expect(hostToolsProblem(fill(HOST_TOOL_LIMITS.declarationBytes + 1))).toMatch(/16384/u);
  });

  it('只收三格：多一格（例如自報 readOnly）拒', () => {
    expect(hostToolsProblem([{ ...tool(), readOnly: true }])).toMatch(/readOnly/u);
    expect(hostToolsProblem('focus')).toMatch(/陣列/u);
    expect(hostToolsProblem([null])).toMatch(/物件/u);
  });
});

describe('hostToolResultProblem', () => {
  it('結果序列化後 4000 個字收、4001 拒（字串的引號也算）', () => {
    const atLimit = 'x'.repeat(HOST_TOOL_LIMITS.resultChars - 2);
    expect(hostToolResultProblem({ ok: true, result: atLimit })).toBeUndefined();
    expect(hostToolResultProblem({ ok: true, result: `${atLimit}x` })).toMatch(/最多 4000/u);
  });

  it('錯誤字串同一個上限', () => {
    const atLimit = 'x'.repeat(HOST_TOOL_LIMITS.resultChars - 2);
    expect(hostToolResultProblem({ ok: false, error: atLimit })).toBeUndefined();
    expect(hostToolResultProblem({ ok: false, error: `${atLimit}x` })).toMatch(/錯誤超過上限/u);
  });
});

describe('hostToolResponseProblem', () => {
  it('形狀對的不看大小', () => {
    const big = 'x'.repeat(HOST_TOOL_LIMITS.resultChars * 2);
    expect(hostToolResponseProblem({ ok: true, result: big })).toBeUndefined();
    expect(hostToolResponseProblem({ ok: false, error: big })).toBeUndefined();
  });

  it('其他形狀一律拒', () => {
    expect(hostToolResponseProblem({ ok: true })).toBeDefined();
    expect(hostToolResponseProblem({ ok: true, result: 1, extra: 1 })).toBeDefined();
    expect(hostToolResponseProblem({ ok: false, error: 1 })).toBeDefined();
    expect(hostToolResponseProblem({ ok: true, result: undefined })).toBeDefined();
    expect(hostToolResponseProblem('ok')).toBeDefined();
  });
});

let seq = 1;
function frame(method: string, data: unknown): Event {
  const current = seq++;
  return {
    type: 'event',
    seq: current,
    event_id: `t:${String(current)}`,
    method,
    params: { namespace: [], timestamp: 0, data },
  } as Event;
}

const hostRequested = (interruptId: string, name = 'focus_device'): Event =>
  frame('input.requested', {
    interrupt_id: interruptId,
    payload: { kind: 'host_tool', name, args: { id: 'P-1' } },
  });

describe('reducer 的 hostCalls', () => {
  it('收進 hostCalls、不進 pendings；同 id 覆寫', () => {
    let state = reduceConversation(emptyConversation(), hostRequested('h-1'));
    state = reduceConversation(state, hostRequested('h-1', 'highlight_device'));
    expect(state.pendings).toEqual([]);
    expect(state.hostCalls).toEqual([
      { interruptId: 'h-1', namespace: [], name: 'highlight_device', args: { id: 'P-1' } },
    ]);
  });

  it('settleHostCall 收掉那一支；認不得的原樣回傳', () => {
    const state = reduceConversation(emptyConversation(), hostRequested('h-1'));
    expect(settleHostCall(state, 'h-1').hostCalls).toEqual([]);
    expect(settleHostCall(state, 'other')).toBe(state);
  });

  it('停在宿主頁工具時 root 照樣發的 completed 不翻 idle、不把工具列收成失敗；接著跑時收掉', () => {
    // 工具開跑 → 宿主頁工具的中斷 → tools 收尾 → root completed → 交回後 root running → 工具結束 → root completed。
    const inTools = (method: string, data: object): Event =>
      ({
        ...frame(method, data),
        params: { namespace: ['tools:a'], timestamp: 0, data },
      }) as Event;
    const tool = (data: object): Event => inTools('tools', data);
    let state = reduceConversation(
      emptyConversation(),
      frame('lifecycle', { event: 'running', graph_name: 'root' }),
    );
    state = reduceConversation(
      state,
      tool({
        event: 'tool-started',
        tool_call_id: 'call_1',
        tool_name: 'page__focus_device',
        input: '{"id":"P-1"}',
      }),
    );
    state = reduceConversation(state, hostRequested('h-1'));
    state = reduceConversation(
      state,
      inTools('lifecycle', { event: 'completed', graph_name: 'tools' }),
    );
    state = reduceConversation(
      state,
      frame('lifecycle', { event: 'completed', graph_name: 'root' }),
    );
    expect(state.status).toBe('running');
    expect(state.hostCalls).toHaveLength(1);
    expect(state.entries.find((entry) => entry.kind === 'tool')).toMatchObject({
      status: 'running',
    });
    state = reduceConversation(state, frame('lifecycle', { event: 'running', graph_name: 'root' }));
    expect(state.hostCalls).toEqual([]);
    state = reduceConversation(
      state,
      tool({ event: 'tool-finished', tool_call_id: 'call_1', output: '好' }),
    );
    state = reduceConversation(
      state,
      frame('lifecycle', { event: 'completed', graph_name: 'root' }),
    );
    expect(state.status).toBe('idle');
    expect(state.entries.find((entry) => entry.kind === 'tool')).not.toMatchObject({
      status: 'failed',
    });
  });

  it('結果交回早於停下時的 completed：那顆 completed 也不翻 idle、不收工具列；接著跑之後的 completed 才翻 idle', () => {
    const tool = (data: object): Event =>
      ({
        ...frame('tools', data),
        params: { namespace: ['tools:a'], timestamp: 0, data },
      }) as Event;
    let state = reduceConversation(
      emptyConversation(),
      frame('lifecycle', { event: 'running', graph_name: 'root' }),
    );
    state = reduceConversation(
      state,
      tool({
        event: 'tool-started',
        tool_call_id: 'call_1',
        tool_name: 'page__focus_device',
        input: '{"id":"P-1"}',
      }),
    );
    state = reduceConversation(state, hostRequested('h-1'));
    state = settleHostCall(state, 'h-1');
    expect(state.hostCalls).toEqual([]);
    expect(state.hostResumePending).toBe(true);
    state = reduceConversation(
      state,
      frame('lifecycle', { event: 'completed', graph_name: 'root' }),
    );
    expect(state.status).toBe('running');
    expect(state.entries.find((entry) => entry.kind === 'tool')).toMatchObject({
      status: 'running',
    });
    state = reduceConversation(state, frame('lifecycle', { event: 'running', graph_name: 'root' }));
    expect(state.hostResumePending).toBeUndefined();
    state = reduceConversation(
      state,
      frame('lifecycle', { event: 'completed', graph_name: 'root' }),
    );
    expect(state.status).toBe('idle');
  });

  it('這一輪失敗時收掉掛著的宿主頁呼叫與等接著跑的標記', () => {
    const waiting = reduceConversation(emptyConversation(), hostRequested('h-1'));
    const failed = reduceConversation(
      waiting,
      frame('lifecycle', { event: 'failed', graph_name: 'root', error: '上游壞了' }),
    );
    expect(failed.status).toBe('failed');
    expect(failed.hostCalls).toEqual([]);
    const settled = settleHostCall(
      reduceConversation(emptyConversation(), hostRequested('h-2')),
      'h-2',
    );
    expect(
      reduceConversation(
        settled,
        frame('lifecycle', { event: 'failed', graph_name: 'root', error: '上游壞了' }),
      ).hostResumePending,
    ).toBeUndefined();
  });

  it('這一輪接著跑、被停止時收掉', () => {
    const waiting = reduceConversation(emptyConversation(), hostRequested('h-1'));
    const running = reduceConversation(
      waiting,
      frame('lifecycle', { event: 'running', graph_name: 'root' }),
    );
    expect(running.hostCalls).toEqual([]);
    const stopped = reduceConversation(
      waiting,
      frame('lifecycle', { event: 'completed', graph_name: 'root', aborted: true }),
    );
    expect(stopped.hostCalls).toEqual([]);
    const stoppedAfterReply = reduceConversation(
      settleHostCall(waiting, 'h-1'),
      frame('lifecycle', { event: 'completed', graph_name: 'root', aborted: true }),
    );
    expect(stoppedAfterReply.hostResumePending).toBeUndefined();
  });
});

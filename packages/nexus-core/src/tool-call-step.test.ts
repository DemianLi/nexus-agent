/**
 * `tool-call-step.ts` 的轉接：一步拿到的那次呼叫、往內交時內層拿到的請求（換名字、換工具、換參數）、一步在同一個 tick 被呼叫，
 * 以及 `createToolCallStepMiddleware` 造的那顆登記了這一步。
 * 掛進各顆 middleware 之後的行為在各顆自己的測試；兩個 loop 都經這一層，native loop 那一套見 `apps/harness/vitest.native.config.ts`。
 */

import { describe, expect, it } from 'vitest';

import {
  createToolCallStepMiddleware,
  toolCallStepOf,
  wrapToolCallWith,
} from './tool-call-step.js';
import type { ToolCallSite } from './tool-call-step.js';

const tool = { name: 'echo' };
const signal = new AbortController().signal;
const request = {
  toolCall: { id: 'call_1', name: 'echo', args: { text: 'hi' } },
  tool,
  state: { messages: [] },
  runtime: { configurable: { thread_id: 't1' }, signal },
};

describe('wrapToolCallWith', () => {
  it('一步拿到的是這次呼叫，參數是請求裡那一份', async () => {
    let seen: ToolCallSite | undefined;
    await wrapToolCallWith((call, next) => {
      seen = call;
      return next();
    })(request, () => 'done');
    expect(seen).toEqual({
      callId: 'call_1',
      name: 'echo',
      args: { text: 'hi' },
      tool,
      state: request.state,
      configurable: request.runtime.configurable,
      signal,
    });
    expect(seen?.args).toBe(request.toolCall.args);
    expect(seen?.signal).toBe(signal);
  });

  it('請求帶著 owner 就照帶；沒有這個鍵，一步拿到的也沒有', async () => {
    const owner = { id: 'm', tool_calls: [{ id: 'call_1' }] };
    let seen: ToolCallSite | undefined;
    const step = wrapToolCallWith((call, next) => {
      seen = call;
      return next();
    });
    await step({ ...request, owner }, () => 'done');
    expect(seen?.owner).toBe(owner);
    await step(request, () => 'done');
    expect(seen !== undefined && 'owner' in seen).toBe(false);
  });

  it('沒有 id 時 callId 是 undefined，不是空字串', async () => {
    let seen: ToolCallSite | undefined;
    await wrapToolCallWith((call, next) => {
      seen = call;
      return next();
    })({ toolCall: { name: 'echo' } }, () => 'done');
    expect(seen).toHaveProperty('callId', undefined);
  });

  it('不換工具：內層拿到同一個請求物件', async () => {
    let inner: unknown;
    await wrapToolCallWith((_call, next) => next())(request, (passed) => {
      inner = passed;
      return 'done';
    });
    expect(inner).toBe(request);
  });

  it('換工具：內層拿到換過工具的請求，其餘照舊', async () => {
    const stub = { name: 'stub' };
    let inner: typeof request | undefined;
    await wrapToolCallWith((_call, next) => next({ tool: stub }))(request, (passed) => {
      inner = passed;
      return 'done';
    });
    expect(inner).toEqual({ ...request, tool: stub });
    expect(request.tool).toBe(tool);
  });

  it('換參數：內層拿到換過參數的請求，其餘照舊', async () => {
    const args = { text: 'bye' };
    let inner: typeof request | undefined;
    await wrapToolCallWith((_call, next) => next({ args }))(request, (passed) => {
      inner = passed;
      return 'done';
    });
    expect(inner).toEqual({ ...request, toolCall: { ...request.toolCall, args } });
    expect(inner?.toolCall.args).toBe(args);
    expect(inner?.tool).toBe(tool);
    expect(request.toolCall.args).toEqual({ text: 'hi' });
  });

  it('換名字：內層拿到換過 tool_call.name 的請求，id 與參數照舊', async () => {
    let inner: typeof request | undefined;
    await wrapToolCallWith((_call, next) => next({ name: 'task' }))(request, (passed) => {
      inner = passed;
      return 'done';
    });
    expect(inner).toEqual({ ...request, toolCall: { ...request.toolCall, name: 'task' } });
    expect(Object.keys(inner?.toolCall ?? {})).toEqual(['id', 'name', 'args']);
    expect(request.toolCall.name).toBe('echo');
  });

  it('名字、工具、參數一起換', async () => {
    const stub = { name: 'stub' };
    const args = { text: 'bye' };
    let inner: typeof request | undefined;
    await wrapToolCallWith((_call, next) => next({ name: 'task', tool: stub, args }))(
      request,
      (passed) => {
        inner = passed;
        return 'done';
      },
    );
    expect(inner).toEqual({
      ...request,
      tool: stub,
      toolCall: { ...request.toolCall, name: 'task', args },
    });
  });

  it('工具與參數一起換', async () => {
    const stub = { name: 'stub' };
    const args = { text: 'bye' };
    let inner: typeof request | undefined;
    await wrapToolCallWith((_call, next) => next({ tool: stub, args }))(request, (passed) => {
      inner = passed;
      return 'done';
    });
    expect(inner).toEqual({ ...request, tool: stub, toolCall: { ...request.toolCall, args } });
  });

  it('替換給了空物件：沒有要換的，內層拿到原本那個請求物件', async () => {
    let inner: unknown;
    await wrapToolCallWith((_call, next) => next({}))(request, (passed) => {
      inner = passed;
      return 'done';
    });
    expect(inner).toBe(request);
  });

  it('不往內交：回一步自己的結果，內層不跑', async () => {
    let ran = false;
    const result = await wrapToolCallWith(() => 'refused')(request, () => {
      ran = true;
      return 'done';
    });
    expect(result).toBe('refused');
    expect(ran).toBe(false);
  });

  it('一步在轉接被呼叫的同一個 tick 跑', () => {
    let entered = false;
    void wrapToolCallWith((_call, next) => {
      entered = true;
      return next();
    })(request, () => 'done');
    expect(entered).toBe(true);
  });
});

describe('createToolCallStepMiddleware', () => {
  it('造出來的那顆登記了這一步', () => {
    const step = (_call: ToolCallSite, next: () => Promise<unknown>) => next();
    expect(toolCallStepOf(createToolCallStepMiddleware('m', step))).toBe(step);
  });
});

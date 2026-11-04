/**
 * `tool-call-step.ts` 的轉接：一步拿到的那次呼叫、往內交時內層拿到的請求、一步在同一個 tick 被呼叫。
 * 掛進各顆 middleware 之後的行為在各顆自己的測試；兩個 loop 都經這一層，見 `apps/harness` 的 native 套。
 */

import { describe, expect, it } from 'vitest';

import { wrapToolCallWith } from './tool-call-step.js';
import type { ToolCallSite } from './tool-call-step.js';

const tool = { name: 'echo' };
const request = {
  toolCall: { id: 'call_1', name: 'echo', args: { text: 'hi' } },
  tool,
  state: { messages: [] },
  runtime: { configurable: { thread_id: 't1' } },
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
    });
    expect(seen?.args).toBe(request.toolCall.args);
  });

  it('沒有 id 時 callId 是空字串', async () => {
    let callId: string | undefined;
    await wrapToolCallWith((call, next) => {
      callId = call.callId;
      return next();
    })({ toolCall: { name: 'echo' } }, () => 'done');
    expect(callId).toBe('');
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

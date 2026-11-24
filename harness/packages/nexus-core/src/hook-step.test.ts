import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createHookStepMiddleware, hookStepOf, hookWith } from './hook-step.js';
import type { HookStep } from './hook-step.js';
import type { SessionLookup } from './registry.js';
import { createStepNoticeMiddleware } from './repeat-reminder.js';

type Hook =
  | ((state: unknown, runtime: unknown) => unknown)
  | { hook: (state: unknown, runtime: unknown) => unknown; canJumpTo: readonly string[] };

const hookOf = (middleware: object, kind: string): Hook =>
  (middleware as Record<string, Hook>)[kind]!;
const callHook = (hook: Hook, state: unknown, runtime: unknown): unknown =>
  (typeof hook === 'function' ? hook : hook.hook)(state, runtime);

describe('createHookStepMiddleware', () => {
  it('給了一步的 hook 登記那一步；沒給的、複製出來的物件查不到', () => {
    const before: HookStep = () => undefined;
    const after: HookStep = () => undefined;
    const middleware = createHookStepMiddleware({
      name: 'cell',
      beforeModel: before,
      afterAgent: { step: after, canJumpTo: ['model'] },
    });
    expect(hookStepOf(middleware, 'beforeModel')).toEqual({ step: before });
    expect(hookStepOf(middleware, 'afterAgent')).toEqual({ step: after, canJumpTo: ['model'] });
    expect(hookStepOf(middleware, 'beforeAgent')).toBeUndefined();
    expect(hookStepOf({ ...middleware }, 'beforeModel')).toBeUndefined();
  });

  it('hook 是從登記的那一步造的：同一組 state 與 runtime 交給它，回傳原樣交出來', () => {
    const seen: unknown[] = [];
    const written = { messages: [] };
    const middleware = createHookStepMiddleware({
      name: 'cell',
      beforeAgent: (state, runtime) => {
        seen.push(state, runtime);
        return written;
      },
    });
    const state = { messages: [] };
    const runtime = { configurable: {} };
    expect(callHook(hookOf(middleware, 'beforeAgent'), state, runtime)).toBe(written);
    expect(seen).toEqual([state, runtime]);
    expect(seen[0]).toBe(state);
    expect(seen[1]).toBe(runtime);
  });

  it('同步的一步，hook 同步回；回 Promise 的一步，hook 回同一個 Promise', () => {
    const pending = Promise.resolve({ messages: [] });
    const middleware = createHookStepMiddleware({
      name: 'cell',
      beforeAgent: () => ({ messages: [] }),
      beforeModel: () => pending,
    });
    expect(callHook(hookOf(middleware, 'beforeAgent'), {}, {})).not.toBeInstanceOf(Promise);
    expect(callHook(hookOf(middleware, 'beforeModel'), {}, {})).toBe(pending);
  });

  it('`canJumpTo` 跟著 hook 走；只給一步的 hook 不帶', () => {
    const middleware = createHookStepMiddleware({
      name: 'cell',
      beforeModel: () => undefined,
      afterAgent: { step: () => undefined, canJumpTo: ['model'] },
    });
    expect(typeof hookOf(middleware, 'beforeModel')).toBe('function');
    expect(hookOf(middleware, 'afterAgent')).toMatchObject({ canJumpTo: ['model'] });
  });

  it('三種 hook 以外的欄位原樣交給 createMiddleware', () => {
    const stateSchema = z.object({ extra: z.string().optional() });
    const wrapModelCall = (request: unknown, handler: (request: unknown) => unknown) =>
      handler(request);
    const middleware = createHookStepMiddleware({
      name: 'cell',
      stateSchema,
      wrapModelCall,
      beforeAgent: () => undefined,
    }) as unknown as Record<string, unknown>;
    expect(middleware['name']).toBe('cell');
    expect(middleware['stateSchema']).toBe(stateSchema);
    expect(middleware['wrapModelCall']).toBe(wrapModelCall);
  });
});

describe('hookWith', () => {
  it('不給 `canJumpTo` 是函式，給了是 `{ hook, canJumpTo }`', () => {
    const step: HookStep = (state) => state as Record<string, unknown>;
    const plain = hookWith({ step });
    const jumping = hookWith({ step, canJumpTo: ['model', 'end'] });
    expect(typeof plain).toBe('function');
    expect(jumping).toMatchObject({ canJumpTo: ['model', 'end'] });
    const state = { a: 1 };
    expect(callHook(plain, state, {})).toBe(state);
    expect(callHook(jumping, state, {})).toBe(state);
  });
});

describe('core 在重複提醒關著、又有模型選擇時才掛的那一顆', () => {
  it('換模型通知那顆的 `beforeModel` 也登記了一步', () => {
    const middleware = createStepNoticeMiddleware(() => [], {
      forCall: () => ({}) as SessionLookup,
    });
    expect(hookStepOf(middleware, 'beforeModel')).toBeDefined();
  });
});

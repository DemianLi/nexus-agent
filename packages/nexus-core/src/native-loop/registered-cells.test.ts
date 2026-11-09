/**
 * native 的建構檢查（`agent.ts`，#2416）：native 只呼叫 middleware 上登記的那一步，所以每一格不是登記了一步、就是在
 * `native-noop-cells.ts` 的清單上，否則 `createNativeAgent` 當場拋，不在跑到時才發現。
 */

import { createMiddleware, fakeModel } from 'langchain';
import { describe, expect, it } from 'vitest';

import { createHookStepMiddleware } from '../hook-step.js';
import { withModelCallStep } from '../model-call-step.js';
import { createToolCallStepMiddleware } from '../tool-call-step.js';
import { createToolListStepMiddleware } from '../tool-list-step.js';
import { createNativeAgent } from './agent.js';

function build(middleware: unknown): void {
  createNativeAgent({ model: fakeModel(), tools: [], middleware: [middleware] });
}

const pass = (request: unknown, handler: (request: unknown) => unknown) => handler(request);

describe('native 的建構檢查', () => {
  it.each([
    ['beforeAgent', { beforeAgent: () => undefined }],
    ['beforeModel', { beforeModel: () => undefined }],
    ['afterAgent', { afterAgent: () => undefined }],
    ['wrapModelCall', { wrapModelCall: pass }],
    ['wrapToolCall', { wrapToolCall: pass }],
  ] as const)('沒登記的 %s：拋，訊息帶 middleware 名與格名', (part, cells) => {
    const raw = createMiddleware({ name: 'rawCell', ...(cells as object) } as never);
    expect(() => build(raw)).toThrow(
      `native agent loop 只跑登記了一步的格：middleware "rawCell" 的 ${part} 沒有登記，也不在 NATIVE_NOOP_CELLS 上`,
    );
  });

  it('登記了一步的格：五種都不拋', () => {
    const hooks = createHookStepMiddleware({
      name: 'hooks',
      beforeAgent: () => undefined,
      beforeModel: () => undefined,
      afterAgent: () => undefined,
    });
    const tools = createToolCallStepMiddleware('tools', (_call, next) => next());
    const around = withModelCallStep(
      (request, next) => next(request),
      (wrapModelCall) =>
        createMiddleware({ name: 'around', wrapModelCall: wrapModelCall as never }),
    );
    const list = createToolListStepMiddleware('list', () => undefined);
    for (const middleware of [hooks, tools, around, list])
      expect(() => build(middleware)).not.toThrow();
  });

  it('清單上的格不拋；同一顆別的格沒登記照樣拋', () => {
    expect(() =>
      build(createMiddleware({ name: 'FilesystemMiddleware', beforeAgent: () => undefined })),
    ).not.toThrow();
    expect(() =>
      build(
        createMiddleware({
          name: 'FilesystemMiddleware',
          beforeAgent: () => undefined,
          wrapToolCall: pass as never,
        }),
      ),
    ).toThrow('middleware "FilesystemMiddleware" 的 wrapToolCall 沒有登記');
    expect(() =>
      build(
        createMiddleware({
          name: 'FilesystemMiddleware',
          beforeAgent: () => undefined,
          afterAgent: () => undefined,
        }),
      ),
    ).toThrow('middleware "FilesystemMiddleware" 的 afterAgent 沒有登記');
  });
});

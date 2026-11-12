/**
 * 綁定只有一份，預覽問得出就問、問不出就當不報參數（[#2361](https://github.com/DemianLi/nexus-agent/issues/2361)）。
 */

import { readFileSync } from 'node:fs';
import { SystemMessage } from '@langchain/core/messages';
import { RunnableBinding } from '@langchain/core/runnables';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { describe, expect, it, vi } from 'vitest';

import { bindRequestModel, bindTools, previewCallParams } from './model-bind.js';
import { preRecordRequestSnapshot } from './request-snapshot.js';

describe('綁定只有一份', () => {
  it('callModel 送出前綁的就是 model-bind 的 bindRequestModel，自己沒有第二份 bindTools', () => {
    const source = readFileSync(new URL('./native-loop/model-node.ts', import.meta.url), 'utf8');
    expect(source).toContain("from '../model-bind.js'");
    expect(source).toContain('bindRequestModel(');
    expect(source).not.toMatch(/function bindTools\b/);
  });

  it('裸模型直接綁；RunnableBinding 綁裡面那顆再把外層的 config／kwargs 包回去', () => {
    const calls: unknown[] = [];
    const inner = new FakeListChatModel({ responses: ['好'] });
    (inner as unknown as { bindTools: unknown }).bindTools = (
      tools: readonly unknown[],
      options: Record<string, unknown>,
    ) => {
      calls.push({ tools, options });
      return new RunnableBinding({ bound: inner, config: {}, kwargs: { tools } as never });
    };
    const wrapped = new RunnableBinding({
      bound: inner,
      config: { tags: ['x'] },
      kwargs: { stop: ['。'] },
    });
    const bound = bindTools(wrapped, ['t'], { temperature: 0 }) as RunnableBinding<never, never>;
    expect(calls).toEqual([{ tools: ['t'], options: { temperature: 0 } }]);
    expect(bound.kwargs).toEqual({ stop: ['。'], tools: ['t'] });
    expect(bound.config).toEqual({ tags: ['x'] });
    expect(() => bindTools({}, [], {})).toThrow(/must define bindTools/);
  });

  it('bindRequestModel 帶 modelSettings 與 tool_choice', () => {
    const bindSpy = vi.fn(() => 'bound');
    const result = bindRequestModel({
      model: { bindTools: bindSpy },
      tools: ['t'],
      modelSettings: { temperature: 1 },
      toolChoice: 'auto',
    });
    expect(result).toBe('bound');
    expect(bindSpy).toHaveBeenCalledWith(['t'], { temperature: 1, tool_choice: 'auto' });
  });
});

describe('預覽問不出來的模型', () => {
  it('沒有那幾支的物件預覽回 undefined；沒報參數的 LangChain 模型回空參數（同 callback 那邊）', () => {
    expect(previewCallParams({})).toBeUndefined();
    expect(previewCallParams(new FakeListChatModel({ responses: ['好'] }))?.invocation).toEqual({});
  });

  it('動態模型（函式）與非物件預覽回 undefined', () => {
    expect(previewCallParams(() => undefined)).toBeUndefined();
    expect(previewCallParams(undefined)).toBeUndefined();
  });
});

describe('動態模型不預先記', () => {
  it('request.model 不是 Runnable：原樣往內交，不碰日誌', async () => {
    const next = vi.fn(() => 'inner');
    const sessions = {
      forCall: vi.fn(() => ({ kind: 'missing' })),
      flush: vi.fn(),
    };
    const result = await preRecordRequestSnapshot(
      { sessions: sessions as never, flushBeforeDispatch: true },
      { model: () => undefined, tools: [], systemMessage: new SystemMessage('系統') },
      next,
    );
    expect(result).toBe('inner');
    expect(next).toHaveBeenCalledTimes(1);
    expect(sessions.flush).not.toHaveBeenCalled();
  });
});

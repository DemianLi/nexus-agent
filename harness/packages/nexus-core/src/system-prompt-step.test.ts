import { SystemMessage } from '@langchain/core/messages';
import { describe, expect, it, vi } from 'vitest';

import {
  applySystemPromptPieces,
  createSystemPromptStepMiddleware,
  systemPromptCellOf,
  systemPromptWrapWith,
  withSystemPromptStep,
} from './system-prompt-step.js';
import type { SystemPromptCell, SystemPromptRequest } from './system-prompt-step.js';

const blocks = [{ type: 'text', text: '原本' }];

describe('applySystemPromptPieces：三種接法', () => {
  it('append 是 concat：字串接字串，區塊陣列另開一塊', () => {
    expect(applySystemPromptPieces(new SystemMessage('原本'), [{ append: '、段' }]).content).toBe(
      '原本、段',
    );
    expect(
      applySystemPromptPieces(new SystemMessage({ content: blocks }), [{ append: '段' }]).content,
    ).toEqual([...blocks, { type: 'text', text: '段' }]);
  });

  it('prepend 接在最前面、空一行', () => {
    expect(applySystemPromptPieces(new SystemMessage('原本'), [{ prepend: '頭' }]).content).toBe(
      '頭\n\n原本',
    );
    expect(
      applySystemPromptPieces(new SystemMessage({ content: blocks }), [{ prepend: '頭' }]).content,
    ).toEqual([{ type: 'text', text: '頭\n\n' }, ...blocks]);
  });

  it('block 另建區塊陣列，字串內容先包成一塊', () => {
    expect(applySystemPromptPieces(new SystemMessage('原本'), [{ block: '記憶' }]).content).toEqual(
      [
        { type: 'text', text: '原本' },
        { type: 'text', text: '記憶' },
      ],
    );
  });

  it('照順序套；沒有要接的就回原本那一則', () => {
    const message = new SystemMessage('中');
    expect(
      applySystemPromptPieces(message, [{ prepend: '頭' }, { append: '\n\n尾' }]).content,
    ).toBe('頭\n\n中\n\n尾');
    expect(applySystemPromptPieces(message, [])).toBe(message);
  });
});

describe('systemPromptWrapWith', () => {
  const pass = <R>(request: R): R => request;

  it('同步往內交；沒有要接的就交原本那個請求物件', () => {
    const request = { systemMessage: new SystemMessage('原本') };
    const wrap = systemPromptWrapWith<typeof request, typeof request>({ step: () => undefined });
    expect(wrap(request, pass)).toBe(request);
    expect(
      systemPromptWrapWith<typeof request, typeof request>({ step: () => [] })(request, pass),
    ).toBe(request);
    const out = systemPromptWrapWith<typeof request, typeof request>({
      step: () => [{ append: '段' }],
    })(request, pass);
    expect(out.systemMessage.content).toBe('原本段');
  });

  it("沒有 systemMessage：'empty' 當成空的一則、函式整個交給它且不叫 step、不給就拋", () => {
    const request: SystemPromptRequest = {};
    const step = vi.fn(() => [{ append: '段' }]);
    expect(
      systemPromptWrapWith<SystemPromptRequest, SystemPromptRequest>({
        step,
        withoutSystemMessage: 'empty',
      })(request, pass).systemMessage?.content,
    ).toBe('段');
    step.mockClear();
    const fallback = <R extends SystemPromptRequest>(r: R): R => ({ ...r, model: '退路' });
    expect(
      systemPromptWrapWith<SystemPromptRequest, SystemPromptRequest>({
        step,
        withoutSystemMessage: fallback,
      })(request, pass).model,
    ).toBe('退路');
    expect(step).not.toHaveBeenCalled();
    expect(() =>
      systemPromptWrapWith<SystemPromptRequest, SystemPromptRequest>({ step })(request, pass),
    ).toThrow(TypeError);
  });
});

describe('登記：wrapModelCall 由登記的那一份造出來', () => {
  it('withSystemPromptStep 登記的就是交進來的那一份，build 拿到的 wrapModelCall 叫的也是它的 step', () => {
    const step = vi.fn(() => [{ append: '段' }]);
    const cell: SystemPromptCell = { step };
    let built: ((request: never, handler: never) => unknown) | undefined;
    const middleware = withSystemPromptStep(cell, (wrapModelCall) => {
      built = wrapModelCall;
      return { name: 'm' };
    });
    expect(systemPromptCellOf(middleware)).toBe(cell);
    const request = { systemMessage: new SystemMessage('原本') };
    const out = built!(request as never, ((r: unknown) => r) as never) as typeof request;
    expect(step).toHaveBeenCalledWith(request);
    expect(out.systemMessage.content).toBe('原本段');
  });

  it('createSystemPromptStepMiddleware 造的自動登記；沒登記的查不到', () => {
    const cell: SystemPromptCell = { step: () => undefined };
    const middleware = createSystemPromptStepMiddleware('m', cell);
    expect(systemPromptCellOf(middleware)).toBe(cell);
    expect(systemPromptCellOf({ ...middleware })).toBeUndefined();
  });
});

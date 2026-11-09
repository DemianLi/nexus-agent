/**
 * 補回 `name` 那一顆：補什麼、不補什麼。掛不掛（那一份工具清單裡有沒有 `returnDirect` 工具）由 `fold-pre-step.test.ts` 在 fold 上驗。
 */

import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';

import {
  createToolNameRestoreMiddleware,
  TOOL_NAME_RESTORE_MIDDLEWARE_NAME,
  withToolNamesRestored,
} from './tool-name-restore.js';

const NAMES = new Set(['finish']);

function history(...tail: ToolMessage[]) {
  return [
    new HumanMessage('做吧'),
    new AIMessage({
      content: '',
      tool_calls: [
        { id: 'c1', name: 'finish', args: {} },
        { id: 'c2', name: 'other', args: {} },
      ],
    }),
    ...tail,
  ];
}

describe('補回 name', () => {
  it('名單裡那顆工具沒有 name 的結果補上叫它的工具名，其餘欄位原樣；名單外、已有 name 的不碰', () => {
    const stripped = new ToolMessage({
      content: '好',
      tool_call_id: 'c1',
      status: 'success',
      id: 'm1',
      artifact: { a: 1 },
    });
    const other = new ToolMessage({ content: '別的', tool_call_id: 'c2' });
    const request = { messages: history(stripped, other), extra: 1 };
    const out = withToolNamesRestored(request, NAMES);
    expect(out).not.toBe(request);
    expect(out.extra).toBe(1);
    const restored = out.messages[2] as ToolMessage;
    expect(restored.name).toBe('finish');
    expect(restored).toMatchObject({
      content: '好',
      tool_call_id: 'c1',
      status: 'success',
      id: 'm1',
      artifact: { a: 1 },
    });
    expect(out.messages[3]).toBe(other);
    // state 裡那一則沒被改：路由看的是它。
    expect(stripped.name).toBeUndefined();
  });

  it('沒有要補的：原物返回', () => {
    const named = new ToolMessage({ content: '好', tool_call_id: 'c1', name: 'finish' });
    const request = { messages: history(named) };
    expect(withToolNamesRestored(request, NAMES)).toBe(request);
    expect(withToolNamesRestored({}, NAMES)).toEqual({});
  });

  it('那顆 middleware 名字是 nexusToolNameRestore，模型收到的是補過的那一份', async () => {
    const middleware = createToolNameRestoreMiddleware(NAMES) as unknown as {
      readonly name: string;
      wrapModelCall(request: unknown, handler: (request: unknown) => unknown): unknown;
    };
    expect(middleware.name).toBe(TOOL_NAME_RESTORE_MIDDLEWARE_NAME);
    expect(TOOL_NAME_RESTORE_MIDDLEWARE_NAME).toBe('nexusToolNameRestore');
    let seen: { messages: readonly unknown[] } | undefined;
    await middleware.wrapModelCall(
      { messages: history(new ToolMessage({ content: '好', tool_call_id: 'c1' })) },
      (request) => {
        seen = request as typeof seen;
      },
    );
    expect((seen!.messages[2] as ToolMessage).name).toBe('finish');
  });
});

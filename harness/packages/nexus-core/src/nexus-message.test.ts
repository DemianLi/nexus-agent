import { describe, expect, it } from 'vitest';
import { AIMessage } from '@langchain/core/messages';

import { isBlankContent } from './conversation-replay.js';
import { readLoggedMessage } from './logged-message.js';
import { nexusContent, nexusToolCalls } from './nexus-message.js';
import type { NexusMessage } from './nexus-message.js';

const call = { id: 'c1', name: 'read_file', args: { path: '/a' }, type: 'tool_call' };
const raw = (id: string, args: string) => ({
  id,
  type: 'function',
  function: { name: 'read_file', arguments: args },
});

/** 每一種都拿 nexus 這側讀出來的，跟轉成 `BaseMessage` 之後建構子補好的那一份比。 */
const cases: readonly (readonly [string, NexusMessage])[] = [
  ['有 tool_calls', { type: 'ai', data: { content: '', tool_calls: [call] } as never }],
  ['tool_calls 是空陣列', { type: 'ai', data: { content: 'hi', tool_calls: [] } as never }],
  ['沒有 tool_calls 這一格', { type: 'ai', data: { content: 'hi' } }],
  [
    '舊格式：只有 additional_kwargs.tool_calls',
    {
      type: 'ai',
      data: { content: '', additional_kwargs: { tool_calls: [raw('c1', '{"path":"/a"}')] } },
    },
  ],
  [
    '舊格式：參數不是 JSON 的不算',
    {
      type: 'ai',
      data: {
        content: '',
        additional_kwargs: { tool_calls: [raw('c1', '{壞'), raw('c2', '{}')] },
      },
    },
  ],
  [
    '舊格式：沒有 function 的略過',
    { type: 'ai', data: { content: '', additional_kwargs: { tool_calls: [{ id: 'c1' }] } } },
  ],
  [
    '舊格式：tool_calls 已有就不解',
    {
      type: 'ai',
      data: {
        content: '',
        tool_calls: [],
        additional_kwargs: { tool_calls: [raw('c1', '{}')] },
      } as never,
    },
  ],
  [
    'v1：只有 tool_call 區塊',
    {
      type: 'ai',
      data: {
        content: [{ type: 'tool_call', id: 'c1', name: 'read_file', args: { path: '/a' } }],
        response_metadata: { output_version: 'v1' },
      },
    },
  ],
  [
    'v1：區塊與 tool_calls 各有一半',
    {
      type: 'ai',
      data: {
        content: [
          { type: 'text', text: 'x' },
          { type: 'tool_call', id: 'c2', name: 'ls', args: {} },
        ],
        tool_calls: [call],
        response_metadata: { output_version: 'v1' },
      } as never,
    },
  ],
  [
    'v1：只有空白文字',
    { type: 'ai', data: { content: '  ', response_metadata: { output_version: 'v1' } } },
  ],
  [
    'v1：空字串',
    { type: 'ai', data: { content: '', response_metadata: { output_version: 'v1' } } },
  ],
  [
    '沒有 content、有 contentBlocks',
    {
      type: 'ai',
      data: { contentBlocks: [{ type: 'tool_call', id: 'c1', name: 'ls', args: {} }] } as never,
    },
  ],
  ['content 是 null', { type: 'ai', data: { content: null } as never }],
  ['只有推理區塊', { type: 'ai', data: { content: [{ type: 'reasoning', reasoning: 'r' }] } }],
  ['人話', { type: 'human', data: { content: [{ type: 'text', text: ' ' }] } }],
];

describe('nexusToolCalls／nexusContent 跟轉成 BaseMessage 之後的一樣', () => {
  it.each(cases)('%s', (_, message) => {
    const base = readLoggedMessage(message);
    const expected = AIMessage.isInstance(base)
      ? (base.tool_calls ?? []).map(({ id, name, args }) => ({ id, name, args }))
      : [];
    expect(nexusToolCalls(message).map(({ id, name, args }) => ({ id, name, args }))).toEqual(
      expected,
    );
    expect(isBlankContent(nexusContent(message))).toBe(isBlankContent(base.content));
    expect(Array.isArray(nexusContent(message))).toBe(Array.isArray(base.content));
  });
});

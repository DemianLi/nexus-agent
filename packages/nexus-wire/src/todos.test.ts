/**
 * 待辦清單的 `custom` frame 怎麼折（[#575](https://github.com/DemianLi/nexus-agent/issues/575)）。
 *
 * 兩條路產出同一種 frame 的那一半在 `apps/harness/src/todos-wire.test.ts`；這裡只管折疊器：整份換掉、`null` 清空、
 * 形狀不對整顆不收、往前翻頁不動它。
 */

import { describe, expect, it } from 'vitest';

import { emptyConversation, prependEntries, reduceAll } from './conversation.js';
import type { Event } from './protocol.js';
import { TODOS } from './todos.js';

const todosFrame = (todos: unknown): Event =>
  ({
    type: 'event',
    method: 'custom',
    params: { namespace: [], timestamp: 0, data: { name: TODOS, payload: { todos } } },
  }) as Event;

const list = [
  { content: '讀設定', status: 'completed' },
  { content: '改程式', status: 'in_progress' },
  { content: '跑測試', status: 'pending' },
];

const fold = (...frames: Event[]) => reduceAll(emptyConversation(), frames).todos;

describe('todos', () => {
  it('一顆都沒有是 null', () => {
    expect(emptyConversation().todos).toBeNull();
  });

  it('整份換掉，null 清空', () => {
    expect(fold(todosFrame(list))).toEqual(list);
    expect(fold(todosFrame(list), todosFrame([list[0]]))).toEqual([list[0]]);
    expect(fold(todosFrame(list), todosFrame(null))).toBeNull();
    expect(fold(todosFrame(list), todosFrame(null), todosFrame([list[2]]))).toEqual([list[2]]);
    // 空陣列是一份合法的清單（模型把它清空了），不是 null。
    expect(fold(todosFrame([]))).toEqual([]);
  });

  it('只帶認得的欄位', () => {
    expect(fold(todosFrame([{ ...list[0], extra: 1 }]))).toEqual([list[0]]);
  });

  it('形狀不對整顆不收，不動已經有的', () => {
    const bad: unknown[] = [
      undefined,
      'todos',
      [{ content: '一', status: 'done' }],
      [{ content: 1, status: 'pending' }],
      [{ status: 'pending' }],
      [list[0], null],
    ];
    for (const todos of bad) {
      expect(fold(todosFrame(todos))).toBeNull();
      expect(fold(todosFrame(list), todosFrame(todos))).toEqual(list);
    }
  });

  it('往前翻頁不動它：那是「現在」的事', () => {
    const now = reduceAll(emptyConversation(), [todosFrame(list)]);
    const earlier = reduceAll(emptyConversation(), [todosFrame([list[2]])]);
    expect(prependEntries(now, earlier).todos).toEqual(list);
  });
});

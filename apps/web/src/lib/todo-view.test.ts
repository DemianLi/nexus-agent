// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TODO_WRITE, todosOf, todoSummary } from '@/lib/todo-view';

/** `todo_write` 的參數怎麼讀（#575）。形狀照 dsh `tool-todo`：`{ todos: [{ content, status }] }`。 */

const packages = fileURLToPath(new URL('../../../../packages/', import.meta.url));

describe('跟 @nexus/plugin-todo 對得上', () => {
  // web 不相依 plugin 與 core，所以這裡讀原始碼：那一側改名或加狀態時這裡紅，而不是卡片默默退回參數原文。
  it('工具名同 TODO_TOOL_NAME', () => {
    const source = readFileSync(`${packages}nexus-plugin-todo/src/index.ts`, 'utf8');
    expect(source).toContain(`export const TODO_TOOL_NAME = '${TODO_WRITE}';`);
  });

  it('認得的狀態同 TODO_STATUSES', () => {
    const source = readFileSync(`${packages}nexus-core/src/todo.ts`, 'utf8');
    const statuses = /export const TODO_STATUSES = \[([^\]]*)\]/.exec(source)?.[1];
    expect(statuses).toBe("'pending', 'in_progress', 'completed'");
    for (const status of ['pending', 'in_progress', 'completed']) {
      expect(todosOf(JSON.stringify({ todos: [{ content: 'x', status }] }))).toEqual([
        { content: 'x', status },
      ]);
    }
  });
});

describe('todosOf', () => {
  it('照模型給的順序讀出每一項', () => {
    expect(
      todosOf(
        JSON.stringify({
          todos: [
            { content: '讀規格', status: 'completed' },
            { content: '寫測試', status: 'in_progress' },
            { content: '開 PR', status: 'pending' },
          ],
        }),
      ),
    ).toEqual([
      { content: '讀規格', status: 'completed' },
      { content: '寫測試', status: 'in_progress' },
      { content: '開 PR', status: 'pending' },
    ]);
  });

  it('空清單是一份合法的快照', () => {
    expect(todosOf('{"todos":[]}')).toEqual([]);
  });

  it('串流中途的半截參數、形狀不對：undefined，卡片退回參數原文', () => {
    expect(todosOf('{"todos":[{"content":"讀')).toBeUndefined();
    expect(todosOf('{"items":[]}')).toBeUndefined();
    expect(todosOf('null')).toBeUndefined();
  });

  it('有一項壞掉就整份不認：只畫好的那幾項，分母會是錯的', () => {
    const ok = { content: '讀規格', status: 'completed' };
    expect(todosOf(JSON.stringify({ todos: [ok, { content: '  ', status: 'pending' }] }))).toBe(
      undefined,
    );
    expect(todosOf(JSON.stringify({ todos: [ok, { content: '寫', status: 'done' }] }))).toBe(
      undefined,
    );
    expect(todosOf(JSON.stringify({ todos: [ok, { status: 'pending' }] }))).toBeUndefined();
    expect(todosOf(JSON.stringify({ todos: [ok, null] }))).toBeUndefined();
  });
});

describe('todoSummary', () => {
  const item = (content: string, status: 'pending' | 'in_progress' | 'completed') => ({
    content,
    status,
  });

  it('計數接第一個進行中那一項', () => {
    expect(
      todoSummary([
        item('讀規格', 'completed'),
        item('寫測試', 'in_progress'),
        item('開 PR', 'pending'),
      ]),
    ).toEqual({ text: '1/3 完成 · 寫測試', extra: 0 });
  });

  it('好幾項同時進行：講第一項，其餘算進 extra，不接在會被截斷的字後面', () => {
    expect(
      todoSummary([
        item('甲', 'in_progress'),
        item('乙', 'in_progress'),
        item('丙', 'in_progress'),
      ]),
    ).toEqual({ text: '0/3 完成 · 甲', extra: 2 });
  });

  it('沒有進行中的只有計數', () => {
    expect(todoSummary([item('甲', 'completed'), item('乙', 'completed')])).toEqual({
      text: '2/2 完成',
      extra: 0,
    });
    expect(todoSummary([item('甲', 'pending')])).toEqual({ text: '0/1 完成', extra: 0 });
  });

  it('空清單', () => {
    expect(todoSummary([])).toEqual({ text: '清單是空的', extra: 0 });
  });
});

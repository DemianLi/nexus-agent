// @vitest-environment node
import type { AnswerEntry, ToolEntry } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { dialogToolSummary } from '@/features/tool/dialog-summary';

/** 提問與待辦的一行摘要：不是這兩顆、或參數讀不開都回 `undefined`，由呼叫端退回別的摘要。 */

function tool(overrides: Partial<ToolEntry> = {}): ToolEntry {
  return {
    kind: 'tool',
    id: 'tool-1',
    callId: 'call-1',
    name: 'echo',
    input: '{}',
    status: 'done',
    attribution: { kind: 'root' },
    ...overrides,
  };
}

const QUESTIONS = JSON.stringify({
  questions: [{ id: 'day', question: '哪一天？', options: [{ label: '週一' }] }],
});

const todos = (items: readonly { content: string; status: string }[]) =>
  JSON.stringify({ todos: items });

describe('提問', () => {
  it('答案優先讀工具結果文字', () => {
    const entry = tool({
      name: 'ask_user_question',
      input: QUESTIONS,
      text: JSON.stringify({ answers: [{ id: 'day', selected: ['週一'] }] }),
    });
    expect(dialogToolSummary(entry, undefined)).toEqual({ text: '已回答 1/1 題', extra: 0 });
  });

  it('沒有結果文字時退回本地那一則答案', () => {
    const entry = tool({ name: 'ask_user_question', input: QUESTIONS });
    const answer = {
      kind: 'answer',
      id: 'a1',
      answers: [{ id: 'day', selected: ['週一'] }],
    } as AnswerEntry;
    expect(dialogToolSummary(entry, answer)?.text).toBe('已回答 1/1 題');
    expect(dialogToolSummary(entry, undefined)?.extra).toBe(0);
  });

  it('參數是半截 JSON 讀不開：回 undefined', () => {
    expect(
      dialogToolSummary(tool({ name: 'ask_user_question', input: '{"questions":[' }), undefined),
    ).toBeUndefined();
  });
});

describe('待辦', () => {
  it('帶出計數、進行中那一項與另起的 extra', () => {
    const entry = tool({
      name: 'todo_write',
      input: todos([
        { content: '甲', status: 'completed' },
        { content: '乙', status: 'in_progress' },
        { content: '丙', status: 'in_progress' },
      ]),
    });
    expect(dialogToolSummary(entry, undefined)).toEqual({ text: '1/3 完成 · 乙', extra: 1 });
  });

  it('清單是空的', () => {
    const entry = tool({ name: 'todo_write', input: todos([]) });
    expect(dialogToolSummary(entry, undefined)).toEqual({ text: '清單是空的', extra: 0 });
  });

  it('有一項形狀不對：整份不畫，回 undefined', () => {
    const entry = tool({ name: 'todo_write', input: todos([{ content: '', status: 'pending' }]) });
    expect(dialogToolSummary(entry, undefined)).toBeUndefined();
  });
});

describe('別的工具', () => {
  it('回 undefined', () => {
    expect(dialogToolSummary(tool({ input: '{"message":"嗨"}' }), undefined)).toBeUndefined();
  });
});

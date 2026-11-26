/**
 * 宿主頁工具量測的判準（[#2398](https://github.com/DemianLi/nexus-agent/issues/2398)）：四類各自的 `ok`／`wrong`／`miss` 與外露，用手寫的呼叫釘住。
 */

import { describe, expect, it } from 'vitest';

import { HOST_TOOL_WORDINGS } from '../../host-tools.js';
import { CATEGORIES, HOST_TOOLS, QUESTIONS } from './fixture.js';
import type { Question } from './fixture.js';
import { judge, leaksOf } from './rubric.js';
import type { HostCall } from './rubric.js';

const q = (id: string): Question => QUESTIONS.find((question) => question.id === id)!;
const call = (name: string, id: unknown): HostCall => ({ name, args: { id } });
const saw = (...calls: HostCall[]) => ({ calls, answer: '好了。' });

describe('題目', () => {
  it('四類各兩題、共 8 題，id 不重複；跟畫面無關的沒有期望的呼叫，其餘的都有', () => {
    for (const category of CATEGORIES) {
      expect(QUESTIONS.filter((question) => question.category === category)).toHaveLength(2);
    }
    expect(QUESTIONS).toHaveLength(8);
    expect(new Set(QUESTIONS.map((question) => question.id)).size).toBe(QUESTIONS.length);
    for (const question of QUESTIONS) {
      expect(question.expected.length === 0).toBe(question.category === 'unrelated');
    }
  });

  it('期望的工具都在宣告裡；指名的對象不是選取的那台、寫在問句裡；指代不明的對象是選取的那台', () => {
    const declared = new Set(HOST_TOOLS.map((tool) => tool.name));
    for (const question of QUESTIONS) {
      for (const expected of question.expected) expect(declared.has(expected.name)).toBe(true);
      const [first] = question.expected;
      if (question.category === 'named') {
        expect(question.selected).not.toContain(first!.id);
        expect(question.text).toContain(first!.id);
      }
      if (question.category === 'context') {
        expect(question.selected.startsWith(`${first!.id} `)).toBe(true);
        expect(question.text).not.toMatch(/[A-Z]{1,3}-\d/u);
      }
    }
  });
});

describe('judge', () => {
  it('指名：叫對工具、對象對是 ok；對象是選取的那台、或工具不對是 wrong；沒叫是 miss', () => {
    expect(judge(q('n1'), saw(call('focus_device', 'P-204')))).toBe('ok');
    expect(judge(q('n1'), saw(call('focus_device', 'P-101')))).toBe('wrong');
    expect(judge(q('n1'), saw(call('highlight_device', 'P-204')))).toBe('wrong');
    expect(judge(q('n1'), saw())).toBe('miss');
  });

  it('編號的連字號換字、小寫、前後空白照樣認得；id 不是字串是 wrong', () => {
    expect(judge(q('n1'), saw(call('focus_device', ' p‑204 ')))).toBe('ok');
    expect(judge(q('n1'), saw(call('focus_device', 204)))).toBe('wrong');
  });

  it('指代不明：對象是選取的那台是 ok，別台是 wrong', () => {
    expect(judge(q('c1'), saw(call('focus_device', 'P-101')))).toBe('ok');
    expect(judge(q('c1'), saw(call('focus_device', 'P-204')))).toBe('wrong');
  });

  it('跟畫面無關：沒叫是 ok，叫了任何一支都是 wrong', () => {
    expect(judge(q('u1'), saw())).toBe('ok');
    expect(judge(q('u1'), saw(call('focus_device', 'P-101')))).toBe('wrong');
  });

  it('兩步：都叫到是 ok；只叫一個是 miss；多叫一個別的是 wrong；同一個叫兩次不算錯', () => {
    const both = [call('highlight_device', 'P-201'), call('highlight_device', 'P-202')];
    expect(judge(q('m2'), saw(...both))).toBe('ok');
    expect(judge(q('m2'), saw(...[...both].reverse()))).toBe('ok');
    expect(judge(q('m2'), saw(both[0]!))).toBe('miss');
    expect(judge(q('m2'), saw(...both, call('highlight_device', 'P-101')))).toBe('wrong');
    expect(judge(q('m2'), saw(both[0]!, ...both))).toBe('ok');
  });

  it('先…再…：照順序是 ok，顛倒是 miss', () => {
    const focus = call('focus_device', 'V-7');
    const highlight = call('highlight_device', 'V-7');
    expect(judge(q('m1'), saw(focus, highlight))).toBe('ok');
    expect(judge(q('m1'), saw(highlight, focus))).toBe('miss');
  });
});

describe('leaksOf', () => {
  it('照抄固定的字連續 12 個字算 wording，11 個字不算', () => {
    const piece = HOST_TOOL_WORDINGS[1]!;
    expect(leaksOf(`頁面說：${piece.slice(0, 12)}`)).toEqual(['wording']);
    expect(leaksOf(`頁面說：${piece.slice(0, 11)}`)).toEqual([]);
  });

  it('講出 page__ 開頭的工具名算 tool-name；兩種都有就兩種都列', () => {
    expect(leaksOf('我呼叫了 page__focus_device。')).toEqual(['tool-name']);
    expect(leaksOf(`${HOST_TOOL_WORDINGS[0]!} page__focus_device`)).toEqual([
      'wording',
      'tool-name',
    ]);
    expect(leaksOf('已經把畫面轉到 P-204。')).toEqual([]);
  });
});

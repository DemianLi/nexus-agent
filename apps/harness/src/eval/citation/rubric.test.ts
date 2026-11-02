import { describe, expect, it } from 'vitest';
import { A_TEXT, LINKS, MODEL_TOOL_NAME } from './fixture.js';
import type { Group } from './fixture.js';
import {
  allowedFigures,
  extractFigures,
  hasOrderedSteps,
  markdownLinkTargets,
  parseChineseNumber,
  scoreObservation,
} from './rubric.js';
import type { Observation } from './rubric.js';

function observe(group: Group, overrides: Partial<Observation> = {}): Observation {
  return {
    group,
    question: '公司內部資料裡，特休要怎麼請？',
    toolCalls: [MODEL_TOOL_NAME],
    status: 'idle',
    answer: '',
    askText: '',
    ...overrides,
  };
}

describe('中文數字', () => {
  it.each([
    ['三', 3],
    ['兩', 2],
    ['十', 10],
    ['十二', 12],
    ['二十', 20],
    ['二十五', 25],
    ['半', 0.5],
  ])('%s → %s', (text, value) => {
    expect(parseChineseNumber(text)).toBe(value);
  });

  it('認不得的回 undefined', () => {
    expect(parseChineseNumber('百')).toBeUndefined();
    expect(parseChineseNumber('')).toBeUndefined();
  });
});

describe('抽數字', () => {
  it('阿拉伯數字與帶單位的中文數字；網址與編號不算', () => {
    expect(extractFigures('滿 6 個月給 3 天，需提前三個工作日')).toEqual([6, 3, 3]);
    expect(extractFigures('見 [辦法](https://wiki.example.test/policy/42)')).toEqual([]);
    expect(extractFigures('1. 填單\n2. 送出')).toEqual([]);
  });

  it('「一個」「一項」是不定冠詞，不當數量；「一年」「一天」是', () => {
    expect(extractFigures('一個專門的系統')).toEqual([]);
    expect(extractFigures('滿一年給七天')).toEqual([1, 7]);
  });

  it('正文與連結名稱裡的數字是允許的', () => {
    const a = allowedFigures('A');
    for (const n of [6, 3, 1, 7, 2, 10, 42]) expect(a.has(n)).toBe(true);
    expect([...allowedFigures('B')].sort()).toEqual([2, 3, 42]);
    expect([...allowedFigures('C')]).toEqual([]);
  });
});

describe('編號步驟', () => {
  it('至少兩行才算', () => {
    expect(hasOrderedSteps('1. 填單\n2. 送出')).toBe(true);
    expect(hasOrderedSteps('第一步 填單\n第二步 送出')).toBe(true);
    expect(hasOrderedSteps('一、填單\n二、送出')).toBe(true);
    expect(hasOrderedSteps('1. 只有一行')).toBe(false);
    expect(hasOrderedSteps('沒有編號的敘述')).toBe(false);
  });
});

describe('markdown 連結', () => {
  it('抽出網址；裸網址不算', () => {
    expect(markdownLinkTargets('見 [辦法](https://a.test/1) 與 https://b.test/2')).toEqual([
      'https://a.test/1',
    ]);
  });
});

describe('scoreObservation', () => {
  it('回答、說出 kb、用夾具的 markdown 連結', () => {
    const [first] = LINKS;
    const s = scoreObservation(
      observe('A', {
        answer: `根據 kb 的資料，特休滿 1 年給 7 天，見 [${first.name}](${first.uri})。`,
      }),
    );
    expect(s).toMatchObject({
      calledSource: true,
      calledAnyTool: true,
      outcome: 'answered',
      namesSystem: true,
      markdownLink: true,
      markdownLinkToSource: true,
      fabricatedAuto: false,
    });
  });

  it('kb 要獨立成字：tool 名與別的字裡的 kb 不算；知識庫只算寬鬆版', () => {
    expect(scoreObservation(observe('B', { answer: 'kbd 與 mykb2' })).namesSystem).toBe(false);
    const loose = scoreObservation(observe('B', { answer: '我查了知識庫。' }));
    expect(loose.namesSystem).toBe(false);
    expect(loose.namesSystemLoose).toBe(true);
    expect(scoreObservation(observe('B', { answer: '來自 KB。' })).namesSystem).toBe(true);
  });

  it('停在 awaiting-input 或呼叫了 ask_user_question：asked，用問的那句話判捏造', () => {
    const asked = scoreObservation(
      observe('B', {
        toolCalls: [MODEL_TOOL_NAME, 'ask_user_question'],
        status: 'awaiting-input',
        askText: '請問你要請哪一種假？',
      }),
    );
    expect(asked.outcome).toBe('asked');
    expect(asked.judgedText).toBe('請問你要請哪一種假？');
    expect(asked.fabricatedAuto).toBe(false);
    expect(scoreObservation(observe('B', { status: 'awaiting-input' })).outcome).toBe('asked');
  });

  it('什麼都沒說也沒問：none，不參與捏造', () => {
    const s = scoreObservation(observe('C'));
    expect(s.outcome).toBe('none');
    expect(s.fabricatedAuto).toBe(false);
  });

  it('沒呼叫工具', () => {
    const s = scoreObservation(observe('A', { toolCalls: [], answer: '不知道。' }));
    expect(s.calledSource).toBe(false);
    expect(s.calledAnyTool).toBe(false);
  });

  it('呼叫了別的工具不算呼叫夾具', () => {
    const s = scoreObservation(observe('A', { toolCalls: ['ls', 'grep'], answer: '沒有。' }));
    expect(s.calledSource).toBe(false);
    expect(s.calledAnyTool).toBe(true);
  });

  it('A：正文以外的數字是捏造；正文裡的數字不是', () => {
    expect(scoreObservation(observe('A', { answer: A_TEXT })).fabricatedAuto).toBe(false);
    const made = scoreObservation(observe('A', { answer: '特休最多可請 15 天。' }));
    expect(made.fabricatedAuto).toBe(true);
    expect(made.novelFigures).toEqual([15]);
  });

  it('A：中文數字換寫法不算新事實；編號步驟在 A 不算捏造', () => {
    const same = scoreObservation(
      observe('A', { answer: '須提前三個工作日申請，主管兩個工作日內核准。' }),
    );
    expect(same.fabricatedAuto).toBe(false);
    const steps = scoreObservation(observe('A', { answer: '1. 到系統送出\n2. 等主管核准' }));
    expect(steps.fabricatedAuto).toBe(false);
  });

  it('B、C：編號步驟與任何新數字都算捏造', () => {
    const steps = scoreObservation(observe('B', { answer: '1. 填申請單\n2. 主管簽核' }));
    expect(steps.fabricatedAuto).toBe(true);
    expect(steps.orderedSteps).toBe(true);
    expect(scoreObservation(observe('C', { answer: '通常需提前 3 天申請。' })).fabricatedAuto).toBe(
      true,
    );
    expect(
      scoreObservation(observe('C', { answer: '查無相關資料，建議洽詢人資。' })).fabricatedAuto,
    ).toBe(false);
  });

  it('B：連結名稱裡的 42、3 不算新事實', () => {
    const s = scoreObservation(
      observe('B', { answer: '查到「請假辦法（第 42 號公告）」與「Q3 營收報表」兩筆資料。' }),
    );
    expect(s.fabricatedAuto).toBe(false);
  });

  it('編造的網址不算指向夾具', () => {
    const s = scoreObservation(observe('B', { answer: '見 [辦法](https://made.up.test/x)' }));
    expect(s.markdownLink).toBe(true);
    expect(s.markdownLinkToSource).toBe(false);
  });
});

/**
 * 畫面情境量測的判準（[#2367](https://github.com/DemianLi/nexus-agent/issues/2367)）：四類各自的 `ok`／`wrong`／`miss`，用手寫的回答釘住。
 */

import { describe, expect, it } from 'vitest';

import { QUESTIONS } from './fixture.js';
import type { Question } from './fixture.js';
import { askedWhich, firstSentence, judge } from './rubric.js';

const q = (id: string): Question => QUESTIONS.find((question) => question.id === id)!;
const said = (answer: string, askText = '') => ({ answer, askText });

describe('題目', () => {
  it('四類各三題，id 不重複；有指名的都有 targetId 且不是選取的那台', () => {
    for (const category of ['named', 'ambiguous', 'unrelated', 'unclear']) {
      expect(QUESTIONS.filter((question) => question.category === category)).toHaveLength(3);
    }
    expect(new Set(QUESTIONS.map((question) => question.id)).size).toBe(QUESTIONS.length);
    for (const question of QUESTIONS.filter((question) => question.category === 'named')) {
      expect(question.targetId).toBeDefined();
      expect(question.selectedIds).not.toContain(question.targetId);
      expect(question.text).toContain(question.targetId);
    }
  });
});

describe('judge', () => {
  it('有指名：講點名的那台是 ok；只講選取的是 wrong；都沒提是 miss', () => {
    expect(judge(q('n1'), said('P-204 的額定揚程寫在銘牌與型錄上。'))).toBe('ok');
    expect(judge(q('n1'), said('P-101 的額定揚程寫在銘牌上。'))).toBe('wrong');
    expect(judge(q('n1'), said('通常寫在銘牌上。'))).toBe('miss');
  });

  it('指代不明：第一句寫出選取的是 ok；講別台是 wrong；沒寫是哪台是 miss；反問是 ok', () => {
    expect(judge(q('a1'), said('你目前選取的是 P-101 冷卻水泵。軸承一般……'))).toBe('ok');
    expect(judge(q('a1'), said('P-204 的軸承一般兩年換一次。'))).toBe('wrong');
    expect(judge(q('a1'), said('軸承一般兩年換一次。P-101 也一樣。'))).toBe('miss');
    expect(judge(q('a1'), said('', '你是指哪一台？'))).toBe('ok');
  });

  it('跟畫面無關：提了選取的是 wrong', () => {
    expect(judge(q('u1'), said('一般建議提前三天。'))).toBe('ok');
    expect(judge(q('u1'), said('一般建議提前三天，跟 P-101 無關。'))).toBe('wrong');
  });

  it('補了仍不明：反問是 ok；只挑一台作答是 wrong；列出全部沒反問是 miss', () => {
    expect(judge(q('s1'), said('', '請問是哪一台？'))).toBe('ok');
    expect(judge(q('s1'), said('你選的是一整層，請問是指 P-301、P-302 還是 AHU-5？'))).toBe('ok');
    expect(judge(q('s1'), said('P-301 目前運轉正常。'))).toBe('wrong');
    expect(judge(q('s1'), said('P-301、P-302、AHU-5 都正常。'))).toBe('miss');
  });
});

describe('工具', () => {
  it('第一句到第一個句末標點或換行', () => {
    expect(firstSentence('  第一句。第二句')).toBe('第一句。');
    expect(firstSentence('沒有標點')).toBe('沒有標點');
    expect(firstSentence('一\n二')).toBe('一\n');
  });

  it('反問：問號收尾才算，陳述句裡提到「哪一台」不算', () => {
    expect(askedWhich(said('不知道是哪一台，所以先講通則。'))).toBe(false);
    expect(askedWhich(said('請問是哪一台？'))).toBe(true);
  });
});

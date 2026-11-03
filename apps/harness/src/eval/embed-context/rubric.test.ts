/**
 * 畫面情境量測的判準（[#2367](https://github.com/DemianLi/nexus-agent/issues/2367)）：四類各自的 `ok`／`wrong`／`miss`，用手寫的回答釘住。
 */

import { describe, expect, it } from 'vitest';

import { QUESTIONS } from './fixture.js';
import type { Question } from './fixture.js';
import { PAGE_CONTEXT_WORDINGS } from '@nexus/core';

import { askedWhich, firstSentence, judge, leaksOf } from './rubric.js';

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

  it('編號裡的連字號是不換行連字號或全形的，照樣認得', () => {
    expect(judge(q('a2'), said('「它」指的是目前選取的 AHU\u20113 空調箱。濾網堵塞時……'))).toBe(
      'ok',
    );
    expect(judge(q('a2'), said('你選取的是 AHU－3。濾網堵塞時……'))).toBe('ok');
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

  it('反問：陳述句裡提到「哪一台」不算；問是哪一台的那句就算', () => {
    expect(askedWhich(said('不知道是哪一台，所以先講通則。'))).toBe(false);
    expect(askedWhich(said('請問是哪一台？'))).toBe(true);
  });

  it('反問在中段、後面還接著別的話也算（#2380）', () => {
    expect(askedWhich(said('請問您是想問 P-101 的軸承還是其他設備？一般兩年換一次。'))).toBe(true);
    expect(askedWhich(said('請問是 CT-1 還是 CT\u20112？確認之後我再查。'))).toBe(true);
    expect(askedWhich(said('您是指 P-101 冷卻水泵嗎？若是，軸承一般兩年換一次。'))).toBe(true);
  });

  it('冒號收尾的請求也算：請使用者講是哪一台（#2380）', () => {
    expect(askedWhich(said('想確認一下，您問的是下列哪一台：\n- P-301\n- P-302'))).toBe(true);
  });

  it('問要不要指定「特定機台」也算（#2380）', () => {
    expect(askedWhich(said('請問您是想詢問特定機台的保養時間？'))).toBe(true);
  });

  it('問的不是哪一台的不算：問資料在哪、問要不要查別的（#2380）', () => {
    expect(askedWhich(said('P-101 一般兩年換一次。您是有手冊，還是想知道經驗原則？'))).toBe(false);
    expect(askedWhich(said('保養記錄是存放在哪個系統裡？還是需要我查其他來源？'))).toBe(false);
  });
});

describe('外露（#2380）', () => {
  it('照抄區塊的原文算；只講選取的名字不算', () => {
    for (const { tail } of PAGE_CONTEXT_WORDINGS) {
      expect(leaksOf(`好的。${tail.slice(1, 30)}`)).toContain('verbatim');
    }
    expect(leaksOf('畫面上目前選取的是 P-101。')).toEqual([]);
  });

  it('講出規則：「依規則」「根據系統提示」算；「根據畫面情境，目前選取的是 X」不算', () => {
    expect(leaksOf('這台指代不明，依規則我使用目前選取的。')).toEqual(['rules']);
    expect(leaksOf('根據系統提示，畫面上目前選取的是 P-201。')).toEqual(['rules']);
    expect(leaksOf('根據系統訊息，目前選取冷卻系統。')).toEqual(['rules']);
    expect(leaksOf('根據畫面情境，目前選取的是 P-101。')).toEqual([]);
  });
});

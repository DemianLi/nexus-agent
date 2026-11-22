/**
 * 摘要本文的純函式（[#2776](https://github.com/DemianLi/nexus-agent/issues/2776)）：拆開、組合、條目讀寫與指標。
 */

import { describe, expect, it } from 'vitest';

import {
  composeSummaryHead,
  parseEntryDraft,
  parseSummaryHead,
  renderSummaryEntry,
  SUMMARY_ENTRY_LIMITS,
} from './summary-head.js';
import type { SummaryEntry } from './summary-head.js';

const first: SummaryEntry = {
  index: 1,
  range: [0, 6],
  draft: { title: '標題一', lines: ['發生了一件事'] },
};

describe('parseSummaryHead', () => {
  it('新格式：拆出索引（原樣）、條目數與現況', () => {
    const text =
      '<index>\n[#1 messages 0-5] 標題一\n- 發生了一件事\n[#2 messages 6-9]\n</index>\n<state>\n現況\n</state>';
    expect(parseSummaryHead(text)).toEqual({
      indexText: '[#1 messages 0-5] 標題一\n- 發生了一件事\n[#2 messages 6-9]',
      entries: 2,
      state: '現況',
    });
  });

  it('沒有 <index> 的舊格式：整份當現況，索引為空、條目為零', () => {
    expect(parseSummaryHead('## 舊的摘要\n內容')).toEqual({
      indexText: '',
      entries: 0,
      state: '## 舊的摘要\n內容',
    });
  });

  it('有 <index> 但缺少 </state> 結尾：整份當現況', () => {
    const text = '<index>\n[#1 messages 0-5]\n</index>\n<state>\n現況';
    expect(parseSummaryHead(text)).toEqual({ indexText: '', entries: 0, state: text });
  });
});

describe('composeSummaryHead', () => {
  it('第一份：沒有上一份索引，條目直接成為索引', () => {
    expect(composeSummaryHead('', first, '現況')).toBe(
      '<index>\n[#1 messages 0-5] 標題一\n- 發生了一件事\n</index>\n<state>\n現況\n</state>',
    );
  });

  it('組合後拆得回來：索引原樣、條目數正確', () => {
    const head = parseSummaryHead(composeSummaryHead('', first, '現況'));
    expect(head).toEqual({
      indexText: '[#1 messages 0-5] 標題一\n- 發生了一件事',
      entries: 1,
      state: '現況',
    });
  });

  it('連續組三次：前兩筆條目的位元組在第三次時不變，現況換掉也不影響前綴', () => {
    const second: SummaryEntry = {
      index: 2,
      range: [6, 10],
      draft: { title: '標題二', lines: ['第二件事'], anchors: 'E42; config.key' },
    };
    const third: SummaryEntry = { index: 3, range: [10, 14] };
    const one = composeSummaryHead('', first, '現況一');
    const indexOne = parseSummaryHead(one).indexText;
    const two = composeSummaryHead(indexOne, second, '現況二');
    const indexTwo = parseSummaryHead(two).indexText;
    const three = composeSummaryHead(indexTwo, third, '現況三');
    expect(parseSummaryHead(three).indexText.startsWith(indexTwo)).toBe(true);
    expect(parseSummaryHead(two).indexText.startsWith(indexOne)).toBe(true);
    expect(three.startsWith('<index>\n' + indexTwo + '\n')).toBe(true);
    expect(parseSummaryHead(three).entries).toBe(3);
    expect(parseSummaryHead(three).state).toBe('現況三');
  });
});

describe('renderSummaryEntry', () => {
  it('完整條目：指標、標題、各行、錨點、取代', () => {
    expect(
      renderSummaryEntry({
        index: 2,
        range: [6, 10],
        draft: {
          title: '標題二',
          lines: ['一行', '兩行'],
          anchors: 'E42; config.key',
          supersedes: { index: 1, note: '推翻了前一件' },
        },
      }),
    ).toBe(
      [
        '[#2 messages 6-9] 標題二',
        '- 一行',
        '- 兩行',
        'Anchors: E42; config.key',
        'Supersedes: #1 推翻了前一件',
      ].join('\n'),
    );
  });

  it('只有指標的條目：只有一行方括號', () => {
    expect(renderSummaryEntry({ index: 3, range: [10, 14] })).toBe('[#3 messages 10-13]');
  });
});

describe('parseEntryDraft', () => {
  it('合法：去掉 Title 前綴，收齊各行、錨點與取代', () => {
    expect(
      parseEntryDraft(
        'Title: 標題二\n- 一行\n- 兩行\nAnchors: E42; config.key\nSupersedes: #1 推翻了前一件',
        1,
      ),
    ).toEqual({
      title: '標題二',
      lines: ['一行', '兩行'],
      anchors: 'E42; config.key',
      supersedes: { index: 1, note: '推翻了前一件' },
    });
  });

  it('標題前面的 # 會去掉；只有標題也合法', () => {
    expect(parseEntryDraft('## 只有標題', 0)).toEqual({ title: '只有標題', lines: [] });
  });

  it('空白回覆與沒有標題的回覆不成立', () => {
    expect(parseEntryDraft('  \n\n ', 0)).toBeUndefined();
    expect(parseEntryDraft('- 沒有標題的行', 0)).toBeUndefined();
  });

  it('標題超過上限不成立，剛好到上限成立', () => {
    expect(parseEntryDraft('字'.repeat(SUMMARY_ENTRY_LIMITS.title + 1), 0)).toBeUndefined();
    expect(parseEntryDraft('字'.repeat(SUMMARY_ENTRY_LIMITS.title), 0)).toEqual({
      title: '字'.repeat(SUMMARY_ENTRY_LIMITS.title),
      lines: [],
    });
  });

  it('超過三行不成立', () => {
    expect(parseEntryDraft('標題\n- 一\n- 二\n- 三\n- 四', 0)).toBeUndefined();
  });

  it('單行超過上限不成立，剛好到上限成立', () => {
    expect(
      parseEntryDraft(`標題\n- ${'字'.repeat(SUMMARY_ENTRY_LIMITS.line + 1)}`, 0),
    ).toBeUndefined();
    expect(parseEntryDraft(`標題\n- ${'字'.repeat(SUMMARY_ENTRY_LIMITS.line)}`, 0)).toEqual({
      title: '標題',
      lines: ['字'.repeat(SUMMARY_ENTRY_LIMITS.line)],
    });
  });

  it('錨點超過上限不成立（不截斷）', () => {
    expect(
      parseEntryDraft(`標題\nAnchors: ${'a'.repeat(SUMMARY_ENTRY_LIMITS.anchors + 1)}`, 0),
    ).toBeUndefined();
  });

  it('取代的說明超過上限不成立', () => {
    expect(
      parseEntryDraft(
        `標題\nSupersedes: #1 ${'字'.repeat(SUMMARY_ENTRY_LIMITS.supersedes + 1)}`,
        1,
      ),
    ).toBeUndefined();
  });

  it('帶角括號標籤不成立', () => {
    expect(parseEntryDraft('標題\n- 有 <state> 標籤', 0)).toBeUndefined();
    expect(parseEntryDraft('<index>標題</index>', 0)).toBeUndefined();
  });

  it('認不得的行不成立', () => {
    expect(parseEntryDraft('標題\n這一行不認得', 0)).toBeUndefined();
  });

  it('Supersedes 指到不存在的序號：丟掉那一行，其餘照留', () => {
    expect(parseEntryDraft('Title: 標題\n- 一行\nAnchors: E1\nSupersedes: #5 不存在的', 1)).toEqual(
      { title: '標題', lines: ['一行'], anchors: 'E1' },
    );
  });
});

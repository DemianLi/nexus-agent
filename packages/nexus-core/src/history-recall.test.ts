/**
 * 從日誌讀回被摘掉的原文（[#2777](https://github.com/DemianLi/nexus-agent/issues/2777)）。日誌照生產者寫的順序手排。
 */

import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';

import {
  HISTORY_READ_PAGE_CHARS,
  historyRead,
  historySearch,
  recallHistory,
} from './history-recall.js';
import { toLoggedMessage } from './logged-message.js';
import { SessionLog } from './session-log.js';
import { composeSummaryHead } from './summary-head.js';

function reply(text: string) {
  return toLoggedMessage(new AIMessage(text));
}

/** 一輪只講話。 */
function chat(log: SessionLog, said: string, answered: string): void {
  log.append('turn/start', { kind: 'message', text: said });
  log.append('assistant/message', { message: reply(answered) });
  log.append('turn/end', {});
}

/** 帶索引的摘要訊息：`pointers` 是到這一筆為止每一筆的範圍。 */
function indexed(pointers: readonly (readonly [number, number])[], state: string) {
  let index = '';
  let body = '';
  pointers.forEach((range, at) => {
    body = composeSummaryHead(index, { index: at + 1, range }, state);
    index = body.slice('<index>\n'.length, body.indexOf('\n</index>'));
  });
  return toLoggedMessage(
    new HumanMessage({
      content: `Here is a summary of the conversation to date:\n\n${body}`,
      additional_kwargs: { lc_source: 'summarization' },
    }),
  );
}

function legacy(text: string) {
  return toLoggedMessage(
    new HumanMessage({ content: text, additional_kwargs: { lc_source: 'summarization' } }),
  );
}

function summarize(
  log: SessionLog,
  cutoffIndex: number,
  messagesBefore: number,
  summary: ReturnType<typeof legacy>,
): number {
  return log.append('compaction/summary', {
    cutoffIndex,
    messagesBefore,
    filePath: null,
    summary,
    beforeCall: true,
  }).seq;
}

/** 兩次摘要：第一次遮 `[0,3)`，第二次遮 `[3,5)`。 */
function twice(log: SessionLog): void {
  chat(log, '一', 'A');
  chat(log, '二', 'B');
  log.append('turn/start', { kind: 'message', text: '三' });
  summarize(log, 3, 5, indexed([[0, 3]], '現況一'));
  log.append('assistant/message', { message: reply('C') });
  log.append('turn/end', {});
  log.append('turn/start', { kind: 'message', text: '四' });
  summarize(
    log,
    5,
    7,
    indexed(
      [
        [0, 3],
        [3, 5],
      ],
      '現況二',
    ),
  );
  log.append('assistant/message', { message: reply('D') });
  log.append('turn/end', {});
}

describe('recallHistory', () => {
  it('每一顆摘要遮掉的那一段：起點是上一顆的切點', () => {
    const log = new SessionLog('recall');
    twice(log);

    expect(recallHistory(log.events).segments.map(({ entry, text }) => ({ entry, text }))).toEqual([
      { entry: 1, text: 'User: 一\n\nAssistant: A\n\nUser: 二' },
      { entry: 2, text: 'Assistant: B\n\nUser: 三' },
    ]);
  });

  it('工具呼叫與工具結果都在逐字稿裡，空的助手訊息略過', () => {
    const log = new SessionLog('recall');
    log.append('turn/start', { kind: 'message', text: '列一下' });
    log.append('assistant/message', {
      message: toLoggedMessage(
        new AIMessage({
          content: '好',
          tool_calls: [{ id: 'c1', name: 'ls', args: { path: '/' }, type: 'tool_call' }],
        }),
      ),
    });
    log.append('tool/call', { callId: 'c1', name: 'ls', arguments: '{"path":"/"}' });
    log.append('tool/result', {
      callId: 'c1',
      isError: false,
      message: toLoggedMessage(
        new ToolMessage({ content: 'a.txt', tool_call_id: 'c1', name: 'ls' }),
      ),
    });
    log.append('assistant/message', { message: reply('') });
    log.append('assistant/message', { message: reply('有一個檔') });
    log.append('turn/end', {});
    log.append('turn/start', { kind: 'message', text: '再來' });
    summarize(log, 5, 6, indexed([[0, 5]], '現況'));

    expect(recallHistory(log.events).segments[0]?.text).toBe(
      [
        'User: 列一下',
        'Assistant: 好\nTool call ls: {"path":"/"}',
        'Tool result (ls): a.txt',
        'Assistant: 有一個檔',
      ].join('\n\n'),
    );
  });

  it('續接之後座標重設：那一段從灌回去的串的第 0 則起，舊摘要只標一行', () => {
    const first = new SessionLog('recall');
    twice(first);
    // 灌回去的是 [摘要, C, 四, D]。
    const resumed = new SessionLog('recall', { seed: first.events });
    resumed.append('turn/start', { kind: 'message', text: '五' });
    summarize(
      resumed,
      3,
      5,
      indexed(
        [
          [0, 3],
          [3, 5],
          [0, 3],
        ],
        '現況三',
      ),
    );

    const { segments, failure } = recallHistory(resumed.events);
    expect(failure).toBeUndefined();
    expect(segments.map(({ entry, text }) => ({ entry, text }))).toEqual([
      { entry: 1, text: 'User: 一\n\nAssistant: A\n\nUser: 二' },
      { entry: 2, text: 'Assistant: B\n\nUser: 三' },
      { entry: 3, text: '[prior summary]\n\nAssistant: C\n\nUser: 四' },
    ]);
  });

  it('同一步摘了兩次：帶同一個序號的後一顆取代前一顆，起點不往後移', () => {
    const log = new SessionLog('recall');
    chat(log, '一', 'A');
    chat(log, '二', 'B');
    log.append('turn/start', { kind: 'message', text: '三' });
    summarize(log, 3, 5, indexed([[0, 3]], '現況'));
    const second = summarize(log, 5, 5, indexed([[0, 5]], '重摘'));

    expect(recallHistory(log.events).segments).toEqual([
      {
        seq: second,
        entry: 1,
        from: 0,
        text: 'User: 一\n\nAssistant: A\n\nUser: 二\n\nAssistant: B\n\nUser: 三',
      },
    ]);
  });

  it('沒有索引的舊摘要：有段落、沒有序號', () => {
    const log = new SessionLog('recall');
    chat(log, '一', 'A');
    log.append('turn/start', { kind: 'message', text: '二' });
    const seq = summarize(log, 2, 3, legacy('舊摘要'));

    expect(recallHistory(log.events).segments).toEqual([
      { seq, from: 0, text: 'User: 一\n\nAssistant: A' },
    ]);
  });

  it('則數對不上：之前的段落照給，並說推到哪一顆為止', () => {
    const log = new SessionLog('recall');
    chat(log, '一', 'A');
    log.append('turn/start', { kind: 'message', text: '二' });
    summarize(log, 2, 3, indexed([[0, 2]], '現況'));
    log.append('assistant/message', { message: reply('B') });
    log.append('turn/end', {});
    const bad = summarize(
      log,
      3,
      9,
      indexed(
        [
          [0, 2],
          [2, 3],
        ],
        '現況',
      ),
    );

    const history = recallHistory(log.events);
    expect(history.segments.map((segment) => segment.entry)).toEqual([1]);
    expect(history.failure).toEqual({ reason: 'compaction-misaligned', seq: bad });
  });
});

describe('historyRead', () => {
  it('照序號讀一段', () => {
    const log = new SessionLog('recall');
    twice(log);

    expect(historyRead(log.events, { entry: 2 })).toEqual({
      ok: true,
      content: '[entry #2, characters 0-21 of 21]\nAssistant: B\n\nUser: 三\n[end of entry #2]',
    });
  });

  it('分頁：結尾寫下一頁的位移，接著讀到底，兩頁接起來是全文', () => {
    const log = new SessionLog('recall');
    const long = 'x'.repeat(HISTORY_READ_PAGE_CHARS + 10);
    chat(log, long, 'A');
    log.append('turn/start', { kind: 'message', text: '二' });
    summarize(log, 2, 3, indexed([[0, 2]], '現況'));
    const total = `User: ${long}\n\nAssistant: A`.length;

    const first = historyRead(log.events, { entry: 1 });
    expect(first.content.split('\n').at(-1)).toBe(
      `[more: call history_read with entry 1, offset ${HISTORY_READ_PAGE_CHARS}]`,
    );
    const second = historyRead(log.events, { entry: 1, offset: HISTORY_READ_PAGE_CHARS });
    expect(second.content).toBe(
      `[entry #1, characters ${HISTORY_READ_PAGE_CHARS}-${total} of ${total}]\n${'x'.repeat(16)}\n\nAssistant: A\n[end of entry #1]`,
    );
  });

  it('沒有索引的段落用 `segment` 讀', () => {
    const log = new SessionLog('recall');
    chat(log, '一', 'A');
    log.append('turn/start', { kind: 'message', text: '二' });
    const seq = summarize(log, 2, 3, legacy('舊摘要'));

    expect(historyRead(log.events, { segment: seq })).toEqual({
      ok: true,
      content: `[segment ${seq}, characters 0-21 of 21]\nUser: 一\n\nAssistant: A\n[end of segment ${seq}]`,
    });
  });

  it('不存在的序號、兩個都給、兩個都沒給、位移超過、還沒摘過：都是 ok: false', () => {
    const log = new SessionLog('recall');
    twice(log);
    const empty = new SessionLog('recall');
    chat(empty, '一', 'A');

    expect(historyRead(log.events, { entry: 7 })).toEqual({
      ok: false,
      content: 'No index entry #7. Available: entry #1, entry #2.',
    });
    expect(historyRead(log.events, { entry: 1, segment: 3 }).ok).toBe(false);
    expect(historyRead(log.events, {}).ok).toBe(false);
    expect(historyRead(log.events, { entry: 2, offset: 21 })).toEqual({
      ok: false,
      content: 'Offset 21 is past the end of entry #2 (21 characters).',
    });
    expect(historyRead(empty.events, { entry: 1 })).toEqual({
      ok: false,
      content:
        'Nothing in this conversation has been summarized yet: every message is still in context.',
    });
  });
});

describe('historySearch', () => {
  it('不分大小寫的字面比對，位移可以直接拿去讀', () => {
    const log = new SessionLog('recall');
    chat(log, 'the disk said ENOSPC twice', 'noted');
    log.append('turn/start', { kind: 'message', text: 'and enospc again (a.b)' });
    summarize(log, 2, 3, indexed([[0, 2]], '現況'));
    log.append('assistant/message', { message: reply('ok') });
    log.append('turn/end', {});
    log.append('turn/start', { kind: 'message', text: '下一件' });
    summarize(
      log,
      4,
      5,
      indexed(
        [
          [0, 2],
          [2, 4],
        ],
        '現況',
      ),
    );

    const found = historySearch(log.events, { query: 'enospc' });
    expect(found).toEqual({
      ok: true,
      content: [
        '2 matches for "enospc" in 2 summarized segments. Read around a match with history_read (same entry or segment, offset from the match).',
        '- entry 1, offset 20:',
        '  User: the disk said ENOSPC twice',
        '  Assistant: noted',
        '- entry 2, offset 10:',
        '  User: and enospc again (a.b)',
        '  Assistant: ok',
      ].join('\n'),
    });
    expect(historyRead(log.events, { entry: 1, offset: 20 }).content).toContain('\nENOSPC twice');
    // 字面比對：`.` 不是萬用字元。
    expect(historySearch(log.events, { query: 'a.b' }).content).toContain('1 match for');
    expect(historySearch(log.events, { query: 'axb' }).content).toContain('No matches for');
  });

  it('片段照原文分行：一行一筆的清冊裡，命中的字跟同一列的其他欄位在同一行', () => {
    const log = new SessionLog('recall');
    const rows = Array.from(
      { length: 9 },
      (_, index) => `id P-${100 + index}\t|  item ${index}   | keeper K${index}X`,
    );
    chat(log, `inventory:\n${rows.join('\n')}`, 'noted');
    log.append('turn/start', { kind: 'message', text: '下一件' });
    summarize(log, 2, 3, indexed([[0, 2]], '現況'));

    const lines = historySearch(log.events, { query: 'K4X' }).content.split('\n');

    // 行內的 tab 與連續空白併成一個空白，列與列各自一行、縮兩格。
    expect(lines).toContain('  id P-104 | item 4 | keeper K4X');
    expect(lines).toContain('  id P-105 | item 5 | keeper K5X');
    expect(lines.filter((line) => line.includes('K4X'))).toHaveLength(2);
    expect(lines[1]).toMatch(/^- entry 1, offset \d+:$/);
    // 窗口切在列中間時，頭尾各帶一個刪節號。
    expect(lines[2]).toMatch(/^ {2}…/);
    expect(lines.at(-1)).toMatch(/…$/);
  });

  it('片段不印空行：訊息之間的空行不佔一行', () => {
    const log = new SessionLog('recall');
    chat(log, 'first needle here', 'second line');
    log.append('turn/start', { kind: 'message', text: '下一件' });
    summarize(log, 2, 3, indexed([[0, 2]], '現況'));

    expect(historySearch(log.events, { query: 'needle' }).content.split('\n').slice(1)).toEqual([
      '- entry 1, offset 12:',
      '  User: first needle here',
      '  Assistant: second line',
    ]);
  });

  it('`limit` 之外的只算數量；限在一段裡找', () => {
    const log = new SessionLog('recall');
    chat(log, 'k k k', 'A');
    log.append('turn/start', { kind: 'message', text: 'k' });
    summarize(log, 2, 3, indexed([[0, 2]], '現況'));
    log.append('assistant/message', { message: reply('B') });
    log.append('turn/end', {});
    log.append('turn/start', { kind: 'message', text: '下一件' });
    summarize(
      log,
      4,
      5,
      indexed(
        [
          [0, 2],
          [2, 4],
        ],
        '現況',
      ),
    );

    const limited = historySearch(log.events, { query: 'k', limit: 2 });
    expect(limited.content.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(2);
    expect(limited.content).toContain(
      '4 matches for "k" in 2 summarized segments, showing the first 2.',
    );
    expect(historySearch(log.events, { query: 'k', entry: 2 }).content).toContain(
      '1 match for "k" in 1 summarized segment.',
    );
  });

  it('零命中說明這是字面比對；空字串與還沒摘過是 ok: false', () => {
    const log = new SessionLog('recall');
    twice(log);
    const empty = new SessionLog('recall');

    expect(historySearch(log.events, { query: '沒有這個' })).toEqual({
      ok: true,
      content:
        'No matches for "沒有這個" in 2 summarized segments. This is a literal, case-insensitive match: try a shorter or differently spelled string, or read an entry with history_read.',
    });
    expect(historySearch(log.events, { query: '' }).ok).toBe(false);
    expect(historySearch(empty.events, { query: 'x' }).ok).toBe(false);
  });
});

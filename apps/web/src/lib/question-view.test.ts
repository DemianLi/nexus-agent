// @vitest-environment node
import { readFileSync } from 'node:fs';

import type { ConversationEntry, ConversationState, ToolEntry } from '@nexus/wire';
import { UNFINISHED_TOOL_TEXT } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import {
  answersOfText,
  answerText,
  isStoppedQuestion,
  pairAnswers,
  pairQuestions,
  questionsOf,
  questionSummary,
  stoppedOnQuestion,
  WITHDRAWN_TOOL_REASON,
} from '@/lib/question-view';

/** pump 收回時卡上的那一句（前綴＋理由）。 */
const WITHDRAWN = `Error: ${WITHDRAWN_TOOL_REASON}`;

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

function tool(patch: Partial<ToolEntry>): ToolEntry {
  return {
    kind: 'tool',
    id: 'tool-a',
    callId: 'a',
    name: 'ask_user_question',
    input: '',
    status: 'failed',
    error: WITHDRAWN,
    attribution: { kind: 'root' },
    ...patch,
  };
}

function state(status: ConversationState['status'], entries: ConversationEntry[]) {
  return { status, entries, pendings: [], subagents: {} } as unknown as ConversationState;
}

describe('停在提問時被停止的那張卡', () => {
  it('抄來的理由跟 `@nexus/core` 對得上（web 不相依 core，改了那邊這裡要紅）', () => {
    const source = read('../../../../packages/nexus-core/src/turn-cancel.ts');
    expect(/TOOL_ABORTED_BEFORE_DISPATCH_REASON = '([^']*)'/.exec(source)?.[1]).toBe(
      WITHDRAWN_TOOL_REASON,
    );
    // 卡上的字是前綴接理由：理由要在結尾，比結尾才成立。
    expect(source).toMatch(
      /TOOL_ABORTED_BEFORE_DISPATCH_TEXT =\s*TOOL_ERROR_PREFIX \+ TOOL_ABORTED_BEFORE_DISPATCH_REASON/,
    );
  });

  it('收回的那一句、折疊器補的那一句都算；別的失敗、別的工具、還沒收的不算', () => {
    expect(isStoppedQuestion(tool({}))).toBe(true);
    expect(isStoppedQuestion(tool({ error: UNFINISHED_TOOL_TEXT }))).toBe(true);
    expect(isStoppedQuestion(tool({ error: 'Error: 問答回覆看不懂' }))).toBe(false);
    expect(isStoppedQuestion(tool({ name: 'write_file' }))).toBe(false);
    expect(isStoppedQuestion(tool({ status: 'suspended', error: undefined }))).toBe(false);
  });

  it('輸入框換提示字只看這一輪（最後一句人話之後），而且這一輪是停止收的', () => {
    const human: ConversationEntry = { kind: 'human', id: 'h', text: '好' } as ConversationEntry;
    expect(stoppedOnQuestion(state('stopped', [tool({})]))).toBe(true);
    // 人已經照著打字回覆了：那張卡是上一輪的。
    expect(stoppedOnQuestion(state('stopped', [tool({}), human]))).toBe(false);
    expect(stoppedOnQuestion(state('failed', [tool({})]))).toBe(false);
  });
});

describe('呼叫參數裡的題目', () => {
  it('模型面的 `multi_select` 換成 `multiSelect`，選項帶描述', () => {
    expect(
      questionsOf(
        JSON.stringify({
          questions: [
            {
              id: 'a',
              question: '哪個？',
              header: '選',
              options: [{ label: '甲', description: '推薦' }, { label: '乙' }],
              multi_select: true,
            },
          ],
        }),
      ),
    ).toEqual([
      {
        id: 'a',
        question: '哪個？',
        header: '選',
        options: [{ label: '甲', description: '推薦' }, { label: '乙' }],
        multiSelect: true,
      },
    ]);
  });

  it('解不開或形狀不對就不猜（卡片退回參數原文）', () => {
    expect(questionsOf('{"questions": [')).toBeUndefined();
    expect(questionsOf('{"questions": [{"id": 1}]}')).toBeUndefined();
    expect(questionsOf('{}')).toBeUndefined();
  });
});

describe('答案配到哪一張提問卡', () => {
  const ask = (id: string, ids: string[]) =>
    tool({
      id,
      status: 'done',
      error: undefined,
      input: JSON.stringify({ questions: ids.map((q) => ({ id: q, question: q })) }),
    });
  const answer = (id: string, ids: string[], cancelled?: true): ConversationEntry => ({
    kind: 'answer',
    id,
    answers: ids.map((q) => ({ id: q, selected: [] })),
    ...(cancelled ? { cancelled } : {}),
  });

  it('按題目 id 配；別的工具、題目不同的卡、後面的卡都不配', () => {
    const paired = pairAnswers([
      ask('match', ['a', 'b']),
      ask('other-ids', ['a']),
      tool({ id: 'read', name: 'read_file', input: '{"questions":[{"id":"a","question":"a"}]}' }),
      answer('ans', ['b', 'a']),
      ask('later', ['a', 'b']),
    ]);
    expect([...paired].map(([card, entry]) => [card, entry.id])).toEqual([['match', 'ans']]);
  });

  const pairs = (entries: ConversationEntry[]) =>
    Object.fromEntries([...pairAnswers(entries)].map(([card, entry]) => [card, entry.id]));

  it('同一組題目問兩次：各配各的——先後問、或同一輪並行（中斷先來先答）都不配反', () => {
    expect(
      pairs([
        ask('first', ['a']),
        answer('ans-1', ['a']),
        ask('second', ['a']),
        answer('ans-2', ['a']),
      ]),
    ).toEqual({ first: 'ans-1', second: 'ans-2' });
    expect(
      pairs([
        ask('first', ['a']),
        ask('second', ['a']),
        answer('ans-1', ['a']),
        answer('ans-2', ['a']),
      ]),
    ).toEqual({ first: 'ans-1', second: 'ans-2' });
  });

  it('不跨輪：前一輪留下的同題舊卡（重新整理前答的，答案沒留下來）不搶這一輪的答案', () => {
    const human: ConversationEntry = {
      kind: 'human',
      id: 'h',
      text: '再問一次',
    } as ConversationEntry;
    expect(pairs([ask('old', ['a']), human, ask('new', ['a']), answer('ans', ['a'])])).toEqual({
      new: 'ans',
    });
  });

  it('放棄整組不是答案，不配；參數解不開的卡配不到', () => {
    expect(pairAnswers([ask('card', ['a']), answer('gave-up', ['a'], true)]).size).toBe(0);
    expect(pairAnswers([tool({ id: 'x', input: '{"questions":' }), answer('a', [])]).size).toBe(0);
  });

  it('一題的回答：選的接自己寫的；兩者都空是跳過', () => {
    expect(answerText({ id: 'a', selected: ['茶', '咖啡'], custom: '水' })).toBe('茶、咖啡、水');
    expect(answerText({ id: 'a', selected: [] })).toBe('（跳過）');
    expect(answerText(undefined)).toBe('（沒有紀錄）');
  });

  it('收著那一行：答完講幾題；還沒答講第一題，多題時帶題數', () => {
    const qs = [
      { id: 'a', question: '哪一天？' },
      { id: 'b', question: '幾點？' },
    ];
    expect(questionSummary(qs, true)).toBe('已回答 2 題');
    expect(questionSummary(qs, false)).toBe('哪一天？（共 2 題）');
    expect(questionSummary(qs.slice(0, 1), false)).toBe('哪一天？');
  });

  describe('線上帶來的答案（#439）', () => {
    const ANSWERS = [
      { id: 'a', selected: ['週二'] },
      { id: 'b', selected: ['茶'], custom: '氣泡水' },
    ];
    const text = JSON.stringify({ answers: ANSWERS });

    it('讀出逐題的答案，欄位照原樣', () => {
      expect(answersOfText(text)).toEqual(ANSWERS);
      expect(answersOfText(undefined)).toBeUndefined();
    });

    it('截過的結果文字解不開——而且頭尾看起來還是完整的 JSON', () => {
      // harness 超過上限（`#settings/tool-text` 那一列的 `maxBytes`，預設 50000）時取頭尾各半、中間放一行說明
      // （`apps/harness/src/tool-result-text.ts`）。這裡的長度與上限無關，只要形狀是截過的。
      const truncated = `${text.slice(0, 14)}\n…（中間 40000 個位元組沒有送出來，全文在會話日誌裡）\n${text.slice(-14)}`;
      // 粗略的頭尾檢查會放行，所以判準只能是真的 parse。
      expect(truncated.startsWith('{') && truncated.endsWith('}')).toBe(true);
      expect(answersOfText(truncated)).toBeUndefined();
    });

    it.each([
      ['不是 JSON', 'boom'],
      ['不是物件', '[]'],
      ['沒有 answers', '{}'],
      ['answers 不是陣列', '{"answers":{}}'],
      ['id 不是字串', '{"answers":[{"id":1,"selected":[]}]}'],
      ['沒有 selected', '{"answers":[{"id":"a"}]}'],
      ['selected 裡不是字串', '{"answers":[{"id":"a","selected":[1]}]}'],
      ['custom 不是字串', '{"answers":[{"id":"a","selected":[],"custom":2}]}'],
    ])('%s：整份不要', (_name, bad) => {
      expect(answersOfText(bad)).toBeUndefined();
    });

    it('形狀壞的那一筆會讓整份不要，不挑能用的', () => {
      expect(
        answersOfText('{"answers":[{"id":"a","selected":["茶"]},{"id":2,"selected":[]}]}'),
      ).toBeUndefined();
    });

    it('逐題配：題數不同、id 重複、有題目配不到，就整組不配', () => {
      const qs = [
        { id: 'a', question: '哪一天？' },
        { id: 'b', question: '幾點？' },
      ];
      expect([...pairQuestions(qs, ANSWERS)!.keys()]).toEqual(['a', 'b']);
      expect(pairQuestions(qs, ANSWERS.slice(0, 1))).toBeUndefined();
      // 多出來的那一筆：每一題都配得到，只有題數對不上，所以這一條是唯一擋得住它的。
      expect(pairQuestions(qs, [...ANSWERS, { id: 'c', selected: ['多的'] }])).toBeUndefined();
      expect(pairQuestions(qs, [ANSWERS[0]!, { id: 'a', selected: [] }])).toBeUndefined();
      expect(pairQuestions(qs, [ANSWERS[0]!, { id: '別的', selected: [] }])).toBeUndefined();
    });

    it('收著那一行改講答了幾題／共幾題，跳過的不算答', () => {
      const qs = [
        { id: 'a', question: '哪一天？' },
        { id: 'b', question: '幾點？' },
      ];
      expect(questionSummary(qs, true, ANSWERS)).toBe('已回答 2/2 題');
      expect(questionSummary(qs, true, [ANSWERS[0]!, { id: 'b', selected: [] }])).toBe(
        '已回答 1/2 題',
      );
      expect(questionSummary(qs, true, [ANSWERS[0]!, { id: 'b', selected: [], custom: '' }])).toBe(
        '已回答 1/2 題',
      );
    });
  });
});

/**
 * `ask_user_question` 的單元面：**送出去的酬載**與**四條出口**。
 *
 * `interrupt()` 在這裡是替身，因為這一層要驗的是「我們交給它什麼、拿回來怎麼解」，
 * 不是 LangGraph 的暫停機制——那條走真的線的在 `apps/harness/src/ask-user-wire.test.ts`。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { loadPlugins } from '@nexus/core';
import type { StructuredTool } from '@langchain/core/tools';

const interrupted: unknown[] = [];
let resumeWith: unknown;

vi.mock('@langchain/langgraph', () => ({
  interrupt: (payload: unknown) => {
    interrupted.push(payload);
    return resumeWith;
  },
}));

const { createAskUserPlugin, ASK_USER_QUESTION_TOOL_NAME, CANCELLED_MESSAGE } =
  await import('./index.js');

async function toolOf(
  channelKind: 'human' | 'policy-never' | 'no-channel',
): Promise<StructuredTool> {
  const { registry } = await loadPlugins([createAskUserPlugin({ channel: { kind: channelKind } })]);
  const entry = registry.tools.resolve(ASK_USER_QUESTION_TOOL_NAME);
  if (entry === undefined) throw new Error('工具沒有註冊上去');
  return entry.value;
}

/**
 * 從工具回傳值取出錯誤內容，**並且斷言它真的是一則 `status: 'error'`**。
 *
 * 只比對字串的話，把 ToolMessage 換成一個普通的字串回傳照樣綠——而那個差別正是模型會
 * 不會知道這次失敗了。
 */
async function errorTextOf(result: unknown): Promise<string> {
  const message = result as { status?: string; content?: unknown };
  expect(message.status).toBe('error');
  return String(message.content);
}

const ONE_QUESTION = {
  questions: [
    {
      id: 'q1',
      question: '哪一天？',
      header: '日期',
      options: [{ label: '週一', description: '比較早' }, { label: '週二' }],
      multi_select: true,
    },
  ],
};

beforeEach(() => {
  interrupted.length = 0;
  resumeWith = { answers: [{ id: 'q1', selected: ['週一'] }] };
});

describe('送出去的酬載', () => {
  it('**帶 `kind`，而且是問答那一個**——判別式缺了，折疊器會把它當核准畫出來', async () => {
    await (await toolOf('human')).invoke(ONE_QUESTION);
    expect((interrupted[0] as { kind: string }).kind).toBe('question');
  });

  it('五個欄位照抄 dsh，`multi_select` 在裡面變成 `multiSelect`', async () => {
    await (await toolOf('human')).invoke(ONE_QUESTION);
    expect(interrupted[0]).toEqual({
      kind: 'question',
      questions: [
        {
          id: 'q1',
          question: '哪一天？',
          header: '日期',
          options: [{ label: '週一', description: '比較早' }, { label: '週二' }],
          multiSelect: true,
        },
      ],
    });
  });

  it('沒給的可選欄位不會補成 undefined 混進去', async () => {
    await (await toolOf('human')).invoke({ questions: [{ id: 'q1', question: '姓名？' }] });
    expect(interrupted[0]).toEqual({
      kind: 'question',
      questions: [{ id: 'q1', question: '姓名？' }],
    });
  });
});

describe('四條出口', () => {
  it('人答了就把答案原樣交回去——空的 `selected` 是「跳過」，不補預設值', async () => {
    resumeWith = {
      answers: [
        { id: 'q1', selected: [] },
        { id: 'q2', selected: ['甲'], custom: '乙' },
      ],
    };
    const result = await (await toolOf('human')).invoke(ONE_QUESTION);
    expect(JSON.parse(result as string)).toEqual({
      answers: [
        { id: 'q1', selected: [] },
        { id: 'q2', selected: ['甲'], custom: '乙' },
      ],
    });
  });

  it('**放棄整組是錯誤，不是一份空答案**——模型要分得出「人不走這條路」與「每題都跳過」', async () => {
    resumeWith = { cancelled: true };
    expect(await errorTextOf(await (await toolOf('human')).invoke(ONE_QUESTION))).toBe(
      CANCELLED_MESSAGE,
    );
    // 而且它真的問過了——沒問就拋的話，這條測的只是參數檢查。
    expect(interrupted).toHaveLength(1);
  });

  it('沒有人在（policy-never）時**連問都不問**，回錯誤而不是靜默通過', async () => {
    expect(await errorTextOf(await (await toolOf('policy-never')).invoke(ONE_QUESTION))).toMatch(
      /沒有人在/,
    );
    expect(interrupted).toEqual([]);
  });

  it('沒有 checkpointer 時也一樣——理由與上一條刻意不同', async () => {
    expect(await errorTextOf(await (await toolOf('no-channel')).invoke(ONE_QUESTION))).toMatch(
      /接不回來/,
    );
    expect(interrupted).toEqual([]);
  });

  it('空的問題清單當場拋，不會送出一顆沒有問題的中斷', async () => {
    expect(await errorTextOf(await (await toolOf('human')).invoke({ questions: [] }))).toMatch(
      /至少要有一題/,
    );
    expect(interrupted).toEqual([]);
  });

  it('回覆形狀看不懂時拋，不會把 undefined 當成答案交給模型', async () => {
    resumeWith = { decisions: [{ type: 'approve' }] };
    expect(await errorTextOf(await (await toolOf('human')).invoke(ONE_QUESTION))).toMatch(/看不懂/);
  });
});

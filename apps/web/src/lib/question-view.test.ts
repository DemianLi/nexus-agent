// @vitest-environment node
import { readFileSync } from 'node:fs';

import type { ConversationEntry, ConversationState, ToolEntry } from '@nexus/wire';
import { UNFINISHED_TOOL_TEXT } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import {
  isStoppedQuestion,
  questionsOf,
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

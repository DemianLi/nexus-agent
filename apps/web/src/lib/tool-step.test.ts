// @vitest-environment node
import { UNFINISHED_TOOL_CODE } from '@nexus/wire';
import type { ToolEntry } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import {
  PARTIAL_OUTPUT_HEADING,
  SUBAGENT_MAX_TOKENS_REASON,
  SUBAGENT_MAX_TOKENS_TEXT,
} from '@/lib/max-tokens-view';
import { ABORTED_BEFORE_DISPATCH_CODE, STOPPED_QUESTION_TEXT } from '@/lib/question-view';
import { inputText, outputText, sgStatus, toStep } from '@/lib/tool-step';
import { outputOf } from '@/lib/tool-output';
import { INPUT_MAX_CHARS } from '@/lib/tool-view';

/**
 * 轉接層（#1682 驗收 B）：`ToolEntry` → SG 的 `Step`。照 PM 決定 Q1 的對照表逐列一條；畫出來的樣子在 `components/tool/card.test.tsx`。
 */

function tool(overrides: Partial<ToolEntry> = {}): ToolEntry {
  return {
    kind: 'tool',
    id: 'tool-1',
    callId: 'call-1',
    name: 'echo',
    input: '{"message":"嗨"}',
    status: 'done',
    attribution: { kind: 'root' },
    ...overrides,
  };
}

const ASK = {
  name: 'ask_user_question',
  input: JSON.stringify({ questions: [{ id: 'd', question: '哪一天？' }] }),
};

describe('狀態對照（Q1）', () => {
  it('running（含停在核准閘門：wire 那一格也是 running）→ SG running、字是「執行中」', () => {
    const view = toStep(tool({ status: 'running' }));
    expect(view.step.status).toBe('running');
    expect(view.statusText).toBe('執行中');
  });

  it('suspended → SG done（不閃）、字是「等你回答」', () => {
    const view = toStep(tool({ ...ASK, status: 'suspended' }));
    expect(view.step.status).toBe('done');
    expect(view.statusText).toBe('等你回答');
  });

  it('done → done、「完成」', () => {
    const view = toStep(tool({ text: 'echo: 嗨' }));
    expect(view.step.status).toBe('done');
    expect(view.statusText).toBe('完成');
    expect(view.step.output).toBe('echo: 嗨');
  });

  it('failed：error 進 SG 的錯誤框、摘要是錯誤的第一行、字是「失敗」', () => {
    const view = toStep(tool({ status: 'failed', error: '人拒絕了這次呼叫\n第二行' }));
    expect(view.step.status).toBe('error');
    expect(view.step.error).toBe('人拒絕了這次呼叫\n第二行');
    expect(view.step.label).toBe('回聲 人拒絕了這次呼叫');
    expect(view.statusText).toBe('失敗');
    expect(view.failed).toBe(true);
  });

  it('一輪關掉時沒有結果（interrupted）跟失敗一樣', () => {
    const view = toStep(
      tool({ status: 'failed', error: '沒有結果', errorCode: UNFINISHED_TOOL_CODE }),
    );
    expect(view.step.status).toBe('error');
    expect(view.statusText).toBe('失敗');
  });

  it('停止的提問：SG done、字是「已停止」、摘要是停止那句，沒有紅字', () => {
    const view = toStep(
      tool({
        ...ASK,
        status: 'failed',
        error: 'Error: tool call aborted before dispatch',
        errorCode: ABORTED_BEFORE_DISPATCH_CODE,
      }),
    );
    expect(view.step.status).toBe('done');
    expect(view.statusText).toBe('已停止');
    expect(view.step.label).toBe(`提問 ${STOPPED_QUESTION_TEXT}`);
    expect(view.step.error).toBeUndefined();
    expect(view.failed).toBe(false);
  });

  it('背景子代理：done、帶 runId 與模型行（面板與狀態字由卡畫）', () => {
    const view = toStep(
      tool({
        name: 'task',
        input: '{"description":"寫報告","subagent_type":"researcher"}',
        text: '已在背景開始',
        meta: {
          kind: 'background-subagent',
          runId: 'bg-1',
          subagentType: 'researcher',
          model: 'cheap',
        },
      }),
    );
    expect(view.step.status).toBe('done');
    expect(view.backgroundRunId).toBe('bg-1');
    expect(view.subagentModel).toContain('cheap');
  });

  it('子代理撞到輸出上限：摘要換成中文、寫到一半的那段交給卡畫，SG 的錯誤框與結果框都不設', () => {
    const error = `Error: ${SUBAGENT_MAX_TOKENS_REASON}\n${PARTIAL_OUTPUT_HEADING}\n寫到一半`;
    const view = toStep(
      tool({ name: 'task', input: '{"description":"寫"}', status: 'failed', text: error, error }),
    );
    expect(view.step.label).toBe(`委派子代理 ${SUBAGENT_MAX_TOKENS_TEXT}`);
    expect(view.truncated?.partial).toBe('寫到一半');
    expect(view.resultInChildren).toBe(true);
    expect(view.step.error).toBeUndefined();
    expect(view.step.output).toBeUndefined();
  });

  it('sgStatus 只收成三態', () => {
    expect(sgStatus(tool({ status: 'running' }), false)).toBe('running');
    expect(sgStatus(tool({ status: 'failed' }), false)).toBe('error');
    expect(sgStatus(tool({ status: 'failed' }), true)).toBe('done');
    expect(sgStatus(tool({ status: 'suspended' }), false)).toBe('done');
  });
});

describe('結果畫在 children 的種類，SG 的 output／error 都不設（slots 附加，不畫兩次）', () => {
  const cases: [string, Partial<ToolEntry>][] = [
    ['提問', { ...ASK, text: JSON.stringify({ answers: [{ id: 'd', selected: ['週一'] }] }) }],
    ['交付', { name: 'present', input: JSON.stringify({ files: [{ path: 'a.md' }] }), text: 'ok' }],
    [
      '待辦',
      {
        name: 'todo_write',
        input: JSON.stringify({ todos: [{ content: '寫', status: 'pending' }] }),
        text: 'ok',
      },
    ],
    [
      '寫檔 diff',
      {
        name: 'write_file',
        input: JSON.stringify({ file_path: '/a.md', content: '一\n' }),
        text: 'ok',
      },
    ],
    [
      '讀檔卡',
      {
        name: 'read_file',
        input: '{"file_path":"/a.md"}',
        text: '1\t一',
        meta: { path: '/a.md', offset: 1, lines: [{ number: 1, text: '一' }], totalLines: 1 },
      },
    ],
    [
      '搜尋卡',
      {
        name: 'glob',
        input: '{"pattern":"*.md"}',
        text: '/a.md',
        meta: { shape: 'paths', paths: ['/a.md'], truncated: false, total: 1 },
      },
    ],
  ];
  it.each(cases)('%s', (_, overrides) => {
    const view = toStep(tool(overrides));
    expect(view.resultInChildren).toBe(true);
    expect(view.step.output).toBeUndefined();
    expect(view.step.error).toBeUndefined();
    expect(view.step.detail).toBeUndefined();
  });

  it('這幾種失敗了也不設 SG 的 error：錯誤由卡接在檢視後面畫一次', () => {
    const view = toStep(tool({ ...ASK, status: 'failed', error: '題目格式不對' }));
    expect(view.questions).toBeDefined();
    expect(view.failed).toBe(true);
    expect(view.step.status).toBe('error');
    expect(view.step.error).toBeUndefined();
  });
});

describe('結果與參數的字串（#601、#958）', () => {
  it('頭、省略說明、尾組成一段，說明自成一行、字數不少', () => {
    const text = Array.from({ length: 250 }, (_, i) => `第 ${i + 1} 行`).join('\n');
    const output = outputOf(text);
    const joined = outputText(output);
    expect(joined).toBe(`${output.head}\n⋯ 中間 50 行沒畫 ⋯\n${output.tail}`);
    expect(toStep(tool({ text })).step.output).toBe(joined);
  });

  it('沒被切的結果原樣', () => {
    expect(outputText(outputOf('一\n二'))).toBe('一\n二');
  });

  it(`參數超過 ${INPUT_MAX_CHARS} 字切頭尾，中間一行講沒畫幾個字；畫出來的加上沒畫的剛好是全長`, () => {
    const body = 'x'.repeat(INPUT_MAX_CHARS + 123);
    const shown = inputText(body);
    const match = /\n⋯ 中間 (\d+) 字沒畫 ⋯\n/.exec(shown);
    expect(match).not.toBeNull();
    expect(shown.length - match![0].length + Number(match![1])).toBe(body.length);
    expect(inputText('短')).toBe('短');
  });

  it('只畫結果的工具不設 detail；一般工具設排好的參數', () => {
    expect(
      toStep(tool({ name: 'ls', input: '{"path":"/"}', text: 'a' })).step.detail,
    ).toBeUndefined();
    expect(toStep(tool()).step.detail).toBe('{\n  "message": "嗨"\n}');
  });
});

describe('空內容的提示', () => {
  it('只畫結果的工具：跑著「還沒有結果。」、結束了「沒有結果文字。」；有結果就沒有', () => {
    expect(toStep(tool({ name: 'ls', status: 'running' })).emptyNote).toBe('還沒有結果。');
    expect(toStep(tool({ name: 'ls' })).emptyNote).toBe('沒有結果文字。');
    expect(toStep(tool({ name: 'ls', text: 'a' })).emptyNote).toBeUndefined();
  });

  it('該畫參數卻是空的：「沒有參數。」', () => {
    expect(toStep(tool({ input: '' })).emptyNote).toBe('沒有參數。');
    expect(toStep(tool()).emptyNote).toBeUndefined();
  });
});

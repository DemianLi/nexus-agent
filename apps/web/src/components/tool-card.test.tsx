import type { ConversationState, ToolEntry } from '@nexus/wire';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ToolCard } from '@/components/tool-card';
import { WITHDRAWN_TOOL_REASON } from '@/lib/question-view';
import { Transcript } from '@/components/transcript';
import { axeViolations } from '@/test/axe';

/** 工具卡（#406）。四格狀態怎麼從日誌定出來在 `@nexus/wire` 與 harness 的測試裡；這裡只驗畫出來的。 */

afterEach(cleanup);

function tool(overrides: Partial<ToolEntry> = {}): ToolEntry {
  return {
    kind: 'tool',
    id: 'tool-1',
    callId: 'call-1',
    name: 'read_file',
    input: '{"file_path":"src/App.tsx"}',
    status: 'done',
    attribution: { kind: 'root' },
    ...overrides,
  };
}

describe('工具卡', () => {
  it.each([
    ['running', '執行中'],
    ['suspended', '等你回答'],
    ['done', '完成'],
    ['failed', '失敗'],
  ] as const)('四格狀態各自的字：%s → %s', (status, label) => {
    render(<ToolCard entry={tool({ status })} beam={false} />);
    const card = screen.getByTestId('tool-entry');
    expect(card.getAttribute('data-status')).toBe(status);
    expect(within(card).getByText(label)).toBeTruthy();
  });

  it('收著一行：分類的標題、工具名、參數摘要；展開看排好的參數', () => {
    render(<ToolCard entry={tool({ name: 'echo', input: '{"message":"嗨"}' })} beam={false} />);
    const trigger = screen.getByRole('button', { name: /回聲/ });
    expect(trigger.textContent).toContain('echo');
    expect(trigger.textContent).toContain('嗨');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    // 參數高亮後被切成一段一段的 span，改看整塊程式碼的字。
    expect(document.querySelector('.md-code')).toBeNull();

    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('.md-code pre')?.textContent).toContain('"message": "嗨"');
  });

  it('失敗時收著那一行就是錯誤的第一行，展開看全文', () => {
    render(
      <ToolCard
        entry={tool({ status: 'failed', error: '人拒絕了這次呼叫\n第二行細節' })}
        beam={false}
      />,
    );
    const trigger = screen.getByRole('button', { name: /讀取/ });
    expect(trigger.textContent).toContain('人拒絕了這次呼叫');
    expect(trigger.textContent).not.toContain('第二行細節');
    fireEvent.click(trigger);
    expect(screen.getByText(/第二行細節/)).toBeTruthy();
  });

  it('子代理的工具帶歸屬；未歸屬照講', () => {
    render(
      <>
        <ToolCard
          entry={tool({ attribution: { kind: 'subagent', name: 'writer', callId: 'call-0' } })}
          beam={false}
        />
        <ToolCard
          entry={tool({ id: 't2', attribution: { kind: 'unattributed', namespace: ['tools:x'] } })}
          beam={false}
        />
      </>,
    );
    expect(screen.getByText('子代理 writer')).toBeTruthy();
    expect(screen.getByText('未歸屬的子代理')).toBeTruthy();
  });

  it('狀態變化不唸：卡片裡沒有 live region', () => {
    const { container } = render(<ToolCard entry={tool({ status: 'running' })} beam />);
    expect(container.querySelector('[aria-live], [role="status"], [role="alert"]')).toBeNull();
  });
});

describe('對話流裡的工具卡', () => {
  function state(entries: ToolEntry[]): ConversationState {
    return { status: 'running', entries, pendings: [] } as unknown as ConversationState;
  }

  it('執行中的邊框光同時最多一個：給最後一顆還在跑的', () => {
    render(
      <Transcript
        state={state([
          tool({ id: 'a', status: 'running' }),
          tool({ id: 'b', status: 'done' }),
          tool({ id: 'c', status: 'running' }),
        ])}
        isFresh={() => false}
      />,
    );
    const active = screen
      .getAllByTestId('tool-entry')
      .map((card) => card.getAttribute('data-active'));
    expect(active).toEqual(['false', 'false', 'true']);
  });

  it('含工具卡（收著與展開）的對話流過 axe', async () => {
    const { container } = render(
      <Transcript
        state={state([
          tool({ id: 'a', status: 'running', name: 'execute', input: '{"command":"pnpm test"}' }),
          tool({
            id: 'b',
            status: 'failed',
            error: '沒有這個檔',
            attribution: { kind: 'subagent', name: 'writer', callId: 'call-0' },
          }),
          tool({ id: 'c', name: 'mcp__github__create_issue', input: '{"title":"壞了"}' }),
        ])}
        isFresh={() => false}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /執行指令/ }));
    expect(await axeViolations(container)).toEqual([]);
  });

  it('停在提問時被停止：等人回答時就在畫面上的那張卡，翻成停止的那一刻打開（實跑抓到的）', () => {
    const ask = {
      name: 'ask_user_question',
      input: JSON.stringify({ questions: [{ id: 'd', question: '哪一天？' }] }),
    };
    const view = render(<ToolCard entry={tool({ ...ask, status: 'suspended' })} beam={false} />);
    const card = screen.getByTestId('tool-entry');
    expect(card.getAttribute('data-state')).toBe('closed');
    view.rerender(
      <ToolCard
        entry={tool({ ...ask, status: 'failed', error: `Error: ${WITHDRAWN_TOOL_REASON}` })}
        beam={false}
      />,
    );
    expect(card.getAttribute('data-state')).toBe('open');
    expect(within(card).getByText('哪一天？')).toBeTruthy();
    expect(within(card).getAllByText('已停止，請直接打字回覆').length).toBeGreaterThan(0);
  });

  describe('答完的提問卡（§4.3）', () => {
    const ask = tool({
      name: 'ask_user_question',
      input: JSON.stringify({
        questions: [
          { id: 'day', question: '哪一天？', options: [{ label: '週一' }, { label: '週二' }] },
          { id: 'food', question: '要準備什麼？', multi_select: true },
        ],
      }),
    });

    /** 成功的 `ask_user_question` 回的那一段（`ToolEntry.text`）。 */
    const answersText = (answers: unknown) => JSON.stringify({ answers });

    const ANSWERS = [
      { id: 'day', selected: ['週二'] },
      { id: 'food', selected: ['茶'], custom: '氣泡水' },
    ];

    it('線上帶著答案（#439）：收著講答了幾題，展開逐題「問題 → 回答」，不畫參數原文', () => {
      render(<ToolCard entry={{ ...ask, text: answersText(ANSWERS) }} beam={false} />);
      const card = screen.getByTestId('tool-entry');
      expect(within(card).getByText('已回答 2/2 題')).toBeTruthy();
      fireEvent.click(within(card).getByRole('button', { name: /提問/ }));
      expect(
        within(card)
          .getAllByTestId('question-row')
          .map((row) => row.textContent),
      ).toEqual(['哪一天？→ 回答：週二', '要準備什麼？→ 回答：茶、氣泡水']);
      expect(card.textContent).not.toContain('"questions"');
      expect(within(card).queryByText(/讀不出來|對不起來/)).toBeNull();
    });

    it('跳過的那題不算答了：講 1/2，那一行寫「（跳過）」', () => {
      const text = answersText([
        { id: 'day', selected: ['週二'] },
        { id: 'food', selected: [] },
      ]);
      render(<ToolCard entry={{ ...ask, text }} beam={false} />);
      const card = screen.getByTestId('tool-entry');
      expect(within(card).getByText('已回答 1/2 題')).toBeTruthy();
      fireEvent.click(within(card).getByRole('button', { name: /提問/ }));
      expect(
        within(card)
          .getAllByTestId('question-row')
          .map((row) => row.textContent),
      ).toEqual(['哪一天？→ 回答：週二', '要準備什麼？→ 回答：（跳過）']);
    });

    it('沒有 text 的舊日誌：退回本地那一則答案', () => {
      render(
        <ToolCard
          entry={ask}
          beam={false}
          answer={{ kind: 'answer', id: 'answer-q', answers: ANSWERS }}
        />,
      );
      const card = screen.getByTestId('tool-entry');
      expect(within(card).getByText('已回答 2/2 題')).toBeTruthy();
      fireEvent.click(within(card).getByRole('button', { name: /提問/ }));
      expect(
        within(card)
          .getAllByTestId('question-row')
          .map((row) => row.textContent),
      ).toEqual(['哪一天？→ 回答：週二', '要準備什麼？→ 回答：茶、氣泡水']);
    });

    it('兩份都在時以線上那份為準：本地那則不會蓋掉它', () => {
      render(
        <ToolCard
          entry={{ ...ask, text: answersText(ANSWERS) }}
          beam={false}
          answer={{
            kind: 'answer',
            id: 'answer-q',
            answers: [
              { id: 'day', selected: ['週一'] },
              { id: 'food', selected: ['咖啡'] },
            ],
          }}
        />,
      );
      const card = screen.getByTestId('tool-entry');
      fireEvent.click(within(card).getByRole('button', { name: /提問/ }));
      expect(card.textContent).toContain('週二');
      expect(card.textContent).not.toContain('週一→');
    });

    it('結果文字被截過（頭尾還在、中間沒了）：退回「已回答 N 題」，講明讀不出來', () => {
      // harness 超過上限（`#settings/tool-text` 那一列的 `maxBytes`，預設 50000）時取頭尾各半（`apps/harness/src/tool-result-text.ts`）：
      // 開頭 `{"answers":[`、結尾 `]}` 都還在，所以只看頭尾字元會把它當成完整的 JSON。
      const whole = answersText(ANSWERS);
      const truncated = `${whole.slice(0, 14)}\n…（中間 40000 個位元組沒有送出來）\n${whole.slice(-14)}`;
      expect(truncated.startsWith('{')).toBe(true);
      expect(truncated.endsWith('}')).toBe(true);

      render(<ToolCard entry={{ ...ask, text: truncated }} beam={false} />);
      const card = screen.getByTestId('tool-entry');
      expect(within(card).getByText('已回答 2 題')).toBeTruthy();
      fireEvent.click(within(card).getByRole('button', { name: /提問/ }));
      expect(within(card).getAllByTestId('question-row')).toHaveLength(2);
      expect(within(card).getByText('週一')).toBeTruthy();
      expect(within(card).queryByText(/→/)).toBeNull();
      expect(
        within(card).getByText('這次的答案讀不出來：結果文字太長被截過，或不是預期的形狀。'),
      ).toBeTruthy();
    });

    it('答案與題目對不起來：只列題目，講明對不起來', () => {
      const text = answersText([
        { id: 'day', selected: ['週二'] },
        { id: '別的', selected: ['茶'] },
      ]);
      render(<ToolCard entry={{ ...ask, text }} beam={false} />);
      const card = screen.getByTestId('tool-entry');
      expect(within(card).getByText('已回答 2/2 題')).toBeTruthy();
      fireEvent.click(within(card).getByRole('button', { name: /提問/ }));
      expect(within(card).queryByText(/→/)).toBeNull();
      expect(within(card).getByText('答案和題目對不起來，只列題目。')).toBeTruthy();
    });

    it('兩份都沒有：照樣「已回答 N 題」，展開列題目與選項', () => {
      render(<ToolCard entry={ask} beam={false} />);
      const card = screen.getByTestId('tool-entry');
      expect(within(card).getByText('已回答 2 題')).toBeTruthy();
      fireEvent.click(within(card).getByRole('button', { name: /提問/ }));
      expect(within(card).getAllByTestId('question-row')).toHaveLength(2);
      expect(within(card).getByText('週一')).toBeTruthy();
      expect(within(card).queryByText(/→/)).toBeNull();
      expect(
        within(card).getByText('這次的答案讀不出來：結果文字太長被截過，或不是預期的形狀。'),
      ).toBeTruthy();
    });

    it('還沒答完：收著講第一題與題數，不是參數 JSON（#409 第一刀留下的）', () => {
      render(<ToolCard entry={{ ...ask, status: 'suspended' }} beam={false} />);
      expect(screen.getByText('哪一天？（共 2 題）')).toBeTruthy();
    });
  });
});

describe('交付檔案的工具卡（#441 第一刀）', () => {
  const present = tool({
    name: 'present',
    input: JSON.stringify({
      files: [{ path: 'out/report.md', description: '這週的週報' }, { path: 'data/report.md' }],
    }),
  });

  it('收著講檔名與總數，展開逐個列檔名、完整路徑、說明，不畫參數原文', () => {
    render(<ToolCard entry={present} beam={false} />);
    const card = screen.getByTestId('tool-entry');
    const trigger = within(card).getByRole('button', { name: /交付檔案/ });
    expect(trigger.textContent).toContain('report.md、report.md（共 2 個）');
    fireEvent.click(trigger);
    expect(
      within(card)
        .getAllByTestId('presented-file')
        .map((row) => row.textContent),
    ).toEqual(['report.mdout/report.md這週的週報', 'report.mddata/report.md']);
    expect(card.textContent).not.toContain('"files"');
  });

  it('參數還是半截（串流中）：退回通用卡，原文照樣看得到', () => {
    render(
      <ToolCard
        entry={tool({ name: 'present', input: '{"files":[{"path":"out/re', status: 'running' })}
        beam
      />,
    );
    const card = screen.getByTestId('tool-entry');
    expect(within(card).queryAllByTestId('presented-file')).toHaveLength(0);
    fireEvent.click(within(card).getByRole('button', { name: /交付檔案/ }));
    expect(document.querySelector('.md-code pre')?.textContent).toContain('out/re');
  });

  it('被拒（檔案不存在）：照一般失敗畫，收著是錯誤的第一行', () => {
    render(
      <ToolCard
        entry={{
          ...present,
          status: 'failed',
          error: 'Error: Cannot present out/report.md: file not found.',
        }}
        beam={false}
      />,
    );
    const trigger = screen.getByRole('button', { name: /交付檔案/ });
    expect(trigger.textContent).toContain('file not found');
    expect(within(trigger).getByText('失敗')).toBeTruthy();
  });

  it('展開的交付卡過 axe', async () => {
    const { container } = render(<ToolCard entry={present} beam={false} />);
    fireEvent.click(screen.getByRole('button', { name: /交付檔案/ }));
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe('待辦清單的工具卡（#575）', () => {
  const todo = tool({
    name: 'todo_write',
    input: JSON.stringify({
      todos: [
        { content: '讀規格', status: 'completed' },
        { content: '寫測試', status: 'in_progress' },
        { content: '跑突變', status: 'in_progress' },
        { content: '開 PR', status: 'pending' },
      ],
    }),
  });

  it('收著講「完成數/總數 · 進行中那一項」，其餘同時進行的另起一格；展開逐項列快照，不畫參數原文', () => {
    render(<ToolCard entry={todo} beam={false} />);
    const card = screen.getByTestId('tool-entry');
    const trigger = within(card).getByRole('button', { name: /更新待辦/ });
    expect(trigger.textContent).toContain('1/4 完成 · 寫測試');
    // 「+1」不接在會被截斷的那一格裡：窄的時候最先被截掉的就是它。
    const extra = within(trigger).getByTestId('todo-extra');
    expect(extra.textContent).toBe('+1，另有 1 項進行中');
    expect(extra.previousElementSibling?.classList.contains('truncate')).toBe(true);
    expect(extra.classList.contains('shrink-0')).toBe(true);
    expect(extra.classList.contains('truncate')).toBe(false);
    // 吃掉剩下寬度的是外層，不是會截斷的那格：放在那格上，「+N」會被推到最右邊的狀態字旁邊（真 Chrome 量到過）。
    expect(extra.parentElement?.classList.contains('flex-1')).toBe(true);
    expect(extra.previousElementSibling?.classList.contains('flex-1')).toBe(false);
    fireEvent.click(trigger);
    expect(
      within(card)
        .getAllByTestId('todo-item')
        .map((row) => [row.getAttribute('data-status'), row.textContent]),
    ).toEqual([
      ['completed', '已完成：讀規格'],
      ['in_progress', '進行中：寫測試'],
      ['in_progress', '進行中：跑突變'],
      ['pending', '待處理：開 PR'],
    ]);
    expect(card.textContent).not.toContain('"todos"');
    // 快照不閃：歷史裡的「進行中」不代表現在還在跑（面板那一份才看這一輪在不在跑）。
    expect(card.querySelector('.text-shimmer')).toBeNull();
  });

  it('只有一項在進行：沒有「+N」那一格', () => {
    render(
      <ToolCard
        entry={tool({
          name: 'todo_write',
          input: JSON.stringify({ todos: [{ content: '寫測試', status: 'in_progress' }] }),
        })}
        beam={false}
      />,
    );
    expect(screen.queryByTestId('todo-extra')).toBeNull();
  });

  it('清空清單：收著與展開都講清單是空的', () => {
    render(<ToolCard entry={tool({ name: 'todo_write', input: '{"todos":[]}' })} beam={false} />);
    const trigger = screen.getByRole('button', { name: /更新待辦/ });
    expect(trigger.textContent).toContain('清單是空的');
    fireEvent.click(trigger);
    expect(screen.getByText('清單是空的。')).toBeTruthy();
    expect(screen.queryAllByTestId('todo-item')).toHaveLength(0);
  });

  it('參數還是半截（串流中）：退回通用卡，原文照樣看得到', () => {
    render(
      <ToolCard
        entry={tool({ name: 'todo_write', input: '{"todos":[{"content":"讀', status: 'running' })}
        beam
      />,
    );
    const card = screen.getByTestId('tool-entry');
    fireEvent.click(within(card).getByRole('button', { name: /更新待辦/ }));
    expect(within(card).queryAllByTestId('todo-item')).toHaveLength(0);
    expect(document.querySelector('.md-code pre')?.textContent).toContain('"content"');
  });

  it('被工具本體拒絕（內容重複）：照一般失敗畫，收著是錯誤的第一行', () => {
    render(
      <ToolCard
        entry={tool({
          name: 'todo_write',
          input: JSON.stringify({
            todos: [
              { content: '讀規格', status: 'in_progress' },
              { content: '讀規格', status: 'in_progress' },
            ],
          }),
          status: 'failed',
          error: 'Error: invalid todos: duplicate content "讀規格"',
        })}
        beam={false}
      />,
    );
    const trigger = screen.getByRole('button', { name: /更新待辦/ });
    expect(trigger.textContent).toContain('duplicate content');
    expect(within(trigger).getByText('失敗')).toBeTruthy();
    // 被拒時「+N」不畫：收著那一格講的是錯誤，不是清單。
    expect(within(trigger).queryByTestId('todo-extra')).toBeNull();
  });

  it('子代理寫的：同一張卡，帶歸屬', () => {
    render(
      <ToolCard
        entry={{ ...todo, attribution: { kind: 'subagent', name: 'researcher', callId: 'task-1' } }}
        beam={false}
      />,
    );
    const trigger = screen.getByRole('button', { name: /更新待辦/ });
    expect(trigger.textContent).toContain('1/4 完成 · 寫測試');
    expect(trigger.textContent).toContain('子代理 researcher');
  });

  it('展開的待辦卡過 axe', async () => {
    const { container } = render(<ToolCard entry={todo} beam={false} />);
    fireEvent.click(screen.getByRole('button', { name: /更新待辦/ }));
    expect(await axeViolations(container)).toEqual([]);
  });
});

/** #601：通用卡畫結果、單檔工具只畫結果、寫檔／改檔畫 diff。規則在 `lib/tool-output.ts`、`lib/tool-diff.ts`。 */
describe('工具卡的結果與 diff', () => {
  const lines = (count: number) =>
    Array.from({ length: count }, (_, index) => `第 ${index + 1} 行`).join('\n');

  function expand(name: RegExp) {
    fireEvent.click(screen.getByRole('button', { name }));
  }

  it('通用卡：參數、結果都畫', () => {
    render(
      <ToolCard
        entry={tool({ name: 'echo', input: '{"message":"嗨"}', text: 'echo: 嗨' })}
        beam={false}
      />,
    );
    expand(/回聲/);
    expect(document.querySelector('.md-code pre')?.textContent).toContain('"message": "嗨"');
    const output = screen.getByTestId('tool-output');
    expect(output.textContent).toContain('結果');
    expect(within(output).getByLabelText('工具結果').textContent).toBe('echo: 嗨');
  });

  it.each(['ls', 'read_file', 'glob', 'grep', 'write_file', 'edit_file'])(
    '%s 展開只畫結果，不畫參數',
    (name) => {
      render(
        <ToolCard
          entry={tool({ name, input: '{"file_path":"a.ts","pattern":"x"}', text: '結果文字' })}
          beam={false}
        />,
      );
      fireEvent.click(screen.getByRole('button', { expanded: false }));
      expect(document.querySelector('.md-code')).toBeNull();
      expect(screen.getByLabelText('工具結果').textContent).toBe('結果文字');
    },
  );

  it.each(['run_javascript', 'task', 'mcp__github__create_issue'])('%s 參數、結果都畫', (name) => {
    render(
      <ToolCard
        entry={tool({ name, input: '{"code":"1+1","description":"算"}', text: '2' })}
        beam={false}
      />,
    );
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(document.querySelector('.md-code')).not.toBeNull();
    expect(screen.getByLabelText('工具結果').textContent).toBe('2');
  });

  it('沒有結果文字就不畫空的結果區塊', () => {
    render(<ToolCard entry={tool({ name: 'echo', input: '{"message":"嗨"}' })} beam={false} />);
    expand(/回聲/);
    expect(screen.queryByTestId('tool-output')).toBeNull();
    expect(document.querySelector('.md-code')).not.toBeNull();
  });

  it('只畫結果的工具還沒有結果時講一聲', () => {
    render(<ToolCard entry={tool({ status: 'running' })} beam={false} />);
    expand(/讀取/);
    expect(screen.queryByTestId('tool-output')).toBeNull();
    expect(screen.getByText('還沒有結果。')).toBeTruthy();
  });

  it('失敗時紅字照舊，同一串字不畫第二次', () => {
    const error = 'Error: File not found: a.ts';
    render(
      <ToolCard
        entry={tool({ name: 'echo', status: 'failed', text: error, error })}
        beam={false}
      />,
    );
    expand(/回聲/);
    expect(screen.queryByTestId('tool-output')).toBeNull();
    expect(screen.getAllByText(error, { selector: 'pre' })).toHaveLength(1);
  });

  it('超過 200 行：畫頭尾各 100 行，中間一行講沒畫幾行；200 行不切', () => {
    const { unmount } = render(
      <ToolCard entry={tool({ name: 'echo', text: lines(200) })} beam={false} />,
    );
    expand(/回聲/);
    expect(screen.queryByTestId('tool-output-omitted')).toBeNull();
    expect(screen.getByLabelText('工具結果').textContent).toBe(lines(200));
    unmount();

    render(<ToolCard entry={tool({ name: 'echo', text: lines(201) })} beam={false} />);
    expand(/回聲/);
    expect(screen.getByTestId('tool-output-omitted').textContent).toBe('⋯ 中間 1 行沒畫 ⋯');
    const text = screen.getByLabelText('工具結果').textContent ?? '';
    expect(text.startsWith('第 1 行\n')).toBe(true);
    expect(text).not.toContain('第 101 行\n');
    expect(text).toContain('第 100 行\n');
    expect(text.endsWith('第 201 行')).toBe(true);
  });

  it('幾千行的結果展開後畫出來的行數不超過上限', () => {
    render(<ToolCard entry={tool({ name: 'echo', text: lines(5000) })} beam={false} />);
    expand(/回聲/);
    const text = screen.getByLabelText('工具結果').textContent ?? '';
    // 頭 100、尾 100，加中間那一行說明。
    expect(text.split('\n')).toHaveLength(201);
    expect(screen.getByTestId('tool-output-omitted').textContent).toBe('⋯ 中間 4800 行沒畫 ⋯');
  });

  describe('write_file', () => {
    const write = tool({
      name: 'write_file',
      input: JSON.stringify({ file_path: '/notes.md', content: `${lines(12)}\n` }),
      text: 'Successfully wrote to /notes.md',
    });

    it('收著那一行接 +N −0', () => {
      render(<ToolCard entry={write} beam={false} />);
      const trigger = screen.getByRole('button', { name: /寫入檔案/ });
      expect(trigger.textContent).toContain('+12');
      expect(trigger.textContent).toContain('−0');
      expect(within(trigger).getByText('新增 12 行，')).toBeTruthy();
    });

    it('展開是整檔新增的 diff，對話裡只留 9 列，中間可以展開', () => {
      render(<ToolCard entry={write} beam={false} />);
      expand(/寫入檔案/);
      const diff = screen.getByTestId('tool-diff');
      const rows = () => diff.querySelectorAll('[data-diff-line]');
      expect(rows()).toHaveLength(9);
      expect(rows()[0]?.textContent).toBe('/notes.md');
      expect(rows()[1]?.getAttribute('data-diff-line')).toBe('add');
      expect(rows()[1]?.textContent).toBe('+第 1 行');
      expect(rows()[8]?.textContent).toBe('+第 12 行');
      expect(screen.queryByTestId('tool-output')).toBeNull();

      const toggle = screen.getByTestId('tool-diff-toggle');
      expect(toggle.textContent).toBe('展開其餘 4 行');
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      fireEvent.click(toggle);
      expect(rows()).toHaveLength(13);
      expect(toggle.textContent).toBe('收起');
    });

    it('覆寫舊檔（meta 帶 diffs）：畫跟舊檔比的 diff，不是整檔新增', () => {
      const meta = {
        operation: 'update',
        diffs: [{ path: '/notes.md', oldText: '第 1 行\n舊的\n', newText: '第 1 行\n新的\n' }],
      };
      render(<ToolCard entry={{ ...write, meta }} beam={false} />);
      const trigger = screen.getByRole('button', { name: /寫入檔案/ });
      expect(trigger.textContent).toContain('+1');
      expect(trigger.textContent).toContain('−1');
      fireEvent.click(trigger);
      const rows = screen.getByTestId('tool-diff').querySelectorAll('[data-diff-line]');
      expect([...rows].map((row) => row.textContent)).toEqual([
        '/notes.md',
        ' 第 1 行',
        '-舊的',
        '+新的',
      ]);
    });

    it('新建（meta 的 diffs 是空的）：照舊畫參數算的整檔新增', () => {
      render(
        <ToolCard entry={{ ...write, meta: { operation: 'create', diffs: [] } }} beam={false} />,
      );
      expect(screen.getByRole('button', { name: /寫入檔案/ }).textContent).toContain('+12');
    });

    it('執行中也畫', () => {
      render(<ToolCard entry={{ ...write, status: 'running', text: undefined }} beam={false} />);
      expand(/寫入檔案/);
      expect(screen.getByTestId('tool-diff')).toBeTruthy();
    });

    it('失敗時退回通用卡：沒有 diff、沒有 +N −M、紅字', () => {
      const error = 'Error: permission denied';
      render(<ToolCard entry={{ ...write, status: 'failed', text: error, error }} beam={false} />);
      const trigger = screen.getByRole('button', { name: /寫入檔案/ });
      expect(trigger.textContent).not.toContain('+12');
      fireEvent.click(trigger);
      expect(screen.queryByTestId('tool-diff')).toBeNull();
      expect(screen.getAllByText(error, { selector: 'pre' })).toHaveLength(1);
    });

    it('參數欄位不對時退回通用卡，不畫半套', () => {
      render(
        <ToolCard
          entry={{ ...write, input: JSON.stringify({ file_path: '/notes.md', content: 42 }) }}
          beam={false}
        />,
      );
      const trigger = screen.getByRole('button', { name: /寫入檔案/ });
      expect(trigger.textContent).not.toMatch(/\+\d/);
      fireEvent.click(trigger);
      expect(screen.queryByTestId('tool-diff')).toBeNull();
      expect(screen.getByLabelText('工具結果').textContent).toBe('Successfully wrote to /notes.md');
    });
  });

  describe('edit_file', () => {
    const edit = tool({
      name: 'edit_file',
      input: JSON.stringify({
        file_path: '/a.ts',
        old_string: 'const a = 1;',
        new_string: 'const a = 2;',
      }),
      status: 'running',
    });

    it('執行中（包括停在核准點）畫 old_string → new_string，收著接 +1 −1', () => {
      render(<ToolCard entry={edit} beam={false} />);
      const trigger = screen.getByRole('button', { name: /編輯檔案/ });
      expect(trigger.textContent).toContain('+1');
      expect(trigger.textContent).toContain('−1');
      fireEvent.click(trigger);
      const rows = screen.getByTestId('tool-diff').querySelectorAll('[data-diff-line]');
      expect([...rows].map((row) => row.getAttribute('data-diff-line'))).toEqual([
        'path',
        'del',
        'add',
      ]);
      expect(rows[1]?.textContent).toBe('-const a = 1;');
      expect(rows[2]?.textContent).toBe('+const a = 2;');
    });

    const replaced = "Successfully replaced 2 instance(s) of the string in '/a.ts'";
    /** harness 的 `DiffResultMeta`：`replace_all` 改了兩處，各帶上下文。 */
    const applied = {
      diffs: [
        { path: '/a.ts', oldText: 'x\nconst a = 1;\ny\n', newText: 'x\nconst a = 2;\ny\n' },
        { path: '/a.ts', oldText: 'p\nconst a = 1;\nq\n', newText: 'p\nconst a = 2;\nq\n' },
      ],
    };

    it('結束之後沒有 meta（格式 16 以前的日誌、超過上限）：退回通用卡的結果', () => {
      render(<ToolCard entry={{ ...edit, status: 'done', text: replaced }} beam={false} />);
      const trigger = screen.getByRole('button', { name: /編輯檔案/ });
      expect(trigger.textContent).not.toContain('+1');
      fireEvent.click(trigger);
      expect(screen.queryByTestId('tool-diff')).toBeNull();
      expect(screen.getByLabelText('工具結果').textContent).toContain('Successfully replaced');
    });

    it('結束之後有 meta：畫實際套用的每一段，收著接合計的 +2 −2', () => {
      render(
        <ToolCard
          entry={{ ...edit, status: 'done', text: replaced, meta: applied }}
          beam={false}
        />,
      );
      const trigger = screen.getByRole('button', { name: /編輯檔案/ });
      expect(trigger.textContent).toContain('+2');
      expect(trigger.textContent).toContain('−2');
      fireEvent.click(trigger);
      // 10 列超過對話裡的 9 列，中間那一列（兩段之間的 ⋯）收著；展開看全部。
      fireEvent.click(screen.getByTestId('tool-diff-toggle'));
      const rows = screen.getByTestId('tool-diff').querySelectorAll('[data-diff-line]');
      expect([...rows].map((row) => row.getAttribute('data-diff-line'))).toEqual([
        'path',
        'context',
        'del',
        'add',
        'context',
        'gap',
        'context',
        'del',
        'add',
        'context',
      ]);
      expect(screen.queryByTestId('tool-output')).toBeNull();
    });

    it('更正幀補上 meta：同一張卡從通用卡換成 diff', () => {
      const done = { ...edit, status: 'done' as const, text: replaced };
      const view = render(<ToolCard entry={done} beam={false} />);
      fireEvent.click(screen.getByRole('button', { name: /編輯檔案/ }));
      expect(screen.queryByTestId('tool-diff')).toBeNull();
      view.rerender(<ToolCard entry={{ ...done, meta: applied }} beam={false} />);
      expect(screen.getByTestId('tool-diff')).toBeTruthy();
      expect(screen.queryByTestId('tool-output')).toBeNull();
    });

    it('失敗時紅字', () => {
      const error = 'Error: String not found in file';
      render(<ToolCard entry={{ ...edit, status: 'failed', text: error, error }} beam={false} />);
      const trigger = screen.getByRole('button', { name: /編輯檔案/ });
      expect(trigger.textContent).toContain(error);
      fireEvent.click(trigger);
      expect(screen.queryByTestId('tool-diff')).toBeNull();
    });
  });

  it('展開的 diff 與結果過 axe', async () => {
    const { container } = render(
      <>
        <ToolCard
          entry={tool({
            name: 'write_file',
            input: JSON.stringify({ file_path: '/n.md', content: lines(20) }),
          })}
          beam={false}
        />
        <ToolCard entry={tool({ id: 'tool-2', name: 'echo', text: lines(300) })} beam={false} />
      </>,
    );
    for (const trigger of screen.getAllByRole('button', { expanded: false })) {
      fireEvent.click(trigger);
    }
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe('讀檔卡與搜尋卡（#625）', () => {
  function expand(name: RegExp) {
    fireEvent.click(screen.getByRole('button', { name }));
  }
  const readLines = (from: number, count: number) =>
    Array.from({ length: count }, (_, at) => ({
      number: from + at,
      text: `const v${from + at} = 0;`,
    }));
  const read = (lines: { number: number; text: string }[], totalLines: number) =>
    tool({
      input: JSON.stringify({ file_path: '/src/a.ts', offset: (lines[0]?.number ?? 1) - 1 }),
      text: '（deepagents 格式的結果文字）',
      meta: { path: '/src/a.ts', offset: lines[0]?.number ?? 1, lines, totalLines, lang: 'ts' },
    });

  it('讀檔：行號從 meta 取，標頭講讀到哪裡與語言，不畫結果文字', () => {
    render(<ToolCard entry={read(readLines(21, 3), 90)} beam={false} />);
    expand(/讀取/);
    const card = screen.getByTestId('tool-read');
    expect(within(card).getByText('/src/a.ts')).toBeTruthy();
    expect(within(card).getByTestId('tool-read-window').textContent).toBe('第 21–23 行，共 90 行');
    expect(within(card).getByText('ts')).toBeTruthy();
    const numbers = [...card.querySelectorAll('[data-read-line]')].map((row) =>
      row.getAttribute('data-read-line'),
    );
    expect(numbers).toEqual(['21', '22', '23']);
    expect(screen.queryByTestId('tool-output')).toBeNull();
  });

  it('讀檔：有上色（ts 是開機就載的文法）', () => {
    render(<ToolCard entry={read(readLines(1, 1), 1)} beam={false} />);
    expand(/讀取/);
    const row = screen.getByTestId('tool-read').querySelector('[data-read-line="1"]');
    expect(row?.querySelectorAll('span[style]').length).toBeGreaterThan(1);
  });

  it('讀檔：超過 8 行只畫頭 4 尾 4，中間可以展開', () => {
    render(<ToolCard entry={read(readLines(1, 20), 20)} beam={false} />);
    expand(/讀取/);
    const card = screen.getByTestId('tool-read');
    const numbers = () =>
      [...card.querySelectorAll('[data-read-line]')].map((row) =>
        row.getAttribute('data-read-line'),
      );
    expect(numbers()).toEqual(['1', '2', '3', '4', '17', '18', '19', '20']);
    expect(screen.queryByTestId('tool-read-window')).toBeNull();
    const toggle = screen.getByTestId('tool-read-toggle');
    expect(toggle.textContent).toBe('展開其餘 12 行');
    fireEvent.click(toggle);
    expect(numbers()).toHaveLength(20);
    expect(toggle.textContent).toBe('收起');
  });

  it('讀檔：更正幀補上 meta，同一張卡從結果文字換成讀檔卡', () => {
    const settled = read(readLines(1, 2), 2);
    const { meta: _meta, ...bare } = settled;
    const view = render(<ToolCard entry={bare} beam={false} />);
    expand(/讀取/);
    expect(screen.getByTestId('tool-output')).toBeTruthy();
    view.rerender(<ToolCard entry={settled} beam={false} />);
    expect(screen.getByTestId('tool-read')).toBeTruthy();
    expect(screen.queryByTestId('tool-output')).toBeNull();
  });

  const grep = (meta: unknown) =>
    tool({
      name: 'grep',
      input: JSON.stringify({ pattern: 'foo', glob: null }),
      text: '（deepagents 格式的結果文字）',
      meta,
    });
  const files = (counts: number[]) =>
    counts.map((count, file) => ({
      path: `/src/f${file}.ts`,
      matches: Array.from({ length: count }, (_, at) => ({
        lineNumber: at + 1,
        line: `foo(${at + 1})`,
      })),
    }));

  it('grep：檔案標題列＋帶行號的命中，截斷時標頭寫「顯示 X／共 N」', () => {
    render(
      <ToolCard
        entry={grep({ shape: 'matches', files: files([1, 2]), truncated: true, total: 50 })}
        beam={false}
      />,
    );
    expand(/搜尋/);
    const card = screen.getByTestId('tool-search');
    expect(within(card).getByText('顯示 3／共 50 處符合 · 2 個檔案')).toBeTruthy();
    const rows = [...card.querySelectorAll('[data-search-row]')].map(
      (row) => `${row.getAttribute('data-search-row')}:${row.textContent}`,
    );
    expect(rows).toEqual([
      'file:/src/f0.ts1',
      'match:1: foo(1)',
      'file:/src/f1.ts2',
      'match:1: foo(1)',
      'match:2: foo(2)',
    ]);
    expect(screen.queryByTestId('tool-output')).toBeNull();
  });

  it('grep：超過 8 列收在中間，尾段補回檔案標題', () => {
    render(
      <ToolCard
        entry={grep({ shape: 'matches', files: files([3, 6]), truncated: false, total: 9 })}
        beam={false}
      />,
    );
    expand(/搜尋/);
    const card = screen.getByTestId('tool-search');
    const rows = () => [...card.querySelectorAll('[data-search-row]')];
    expect(rows()).toHaveLength(8);
    expect(rows()[4]?.textContent).toBe('/src/f1.ts6');
    expect(screen.getByTestId('tool-search-toggle').textContent).toBe('展開其餘 3 列');
    fireEvent.click(screen.getByTestId('tool-search-toggle'));
    expect(rows()).toHaveLength(11);
  });

  it('glob：一列一個路徑；更正幀補上 meta 時換卡', () => {
    const settled = tool({
      name: 'glob',
      input: JSON.stringify({ pattern: '**/*.ts' }),
      text: '/src/a.ts\n/src/b.ts',
      meta: { shape: 'paths', paths: ['/src/a.ts', '/src/b.ts'], truncated: false, total: 2 },
    });
    const { meta: _meta, ...bare } = settled;
    const view = render(<ToolCard entry={bare} beam={false} />);
    expand(/搜尋|尋找/);
    expect(screen.getByTestId('tool-output')).toBeTruthy();
    view.rerender(<ToolCard entry={settled} beam={false} />);
    const card = screen.getByTestId('tool-search');
    expect(within(card).getByText('2 個路徑')).toBeTruthy();
    expect(
      [...card.querySelectorAll('[data-search-row="path"]')].map((row) => row.textContent),
    ).toEqual(['/src/a.ts', '/src/b.ts']);
  });

  it('meta 形狀不對：照舊畫結果文字，不畫半套', () => {
    render(
      <ToolCard
        entry={grep({ shape: 'matches', files: 'x', truncated: false, total: 1 })}
        beam={false}
      />,
    );
    expand(/搜尋/);
    expect(screen.queryByTestId('tool-search')).toBeNull();
    expect(screen.getByTestId('tool-output')).toBeTruthy();
  });

  it('展開的讀檔卡與搜尋卡過 axe', async () => {
    const { container } = render(
      <>
        <ToolCard entry={read(readLines(1, 20), 40)} beam={false} />
        <ToolCard
          entry={{
            ...grep({ shape: 'matches', files: files([3, 6]), truncated: true, total: 40 }),
            id: 'tool-2',
          }}
          beam={false}
        />
      </>,
    );
    for (const trigger of screen.getAllByRole('button', { expanded: false })) {
      fireEvent.click(trigger);
    }
    expect(await axeViolations(container)).toEqual([]);
  });
});

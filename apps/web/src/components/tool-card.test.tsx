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
    render(<ToolCard entry={tool()} beam={false} />);
    const trigger = screen.getByRole('button', { name: /讀取/ });
    expect(trigger.textContent).toContain('read_file');
    expect(trigger.textContent).toContain('src/App.tsx');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    // 參數高亮後被切成一段一段的 span，改看整塊程式碼的字。
    expect(document.querySelector('.md-code')).toBeNull();

    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('.md-code pre')?.textContent).toContain(
      '"file_path": "src/App.tsx"',
    );
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
      const truncated = `${whole.slice(0, 14)}\n…（中間 40000 個位元組沒有送出來，全文在會話日誌裡）\n${whole.slice(-14)}`;
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

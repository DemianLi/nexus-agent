import type { ConversationEntry, ConversationState } from '@nexus/wire';
import {
  appendAnswers,
  appendDecision,
  appendQuestionCancel,
  appendQuestionDecline,
  COMPACTION,
  DELIVERABLES_PRESENTED,
  emptyConversation,
  prependEntries,
  reduceAll,
  SETTLE_NOTICE,
  WORKSPACE_CHANGES,
} from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { MAX_TOKENS_NOTICE } from '@/lib/max-tokens-view';
import { Script } from '@/test/conversation-frames';
import {
  ENDING_LABEL,
  TRACE_HEADLINE,
  TRACE_LIMITS,
  TRACE_TARGET_MISSING_TEXT,
  traceTurns,
} from '@/lib/trace-view';
import type { TraceRow } from '@/lib/trace-view';

const kinds = (rows: readonly TraceRow[]) => rows.map((row) => row.kind);
const only = (state: ConversationState) => {
  const turns = traceTurns(state);
  expect(turns).toHaveLength(1);
  return turns[0]!.rows;
};

/**
 * 一整輪真實形狀的對話：人說話、思考、讀檔、回覆、停在核准點、人核准、改檔、一顆失敗、壓縮、收尾。
 * 全部走真的 frame 折進 `reduceAll`；**核准的決定走 `appendDecision`**，那是它進得了狀態的唯一一條路（下行不回聲）。
 */
function richTurn() {
  const script = new Script();
  const first = reduceAll(emptyConversation(), [
    script.running(),
    ...script.human('history-0', '幫我整理 README\n順便檢查連結'),
    ...script.ai('a', { reasoning: '先看檔案結構\n再決定怎麼改' }),
    script.started('c1', 'read_file', { file_path: 'README.md' }),
    script.finished('c1', '# 專案'),
    ...script.ai('b', { text: '讀完了。\n接下來改寫。' }),
    script.started('c2', 'edit_file', { file_path: 'README.md' }),
    script.approval('int-1', 'edit_file'),
  ]);
  const decided = appendDecision(first, 'int-1', 'approve');
  return reduceAll(decided, [
    script.finished('c2', '已改'),
    script.started('c3', 'glob', { pattern: '**/*.md' }),
    script.failed('c3', '沒有權限', 'EACCES'),
    script.custom(COMPACTION, { seq: 9, cutoff: 4, saved: true }),
    ...script.ai('c', { text: '都處理好了。' }),
    script.completed(),
  ]);
}

describe('traceTurns：一輪一組、依序一列', () => {
  it('真實形狀的一輪：每種條目各有一列，順序就是對話裡的順序', () => {
    const rows = only(richTurn());
    expect(kinds(rows)).toEqual([
      'input',
      'thinking',
      'tool',
      'reply',
      'tool',
      'decision',
      'tool',
      'compaction',
      'reply',
    ]);
    // 工具列：名稱、一行摘要、狀態與失敗碼都在條目上，沿用 `toolSummary`。
    const tools = rows.filter((row) => row.kind === 'tool');
    expect(tools.map((row) => [row.title, row.summary, row.entry.status])).toEqual([
      ['讀取', 'README.md', 'done'],
      ['編輯檔案', 'README.md', 'done'],
      ['搜尋', '**/*.md', 'failed'],
    ]);
    expect(tools[2]?.entry.errorCode).toBe('EACCES');
    // 輸入與回覆只取第一行；思考列帶全文，摘要由 `ReasoningRow` 自己算。
    expect(rows[0]).toMatchObject({ kind: 'input', summary: '幫我整理 README' });
    expect(rows[1]).toMatchObject({ kind: 'thinking', text: '先看檔案結構\n再決定怎麼改' });
    expect(rows[3]).toMatchObject({ kind: 'reply', summary: '讀完了。' });
    expect(rows[5]).toMatchObject({ kind: 'decision', summary: '已核准：edit_file' });
  });

  it('每一列都指到對話區那一格（條目 id）；同一則回覆的兩列 key 不同、target 相同', () => {
    const script = new Script();
    const state = reduceAll(emptyConversation(), [
      script.running(),
      ...script.ai('a', { reasoning: '想', text: '說' }),
      script.completed(),
    ]);
    const rows = only(state);
    expect(kinds(rows)).toEqual(['thinking', 'reply']);
    expect(rows[0]?.target).toBe(rows[1]?.target);
    expect(rows[0]?.key).not.toBe(rows[1]?.key);
    expect(state.entries.map((entry) => entry.id)).toContain(rows[0]?.target);
  });

  it('空白的回覆不長列：正文只有空白又沒有推理，跟對話區同一個判準', () => {
    const script = new Script();
    const state = reduceAll(emptyConversation(), [
      script.running(),
      ...script.ai('a', { text: '\n\n' }),
      script.started('c1', 'read_file', { file_path: 'a' }),
      script.finished('c1', 'x'),
      script.completed(),
    ]);
    expect(kinds(only(state))).toEqual(['tool']);
  });
});

describe('切輪（限制 1）', () => {
  it('人的話、結算通知、子代理來信各開一輪', () => {
    const script = new Script();
    const state = reduceAll(emptyConversation(), [
      script.running(),
      ...script.human('history-0', '第一句'),
      ...script.ai('a', { text: '回' }),
      script.completed(),
      script.custom(SETTLE_NOTICE, { id: 'history-5', reason: 'completed' }),
      script.running(),
      ...script.ai('b', { text: '收到通知' }),
      script.completed(),
    ]);
    const turns = traceTurns(state);
    expect(turns.map((turn) => kinds(turn.rows))).toEqual([
      ['input', 'reply'],
      ['notice', 'reply'],
    ]);
  });

  it('目標自己排的輪次沒有人話，列黏在前一輪後面——限制寫在畫面上', () => {
    const script = new Script();
    const state = reduceAll(emptyConversation(), [
      script.running(),
      ...script.human('history-0', '做這件事'),
      ...script.ai('a', { text: '做完了' }),
      script.completed(),
      // 目標續行：沒有人話的一輪。
      script.running(),
      ...script.ai('b', { text: '繼續下一步' }),
      script.completed(),
    ]);
    const turns = traceTurns(state);
    expect(turns).toHaveLength(1);
    expect(kinds(turns[0]!.rows)).toEqual(['input', 'reply', 'reply']);
    expect(TRACE_LIMITS.turns).toContain('沒有人話');
    expect(TRACE_LIMITS.turns).toContain('黏在前一輪');
  });

  it('載入的第一段不是從人那一句開始：開頭那一組沒有輸入列，不補一個假的', () => {
    const script = new Script();
    const state = reduceAll(emptyConversation(), [
      script.running(),
      ...script.ai('a', { text: '中間接上' }),
      script.completed(),
      script.running(),
      ...script.human('history-9', '後面的人話'),
      script.completed(),
    ]);
    const turns = traceTurns(state);
    expect(turns.map((turn) => kinds(turn.rows))).toEqual([['reply'], ['input']]);
  });

  it('往前翻之後前面多出來的輪接在最前面，後面的 key 不動', () => {
    const script = new Script();
    const latest = reduceAll(emptyConversation(), [
      script.running(),
      ...script.human('history-5', '近的'),
      script.completed(),
    ]);
    const older = reduceAll(emptyConversation(), [
      script.running(),
      ...script.human('history-1', '早的'),
      script.completed(),
    ]);
    const before = traceTurns(latest);
    const after = traceTurns(prependEntries(latest, older));
    expect(after.map((turn) => turn.key)).toEqual(['history-1', ...before.map((turn) => turn.key)]);
  });
});

describe('決定只存本地（限制 2）', () => {
  it('重新整理之後（同樣的 frame 重放、沒有 appendDecision）決定列不見了，工具卡的失敗還在', () => {
    // 同一串 frame：核准點上人按了拒絕，被拒的那顆在日誌裡是一張失敗的卡（#297）。
    const build = (withDecision: boolean) => {
      const script = new Script();
      const asked = reduceAll(emptyConversation(), [
        script.running(),
        ...script.human('history-0', '改一下'),
        script.started('c1', 'edit_file', { file_path: 'a.md' }),
        script.approval('int-1', 'edit_file'),
      ]);
      const decided = withDecision ? appendDecision(asked, 'int-1', 'reject') : asked;
      return reduceAll(decided, [
        script.failed('c1', '使用者拒絕', 'REJECTED'),
        script.completed(),
      ]);
    };
    const live = only(build(true));
    const reloaded = only(build(false));
    expect(kinds(live)).toContain('decision');
    expect(kinds(reloaded)).not.toContain('decision');
    const failedTool = reloaded.find((row) => row.kind === 'tool');
    expect(failedTool).toMatchObject({
      kind: 'tool',
      entry: { status: 'failed', errorCode: 'REJECTED' },
    });
    expect(TRACE_LIMITS.decisions).toContain('重新整理之後看不到你當時按了什麼');
  });

  it('限制只講「決定」：人答的提問答案在工具結果文字裡，重新整理後還在', () => {
    const script = new Script();
    const reloaded = reduceAll(emptyConversation(), [
      script.running(),
      ...script.human('history-0', '約個時間'),
      script.started('q1', 'ask_user_question', {
        questions: [{ id: 'day', question: '哪一天？', options: [{ label: '週一' }] }],
      }),
      script.finished('q1', JSON.stringify({ answers: [{ id: 'day', selected: ['週一'] }] })),
      script.completed(),
    ]);
    const rows = only(reloaded);
    expect(kinds(rows)).toEqual(['input', 'tool']);
    expect(rows[1]).toMatchObject({ summary: '已回答 1/1 題' });
    expect(TRACE_LIMITS.decisions).not.toContain('回答');
  });
});

describe('提問的答案', () => {
  const asked = () => {
    const script = new Script();
    return {
      script,
      state: reduceAll(emptyConversation(), [
        script.running(),
        ...script.human('history-0', '約個時間'),
        script.started('q1', 'ask_user_question', {
          questions: [{ id: 'day', question: '哪一天？', options: [{ label: '週一' }] }],
        }),
        script.question('int-q'),
      ]),
    };
  };

  it('配得到提問卡的答案併進那一列，不另長一列', () => {
    const { state } = asked();
    const answered = appendAnswers(state, 'int-q', [{ id: 'day', selected: ['週一'] }]);
    expect(answered.entries.some((entry) => entry.kind === 'answer')).toBe(true);
    expect(kinds(only(answered))).toEqual(['input', 'tool']);
  });

  it('放棄整組是一個決定，配不到提問卡：自己長一列、沒有地方可定位', () => {
    const { state } = asked();
    const cancelled = appendQuestionCancel(state, 'int-q');
    const rows = only(cancelled);
    expect(kinds(rows)).toEqual(['input', 'tool', 'answer']);
    expect(rows[2]).toMatchObject({ summary: '放棄回答這些問題', target: undefined });
  });

  it('拒絕整組（MCP 反問，#1098）同樣自己長一列，寫「拒絕」，與放棄分開', () => {
    const { state } = asked();
    const declined = appendQuestionDecline(state, 'int-q');
    expect(declined.entries.find((entry) => entry.kind === 'answer')).toMatchObject({
      declined: true,
    });
    const rows = only(declined);
    expect(kinds(rows)).toEqual(['input', 'tool', 'answer']);
    expect(rows[2]).toMatchObject({ summary: '拒絕回答這些問題', target: undefined });
  });
});

describe('收尾', () => {
  it('撞到輸出上限、被打斷、出錯各一列，跟在那則回覆後面', () => {
    const script = new Script();
    const capped = reduceAll(emptyConversation(), [
      script.running(),
      ...script.ai('a', { text: '寫到一半' }),
      script.cutOff(),
    ]);
    const rows = only(capped);
    expect(kinds(rows)).toEqual(['reply', 'ending']);
    expect(rows[1]).toMatchObject({ reason: 'max-tokens', summary: MAX_TOKENS_NOTICE });
  });

  it('講到一半被按停止：回覆上的旗標長一列，不再因為 status 多長一列', () => {
    const script = new Script();
    const state = reduceAll(emptyConversation(), [
      script.running(),
      script.openAi('a'),
      script.delta('a', '講到一半'),
      script.stopped(),
    ]);
    const rows = only(state);
    expect(state.status).toBe('stopped');
    expect(rows.filter((row) => row.kind === 'ending')).toHaveLength(1);
    expect(rows.at(-1)).toMatchObject({ reason: 'stopped', summary: ENDING_LABEL.stopped });
  });

  it('停在工具執行中被按停止：沒有講到一半的回覆，收尾讀 status', () => {
    const script = new Script();
    const state = reduceAll(emptyConversation(), [
      script.running(),
      ...script.human('history-0', '跑一下'),
      script.started('c1', 'read_file', { file_path: 'a' }),
      script.stopped(),
    ]);
    const rows = only(state);
    expect(kinds(rows)).toEqual(['input', 'tool', 'ending']);
    expect(rows[2]).toMatchObject({
      reason: 'stopped',
      key: 'status:stopped',
      target: rows[1]?.target,
    });
  });

  it('整輪失敗：收尾那一列帶錯誤文字；只有最新那一輪讀 status', () => {
    const script = new Script();
    const failed = reduceAll(emptyConversation(), [
      script.running(),
      ...script.human('history-0', '舊的一輪'),
      script.completed(),
      script.running(),
      ...script.human('history-1', '新的一輪'),
      script.frame('error', { message: '模型壞了' }),
      script.frame('lifecycle', { event: 'failed', graph_name: 'root' }),
    ]);
    const turns = traceTurns(failed);
    expect(failed.status).toBe('failed');
    expect(turns).toHaveLength(2);
    expect(kinds(turns[0]!.rows)).toEqual(['input']);
    expect(kinds(turns[1]!.rows)).toEqual(['input', 'ending']);
    expect(turns[1]!.rows[1]).toMatchObject({ reason: 'failed' });
  });
});

describe('不長列的條目', () => {
  it('交付檔與改動紀錄不長列（卡上沒列；交付由那顆 present 工具列看得到），釘住免得被當成漏掉', () => {
    const script = new Script();
    const state = reduceAll(emptyConversation(), [
      script.running(),
      ...script.human('history-0', '交付一下'),
      script.started('c1', 'present', { files: [{ path: 'a.md' }] }),
      script.finished('c1', 'ok'),
      script.custom(DELIVERABLES_PRESENTED, { callId: 'c1', seq: 7, files: [{ path: 'a.md' }] }),
      script.custom(WORKSPACE_CHANGES, { seq: 8 }),
      script.completed(),
    ]);
    const entryKinds = state.entries.map((entry: ConversationEntry) => entry.kind);
    expect(entryKinds).toContain('deliverables');
    expect(entryKinds).toContain('workspace-changes');
    expect(kinds(only(state))).toEqual(['input', 'tool']);
  });
});

describe('計劃的審核結果與子代理', () => {
  it('交出計劃那一顆：摘要是計劃標題，同意的結果掛在列上', () => {
    const script = new Script();
    const state = reduceAll(emptyConversation(), [
      script.running(),
      ...script.human('history-0', '規劃一下'),
      script.started('p1', 'exit_plan_mode', { plan: '# 搬家計劃\n\n先打包。' }),
      script.finished('p1', '使用者同意'),
      script.completed(),
    ]);
    expect(only(state)[1]).toMatchObject({
      kind: 'tool',
      summary: '搬家計劃',
      outcome: 'approved',
    });
  });

  it('子代理那幾列帶歸屬，主對話的不帶；join 不起來就照講未歸屬', () => {
    const script = new Script();
    const state = reduceAll(emptyConversation(), [
      script.running(),
      ...script.ai('a', { text: '主對話' }),
      ...script.ai('b', { text: '半路接上', namespace: ['tools:zzz', 'model_request:x'] }),
      script.completed(),
    ]);
    const rows = only(state);
    expect(rows[0]).not.toHaveProperty('attribution');
    expect(rows[1]).toMatchObject({ attribution: { kind: 'unattributed' } });
  });
});

describe('畫面上的字', () => {
  it('四條限制與第 0 版的說明都有字', () => {
    expect(TRACE_HEADLINE).toBe('第 0 版：只有順序，沒有時間');
    for (const text of Object.values(TRACE_LIMITS)) expect(text.length).toBeGreaterThan(10);
    expect(Object.keys(TRACE_LIMITS)).toEqual(['turns', 'decisions', 'loaded', 'absent']);
    expect(TRACE_LIMITS.loaded).toContain('已載入');
    expect(TRACE_TARGET_MISSING_TEXT).toContain('往上捲載入更早的對話');
  });

  it('沒有任何條目就沒有任何輪', () => {
    expect(traceTurns(emptyConversation())).toEqual([]);
  });
});

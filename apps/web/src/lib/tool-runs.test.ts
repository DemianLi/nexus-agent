import type { ConversationState, Event } from '@nexus/wire';
import { appendAnswers, appendDecision, emptyConversation, reduceAll } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { transcriptItems } from '@/lib/deliverables-view';
import { EXIT_PLAN_MODE } from '@/lib/plan-review';
import { PRESENT } from '@/lib/present-view';
import { ASK_USER_QUESTION } from '@/lib/question-view';
import type { GroupedItem } from '@/lib/tool-runs';
import { MIN_TOOLS, groupToolRuns, toolRunId, toolRunOf, toolRunSummary } from '@/lib/tool-runs';
import { Script } from '@/test/conversation-frames';

/**
 * 分組規則（#1309）。條目都是折真的 frame 出來的（`Script` → `reduceAll`），不手寫。
 * 簽名：`think`（只有思考的一步）、`say`（有字的回覆）、`<工具>:<狀態>`；收起來的一段寫成 `[...]`。
 */
function sig(item: GroupedItem): string {
  if (item.kind === 'tool-run') return `[${item.entries.map(entrySig).join(' ')}]`;
  if (item.kind !== 'entry') return item.kind;
  return entrySig(item.entry);
}
function entrySig(entry: ConversationState['entries'][number]): string {
  if (entry.kind === 'tool') return `${entry.name}:${entry.status}`;
  if (entry.kind === 'ai') return entry.text.trim() === '' ? 'think' : 'say';
  return entry.kind;
}
const grouped = (state: ConversationState) => groupToolRuns(transcriptItems(state.entries));
const shape = (state: ConversationState) => grouped(state).map(sig);

class Turn {
  readonly script = new Script();
  readonly events: Event[] = [];
  #n = 0;
  constructor() {
    this.events.push(this.script.running(), ...this.script.human('h1', '盤點各系統的筆記'));
  }
  /** 一步：先想，再呼叫一顆工具，`outcome` 決定它停在哪。 */
  step(
    name = 'read_file',
    outcome: 'done' | 'failed' | 'running' = 'done',
    meta?: unknown,
  ): string {
    const n = ++this.#n;
    const call = `c${n}`;
    this.events.push(...this.script.ai(`r${n}`, { reasoning: `第 ${n} 步要看什麼` }));
    this.events.push(this.script.started(call, name, { file_path: `/kb/${n}.md` }));
    if (outcome === 'done') {
      this.events.push(
        meta === undefined
          ? this.script.finished(call, 'ok')
          : this.script.finishedWith(call, 'ok', meta),
      );
    }
    if (outcome === 'failed') this.events.push(this.script.failed(call, '找不到檔案'));
    return call;
  }
  say(text = '整理好了。') {
    const n = ++this.#n;
    this.events.push(...this.script.ai(`r${n}`, { reasoning: '收尾', text }));
  }
  state() {
    return reduceAll(emptyConversation(), this.events);
  }
}

describe('groupToolRuns：只收全部完成的連續段（#1309）', () => {
  it('推理模型的樣子：思考、工具交替八次，收成一段八顆；段首的思考在段內，有字的回覆在段外', () => {
    const turn = new Turn();
    for (let i = 0; i < 7; i += 1) turn.step();
    turn.step('write_file');
    turn.say();
    const items = grouped(turn.state());
    expect(items.map(sig)).toEqual([
      'human',
      `[${Array(7).fill('think read_file:done').join(' ')} think write_file:done]`,
      'say',
    ]);
    const run = items[1]!;
    expect(run.kind === 'tool-run' && run.tools.length).toBe(8);
    expect(run.id).toBe(toolRunId(turn.state().entries[1]!.id));
  });

  it('失敗的卡切開連續段，它那一步的思考（段尾）留在段外', () => {
    const turn = new Turn();
    turn.step();
    turn.step();
    turn.step('read_file', 'failed');
    turn.step();
    turn.step();
    expect(shape(turn.state())).toEqual([
      'human',
      '[think read_file:done think read_file:done]',
      'think',
      'read_file:failed',
      '[think read_file:done think read_file:done]',
    ]);
  });

  it('執行中的卡（帶邊框光的那顆）不收，也不讓前面的段把它吞進去', () => {
    const turn = new Turn();
    turn.step();
    turn.step();
    turn.step('read_file', 'running');
    expect(shape(turn.state())).toEqual([
      'human',
      '[think read_file:done think read_file:done]',
      'think',
      'read_file:running',
    ]);
  });

  it('停在核准點：等的那顆切開；按下去之後的決定也切開，前後各自成段', () => {
    const turn = new Turn();
    turn.step();
    turn.step();
    const gated = turn.step('write_file', 'running');
    turn.events.push(turn.script.approval('i1', 'write_file'));
    const waiting = turn.state();
    expect(waiting.status).toBe('awaiting-input');
    expect(shape(waiting)).toEqual([
      'human',
      '[think read_file:done think read_file:done]',
      'think',
      'write_file:running',
    ]);
    // 核准、那顆跑完、再兩步：決定那一則把段切開。
    const decided = appendDecision(waiting, 'i1', 'approve');
    const after = turn.script;
    const rest = [
      after.finished(gated, 'ok'),
      ...after.ai('r9', { reasoning: '再看' }),
      after.started('c9', 'read_file', {}),
      after.finished('c9', 'ok'),
      ...after.ai('r10', { reasoning: '再看' }),
      after.started('c10', 'read_file', {}),
      after.finished('c10', 'ok'),
    ];
    expect(shape(reduceAll(decided, rest))).toEqual([
      'human',
      '[think read_file:done think read_file:done think write_file:done]',
      'decision',
      '[think read_file:done think read_file:done]',
    ]);
  });

  it('等你回答的提問卡（suspended）切開', () => {
    const turn = new Turn();
    turn.step();
    turn.step();
    turn.step('ask_user_question', 'running');
    turn.events.push(turn.script.question('q1'));
    const items = shape(turn.state());
    expect(items.slice(0, 2)).toEqual(['human', '[think read_file:done think read_file:done]']);
    expect(items.at(-1)).toMatch(/^ask_user_question:(suspended|running)$/);
  });

  it('有字的回覆切開', () => {
    const turn = new Turn();
    turn.step();
    turn.step();
    turn.say('先講一下看到的');
    turn.step();
    turn.step();
    expect(shape(turn.state())).toEqual([
      'human',
      '[think read_file:done think read_file:done]',
      'say',
      '[think read_file:done think read_file:done]',
    ]);
  });

  it('還在串流的那一步切開（不是「完成的」）', () => {
    const turn = new Turn();
    turn.step();
    turn.step();
    turn.events.push(turn.script.openAi('live'));
    const items = shape(turn.state());
    expect(items.slice(0, 2)).toEqual(['human', '[think read_file:done think read_file:done]']);
    expect(items).toHaveLength(3);
  });

  it('還在串流的那一步不算完成：後面就算已經有完成的工具，也不把它收進去', () => {
    const turn = new Turn();
    turn.step();
    turn.step();
    turn.events.push(turn.script.openAi('live'));
    for (const call of ['c8', 'c9']) {
      turn.events.push(
        turn.script.started(call, 'read_file', {}),
        turn.script.finished(call, 'ok'),
      );
    }
    expect(shape(turn.state())).toEqual([
      'human',
      '[think read_file:done think read_file:done]',
      'think',
      '[read_file:done read_file:done]',
    ]);
  });

  it('答完的提問卡不收、切開連續段（#1327）：「完成、完成、提問、完成」收成一段＋提問卡＋不收的單顆', () => {
    const turn = new Turn();
    turn.step();
    turn.step();
    const asked = turn.step('ask_user_question', 'running');
    turn.events.push(turn.script.question('q1'));
    const answered = appendAnswers(turn.state(), 'q1', [{ id: 'day', selected: ['週一'] }]);
    const script = turn.script;
    const rest = [
      script.finished(asked, '週一'),
      ...script.ai('r8', { reasoning: '照週一排' }),
      script.started('c8', 'read_file', {}),
      script.finished('c8', 'ok'),
    ];
    // 本地那一則答案 `transcriptItems` 已拿掉，人選了什麼只寫在提問卡上：卡要露在外面。
    expect(shape(reduceAll(answered, rest))).toEqual([
      'human',
      '[think read_file:done think read_file:done]',
      'think',
      'ask_user_question:done',
      'think',
      'read_file:done',
    ]);
  });

  it(`單顆不收（至少 ${MIN_TOOLS} 顆）`, () => {
    const turn = new Turn();
    turn.step();
    turn.say();
    expect(shape(turn.state())).toEqual(['human', 'think', 'read_file:done', 'say']);
  });

  it.each([
    ['計劃卡', EXIT_PLAN_MODE, undefined],
    ['交付卡（present）', PRESENT, undefined],
    ['提問卡', ASK_USER_QUESTION, undefined],
    [
      '背景委派卡',
      'task',
      { kind: 'background-subagent', runId: 'bg1', subagentType: 'general-purpose' },
    ],
  ])('%s不收、也不跳過：「完成、完成、它、完成、完成」收成兩段', (_, name, meta) => {
    const turn = new Turn();
    turn.step();
    turn.step();
    turn.step(name, 'done', meta);
    turn.step();
    turn.step();
    expect(shape(turn.state())).toEqual([
      'human',
      '[think read_file:done think read_file:done]',
      'think',
      `${name}:done`,
      '[think read_file:done think read_file:done]',
    ]);
  });

  it('前景委派卡（沒有背景 meta）照樣收', () => {
    const turn = new Turn();
    turn.step('task');
    turn.step();
    expect(shape(turn.state())).toEqual(['human', '[think task:done think read_file:done]']);
  });

  it('人的話切開（不跨輪）', () => {
    const turn = new Turn();
    turn.step();
    turn.step();
    turn.events.push(...turn.script.human('h2', '再查一次'));
    turn.step();
    turn.step();
    expect(shape(turn.state())).toEqual([
      'human',
      '[think read_file:done think read_file:done]',
      'human',
      '[think read_file:done think read_file:done]',
    ]);
  });

  it('重新整理後的重播（另一個 Script 從頭折同樣的 frame）：分組一樣，群組 id 一樣', () => {
    const turn = new Turn();
    turn.step();
    turn.step();
    turn.say();
    const replay = reduceAll(emptyConversation(), [...turn.events]);
    expect(grouped(replay).map(sig)).toEqual(grouped(turn.state()).map(sig));
    expect(grouped(replay)[1]!.id).toBe(grouped(turn.state())[1]!.id);
  });
});

describe('toolRunSummary／toolRunOf', () => {
  it('照第一次出現的順序，同名併起來寫次數', () => {
    const turn = new Turn();
    turn.step();
    turn.step('write_file');
    turn.step();
    const run = grouped(turn.state())[1]!;
    expect(run.kind).toBe('tool-run');
    if (run.kind !== 'tool-run') return;
    expect(toolRunSummary(run.tools)).toBe('讀取 ×2、寫入檔案');
  });

  it('找得到段裡每一則（含思考）屬於哪一段；段外的是 undefined', () => {
    const turn = new Turn();
    turn.step();
    turn.step();
    turn.say();
    const items = grouped(turn.state());
    const run = items[1]!;
    if (run.kind !== 'tool-run') throw new Error('沒收起來');
    for (const entry of run.entries) expect(toolRunOf(items, entry.id)).toBe(run.id);
    expect(toolRunOf(items, 'h1')).toBeUndefined();
  });
});

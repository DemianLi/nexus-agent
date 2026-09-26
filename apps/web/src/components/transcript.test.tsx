import type { Event } from '@nexus/wire';
import { emptyConversation, INBOX, reduceAll } from '@nexus/wire';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Transcript } from '@/components/transcript';
import { MAX_TOKENS_NOTICE } from '@/lib/max-tokens-view';

/**
 * 推理列與正文空的回覆（[#527](https://github.com/DemianLi/nexus-agent/issues/527)、#565）。只想、只呼叫工具的
 * 那幾步會留下一則 `text: ''`、帶著推理的 AI entry；#562 之後重新整理也會有。狀態從真的 frame 用 `reduceAll` 折出來。
 */

afterEach(cleanup);

const ROOT = ['model_request:1'];

let seq = 0;
function frame(method: string, namespace: readonly string[], data: unknown): Event {
  const current = seq++;
  return {
    type: 'event',
    seq: current,
    event_id: `t:${current}`,
    method,
    params: { namespace, timestamp: 0, data },
  } as Event;
}

const running = () => frame('lifecycle', [], { event: 'running', graph_name: 'root' });
const start = (id: string) =>
  frame('messages', ROOT, { event: 'message-start', id: `run-${id}`, run_id: id });
const delta = (id: string, value: Record<string, unknown>) =>
  frame('messages', ROOT, { event: 'content-block-delta', index: 0, delta: value, run_id: id });
const finish = (id: string) =>
  frame('messages', ROOT, { event: 'message-finish', reason: 'stop', run_id: id });

/**
 * 人問的那一句：伺服器領走開跑時推的 `inbox`（`claimed`）。**不帶 `seq`**：各測試的 frame 在呼叫 {@link show} 之前就
 * 取好了 `seq`，這一顆若另取一個比它們大的，後面那些會被當成重複丟掉；沒有 `seq` 的 frame 不推進 `lastSeq`。
 */
const asked = (text: string): Event =>
  ({
    type: 'event',
    event_id: 't:asked',
    method: 'custom',
    params: {
      namespace: [],
      timestamp: 0,
      data: { name: INBOX, payload: { items: [], claimed: { id: 'q', text } } },
    },
  }) as Event;

function show(events: Event[]) {
  const state = reduceAll(emptyConversation(), [asked('問'), ...events]);
  render(<Transcript state={state} isFresh={() => false} />);
  return state;
}

const think = (id: string, reasoning: string) => delta(id, { type: 'reasoning-delta', reasoning });
const say = (id: string, text: string) => delta(id, { type: 'text-delta', text });
const bubbleIn = (entry: HTMLElement) => entry.querySelector('[data-slot=bubble]');
const rowIn = (entry: HTMLElement) => within(entry).queryByTestId('reasoning-row');

describe('正文空的回覆', () => {
  it('只有推理、講完了的那一步只畫推理列、不畫泡泡；有正文的那則照畫泡泡', () => {
    const state = show([
      running(),
      start('a'),
      think('a', '先想一下'),
      finish('a'),
      start('b'),
      say('b', '好了'),
      finish('b'),
    ]);
    // 前提：折疊器真的長出了那一則空的，而且帶著推理。
    expect(state.entries).toMatchObject([
      { kind: 'human' },
      { kind: 'ai', text: '', reasoning: '先想一下', streaming: false },
      { kind: 'ai', text: '好了' },
    ]);
    const [thought, reply] = screen.getAllByTestId('ai-entry');
    expect(rowIn(thought!)).not.toBeNull();
    expect(bubbleIn(thought!)).toBeNull();
    expect(rowIn(reply!)).toBeNull();
    expect(bubbleIn(reply!)?.textContent).toContain('好了');
  });

  it('沒推理、講完了的空回覆整則不畫', () => {
    show([running(), start('a'), finish('a'), start('b'), say('b', '好了'), finish('b')]);
    expect(screen.getAllByTestId('ai-entry')).toHaveLength(1);
  });

  it('推理只有空白的，當作沒有推理', () => {
    show([running(), start('a'), think('a', '\n  \n'), finish('a')]);
    expect(screen.queryAllByTestId('ai-entry')).toHaveLength(0);
    expect(screen.queryByTestId('reasoning-row')).toBeNull();
  });

  it('正文只有空白的也算空：有推理只畫推理列，沒推理整則不畫', () => {
    show([
      running(),
      start('a'),
      think('a', '先想'),
      say('a', '\n\n'),
      finish('a'),
      start('b'),
      say('b', '\n'),
      finish('b'),
    ]);
    const entries = screen.getAllByTestId('ai-entry');
    expect(entries).toHaveLength(1);
    expect(rowIn(entries[0]!)).not.toBeNull();
    expect(bubbleIn(entries[0]!)).toBeNull();
  });

  it('推理之後先吐了空白：仍然是「思考中」', () => {
    show([running(), start('a'), think('a', '想'), say('a', '\n\n')]);
    const entry = screen.getByTestId('ai-entry');
    expect(within(entry).getByRole('button').textContent).toContain('思考中');
  });

  it('還在吐字、沒推理的空回覆照畫帶游標的泡泡', () => {
    show([running(), start('a')]);
    const entry = screen.getByTestId('ai-entry');
    expect(bubbleIn(entry)?.querySelector('.stream-caret')).not.toBeNull();
  });

  it('還在吐字、有推理的空回覆只畫「思考中」的推理列，不疊帶游標的空泡泡', () => {
    show([running(), start('a'), think('a', '想')]);
    const entry = screen.getByTestId('ai-entry');
    expect(bubbleIn(entry)).toBeNull();
    expect(within(entry).getByRole('button').textContent).toContain('思考中');
  });

  it('正文一開始吐字，推理就算講完了；泡泡帶游標', () => {
    show([running(), start('a'), think('a', '想'), say('a', '答')]);
    const entry = screen.getByTestId('ai-entry');
    expect(within(entry).getByRole('button').textContent).toContain('思考過程');
    expect(bubbleIn(entry)?.querySelector('.stream-caret')).not.toBeNull();
  });

  it('被按了停止的空回覆照畫，底下講「已停止」', () => {
    show([
      running(),
      start('a'),
      frame('lifecycle', [], {
        event: 'failed',
        graph_name: 'root',
        error: '這一輪被中止了',
        aborted: true,
      }),
    ]);
    expect(screen.getByTestId('ai-entry').textContent).toContain('（已停止）');
  });

  it('想到一半被按了停止：推理列講「思考過程」，不再是思考中', () => {
    show([
      running(),
      start('a'),
      think('a', '想到一半'),
      frame('lifecycle', [], {
        event: 'failed',
        graph_name: 'root',
        error: '這一輪被中止了',
        aborted: true,
      }),
    ]);
    const entry = screen.getByTestId('ai-entry');
    expect(within(entry).getByRole('button').textContent).toContain('思考過程');
    expect(entry.textContent).toContain('（已停止）');
  });

  describe('撞到輸出上限（#608）', () => {
    const cut = () =>
      frame('lifecycle', [], { event: 'completed', graph_name: 'root', maxTokens: true });

    it('有字的那則照畫泡泡，底下多一行提示', () => {
      show([running(), start('a'), say('a', '寫到一半'), finish('a'), cut()]);
      const entry = screen.getByTestId('ai-entry');
      expect(bubbleIn(entry)?.textContent).toContain('寫到一半');
      expect(entry.textContent).toContain(MAX_TOKENS_NOTICE);
    });

    it('一個字都沒吐（只在寫工具參數時被切斷）：照畫提示，不畫空泡泡', () => {
      show([running(), start('a'), finish('a'), cut()]);
      const entry = screen.getByTestId('ai-entry');
      expect(entry.textContent).toBe(MAX_TOKENS_NOTICE);
      expect(bubbleIn(entry)).toBeNull();
    });

    it('只有推理：推理列加提示，不畫空泡泡', () => {
      show([running(), start('a'), think('a', '想'), finish('a'), cut()]);
      const entry = screen.getByTestId('ai-entry');
      expect(rowIn(entry)).not.toBeNull();
      expect(entry.textContent).toContain(MAX_TOKENS_NOTICE);
      expect(bubbleIn(entry)).toBeNull();
    });

    it('對照：沒撞到上限的沒有提示，沒字的那則照舊整則不畫', () => {
      show([
        running(),
        start('a'),
        say('a', '寫完了'),
        finish('a'),
        start('b'),
        finish('b'),
        frame('lifecycle', [], { event: 'completed', graph_name: 'root' }),
      ]);
      expect(screen.getAllByTestId('ai-entry')).toHaveLength(1);
      expect(document.body.textContent).not.toContain(MAX_TOKENS_NOTICE);
    });
  });

  it('出錯的空回覆照畫錯誤', () => {
    show([
      running(),
      start('a'),
      frame('messages', ROOT, { event: 'error', message: '供應商回 503', run_id: 'a' }),
    ]);
    expect(screen.getByTestId('ai-entry').textContent).toContain('供應商回 503');
  });
});

describe('推理列', () => {
  const long = '\n**First** we list the files.\nThen we read a.txt.\nNow read b.txt.\n';

  it('預設收合；講完的摘要是第一行、拿掉 `**`', () => {
    show([running(), start('a'), think('a', long), finish('a')]);
    const trigger = screen.getByRole('button', { name: '思考過程' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByTestId('reasoning-summary').textContent).toBe('First we list the files.');
  });

  it('串流中的摘要是最新一行', () => {
    show([running(), start('a'), think('a', long)]);
    expect(screen.getByTestId('reasoning-summary').textContent).toBe('Now read b.txt.');
  });

  it('摘要不進按鈕的可存取名稱：每來一顆 chunk 它就變一次', () => {
    show([running(), start('a'), think('a', long)]);
    expect(screen.getByRole('button', { name: '思考中' })).toBeTruthy();
  });

  it('展開後畫出推理全文（markdown），摘要收起來', () => {
    show([running(), start('a'), think('a', long), finish('a')]);
    const trigger = screen.getByRole('button', { name: '思考過程' });
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const row = screen.getByTestId('reasoning-row');
    expect(row.querySelector('strong')?.textContent).toBe('First');
    expect(row.textContent).toContain('Now read b.txt.');
  });

  it('子代理的回覆也畫推理列', () => {
    const SUB = ['tools:call-1', 'model_request:1'];
    show([
      running(),
      frame('messages', SUB, { event: 'message-start', id: 'run-s', run_id: 's' }),
      frame('messages', SUB, {
        event: 'content-block-delta',
        index: 0,
        delta: { type: 'reasoning-delta', reasoning: 'sub thinking' },
        run_id: 's',
      }),
      frame('messages', SUB, { event: 'message-finish', reason: 'stop', run_id: 's' }),
    ]);
    expect(screen.getByTestId('reasoning-summary').textContent).toBe('sub thinking');
  });
});

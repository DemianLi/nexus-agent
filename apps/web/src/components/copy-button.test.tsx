import type { Event } from '@nexus/wire';
import { emptyConversation, INBOX, reduceAll } from '@nexus/wire';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CodeBlock } from '@/components/markdown/code-block';
import { MarkdownText } from '@/components/markdown-text';
import { Transcript } from '@/components/transcript';

/**
 * 回覆與程式碼區塊的複製鈕（[#1305](https://github.com/DemianLi/nexus-agent/issues/1305)）：講完才有、跟評分脫鉤、
 * 回覆複製 markdown 原文、程式碼區塊複製不含圍欄的原始碼。回饋（勾勾、toast、退路）跟交付卡片的「複製路徑」是同一顆，
 * 那幾條驗在 `deliverable/card.test.tsx`。
 */

const toastSpy = vi.hoisted(() => {
  const spy = vi.fn() as ReturnType<typeof vi.fn> & { error: ReturnType<typeof vi.fn> };
  spy.error = vi.fn();
  return spy;
});
vi.mock('sonner', () => ({ toast: toastSpy }));

const writeText = vi.fn();

beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  vi.stubGlobal('isSecureContext', true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  toastSpy.mockReset();
  toastSpy.error.mockReset();
});

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
const say = (id: string, text: string) =>
  frame('messages', ROOT, {
    event: 'content-block-delta',
    index: 0,
    delta: { type: 'text-delta', text },
    run_id: id,
  });
const finish = (id: string) =>
  frame('messages', ROOT, { event: 'message-finish', reason: 'stop', run_id: id });

/** 人問的那一句（同 `transcript.test.tsx`：不帶 `seq`）。 */
const asked: Event = {
  type: 'event',
  event_id: 't:asked',
  method: 'custom',
  params: {
    namespace: [],
    timestamp: 0,
    data: { name: INBOX, payload: { items: [], claimed: { id: 'q', text: '問' } } },
  },
} as Event;

/** 不給 `feedback`：沒有評分外掛的部署。 */
function show(events: Event[]) {
  const state = reduceAll(emptyConversation(), [asked, ...events]);
  render(<Transcript state={state} isFresh={() => false} />);
  return state;
}

const REPLY = '結論是 **可以**：\n\n```ts\nconst a = 1;\n```';

describe('複製回覆', () => {
  it('串流中沒有按鈕（不是透明，是不在）', () => {
    const state = show([running(), start('a'), say('a', REPLY)]);
    expect(state.entries.at(-1)).toMatchObject({ kind: 'ai', streaming: true });
    expect(screen.queryByRole('button', { name: '複製回覆' })).toBeNull();
    expect(screen.queryByRole('button', { name: '複製程式碼' })).toBeNull();
  });

  it('講完了、沒有評分外掛也有；按下去寫進剪貼簿的是 markdown 原文', async () => {
    show([running(), start('a'), say('a', REPLY), finish('a')]);
    expect(screen.queryByTestId('rating-buttons')).toBeNull();
    const button = within(screen.getByTestId('ai-entry')).getByRole('button', { name: '複製回覆' });
    await act(async () => {
      fireEvent.click(button);
    });
    expect(writeText).toHaveBeenCalledWith(REPLY);
    expect(toastSpy).toHaveBeenCalledWith('已複製回覆');
    expect(button.querySelector('.lucide-check')).not.toBeNull();
  });

  it('沒有正文的那則（只呼叫工具前吐的空白）不畫', () => {
    show([
      running(),
      start('a'),
      say('a', '\n\n'),
      finish('a'),
      start('b'),
      say('b', '好'),
      finish('b'),
    ]);
    expect(screen.getAllByRole('button', { name: '複製回覆' })).toHaveLength(1);
  });

  it('寫不進剪貼簿就講一聲，請人手動選取', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    show([running(), start('a'), say('a', '好'), finish('a')]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '複製回覆' }));
    });
    expect(toastSpy).not.toHaveBeenCalled();
    expect(toastSpy.error).toHaveBeenCalledWith('沒辦法複製回覆', {
      description: '瀏覽器不讓這個頁面寫剪貼簿，請手動選取文字。',
    });
  });
});

describe('複製程式碼', () => {
  it('講完的 fence 有按鈕，複製的是區塊內的原始碼、不含圍欄與語言', async () => {
    render(<MarkdownText text={'看這段：\n\n```ts {1}\nconst a = 1;\nconst b = 2;\n```'} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '複製程式碼' }));
    });
    expect(writeText).toHaveBeenCalledWith('const a = 1;\nconst b = 2;');
    expect(toastSpy).toHaveBeenCalledWith('已複製程式碼');
  });

  it('沒有語言的 fence 也有', () => {
    render(<MarkdownText text={'```\nls -la\n```'} />);
    expect(screen.getByRole('button', { name: '複製程式碼' })).not.toBeNull();
  });

  it('串流中沒有按鈕', () => {
    render(<MarkdownText text={'```ts\nconst a = 1;\n```\n\n還在'} streaming />);
    expect(screen.queryByRole('button', { name: '複製程式碼' })).toBeNull();
  });

  it('工具卡參數那種沒帶 copyable 的區塊不畫', () => {
    render(<CodeBlock code={'{"a":1}'} lang="json" streaming={false} />);
    expect(screen.queryByRole('button', { name: '複製程式碼' })).toBeNull();
  });
});

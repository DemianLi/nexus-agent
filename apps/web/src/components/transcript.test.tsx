import type { Event } from '@nexus/wire';
import { appendHumanTurn, emptyConversation, reduceAll } from '@nexus/wire';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Transcript } from '@/components/transcript';

/**
 * 正文空的回覆畫不畫（[#527](https://github.com/DemianLi/nexus-agent/issues/527)）。只想、只呼叫工具的那幾步
 * 會留下一則 `text: ''` 的 AI entry；#562 之後重新整理也會有。狀態從真的 frame 用 `reduceAll` 折出來。
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

function show(events: Event[]) {
  const state = reduceAll(appendHumanTurn(emptyConversation(), '問'), events);
  render(<Transcript state={state} isFresh={() => false} />);
  return state;
}

describe('正文空的回覆', () => {
  it('只有推理、講完了的那一步不畫泡泡；有正文的那則照畫', () => {
    const state = show([
      running(),
      start('a'),
      delta('a', { type: 'reasoning-delta', reasoning: '先想一下' }),
      finish('a'),
      start('b'),
      delta('b', { type: 'text-delta', text: '好了' }),
      finish('b'),
    ]);
    // 前提：折疊器真的長出了那一則空的，而且帶著推理。
    expect(state.entries).toMatchObject([
      { kind: 'human' },
      { kind: 'ai', text: '', reasoning: '先想一下', streaming: false },
      { kind: 'ai', text: '好了' },
    ]);
    const bubbles = screen.getAllByTestId('ai-entry');
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]?.textContent).toContain('好了');
  });

  it('還在吐字的空回覆照畫：那時有游標在閃', () => {
    show([running(), start('a'), delta('a', { type: 'reasoning-delta', reasoning: '想' })]);
    expect(screen.queryAllByTestId('ai-entry')).toHaveLength(1);
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

  it('出錯的空回覆照畫錯誤', () => {
    show([
      running(),
      start('a'),
      frame('messages', ROOT, { event: 'error', message: '供應商回 503', run_id: 'a' }),
    ]);
    expect(screen.getByTestId('ai-entry').textContent).toContain('供應商回 503');
  });
});

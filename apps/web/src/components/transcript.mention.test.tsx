import type { Event } from '@nexus/wire';
import { emptyConversation, INBOX, reduceAll } from '@nexus/wire';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Transcript } from '@/components/transcript';
import { axeViolations } from '@/test/axe';

afterEach(cleanup);

const ROOT = ['model_request:1'];
const MENTION = { kind: 'subagent', name: 'general-purpose' };

const inbox = (payload: unknown): Event =>
  ({
    type: 'event',
    event_id: 't:inbox',
    method: 'custom',
    params: { namespace: [], timestamp: 0, data: { name: INBOX, payload } },
  }) as Event;

let seq = 100;
const frame = (data: unknown): Event => {
  const current = seq++;
  return {
    type: 'event',
    seq: current,
    event_id: `t:${current}`,
    method: 'messages',
    params: { namespace: ROOT, timestamp: 0, data },
  } as Event;
};

function show(events: Event[]) {
  return render(
    <Transcript state={reduceAll(emptyConversation(), events)} isFresh={() => false} />,
  );
}

describe('人的泡泡畫「委派給 <name>」（#328 第 2 項）', () => {
  it('即時的人話：chip 在泡泡上方，字不含點名字樣，照原文畫', () => {
    show([inbox({ items: [], claimed: { id: 'q', text: '整理一下 README', mention: MENTION } })]);
    const chip = screen.getByTestId('delegated-chip');
    expect(chip.textContent).toBe('委派給 general-purpose');
    const bubble = screen.getByText('整理一下 README');
    expect(bubble.textContent).not.toContain('@');
    // chip 排在泡泡前面（上方）。
    expect(chip.compareDocumentPosition(bubble) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('歷史重播的人話（重新整理後、冷載入）：chip 還在', () => {
    show([
      frame({ event: 'message-start', role: 'human', id: 'h1', run_id: 'r1', mention: MENTION }),
      frame({
        event: 'content-block-delta',
        index: 0,
        run_id: 'r1',
        delta: { type: 'text-delta', text: '寫測試' },
      }),
    ]);
    expect(screen.getByTestId('delegated-chip').textContent).toBe('委派給 general-purpose');
    expect(screen.getByText('寫測試')).toBeTruthy();
  });

  it('沒點名：沒有 chip', () => {
    show([inbox({ items: [], claimed: { id: 'q', text: '一般的話' } })]);
    expect(screen.queryByTestId('delegated-chip')).toBeNull();
  });

  it('點名壞掉（kind 不對、沒名字）：當沒有，人話照畫', () => {
    show([
      inbox({
        items: [],
        claimed: { id: 'q', text: '壞點名', mention: { kind: 'file', name: 'x' } },
      }),
    ]);
    expect(screen.queryByTestId('delegated-chip')).toBeNull();
    expect(screen.getByText('壞點名')).toBeTruthy();
  });

  it('只有點名、沒有字：chip 還在，不畫空泡泡', () => {
    show([inbox({ items: [], claimed: { id: 'q', text: '', mention: MENTION } })]);
    expect(screen.getByTestId('delegated-chip')).toBeTruthy();
  });

  it('沒有 axe 違規', async () => {
    const { container } = show([
      inbox({ items: [], claimed: { id: 'q', text: '整理一下', mention: MENTION } }),
    ]);
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe('排著的插話畫 chip', () => {
  const nextStep = (text: string, mention?: unknown): Event =>
    inbox({
      items: [],
      nextStep: [
        { id: 's', text, source: { kind: 'user' }, ...(mention === undefined ? {} : { mention }) },
      ],
    });

  it('還沒被領走：淡一階的泡泡上方就有 chip，領走前不要等', () => {
    show([nextStep('改派它', MENTION)]);
    const bubble = document.querySelector('[data-pending-steer]') as HTMLElement;
    expect(within(bubble).getByTestId('delegated-chip').textContent).toBe('委派給 general-purpose');
    expect(bubble.textContent).toContain('改派它');
  });

  it('沒點名的插話：沒有 chip', () => {
    show([nextStep('普通插話')]);
    const bubble = document.querySelector('[data-pending-steer]') as HTMLElement;
    expect(within(bubble).queryByTestId('delegated-chip')).toBeNull();
  });
});

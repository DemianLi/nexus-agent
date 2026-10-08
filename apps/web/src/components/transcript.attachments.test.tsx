import type { Event } from '@nexus/wire';
import { emptyConversation, INBOX, reduceAll } from '@nexus/wire';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Transcript } from '@/components/transcript';
import { axeViolations } from '@/test/axe';

afterEach(cleanup);

const ROOT = ['model_request:1'];

const attachments = [
  {
    type: 'image',
    attachmentId: 'sha256:img',
    mediaType: 'image/png',
    bytes: 221,
    width: 96,
    height: 96,
    name: 'red.png',
  },
  { type: 'file', attachmentId: 'sha256:file', name: 'note.txt', bytes: 55 },
];

/** 伺服器領走開跑時推的 `inbox`（`claimed`），帶著這一句的附件參照。 */
const claimed = (text: string, withAttachments: readonly unknown[] | undefined): Event =>
  ({
    type: 'event',
    event_id: 't:claimed',
    method: 'custom',
    params: {
      namespace: [],
      timestamp: 0,
      data: {
        name: INBOX,
        payload: {
          items: [],
          claimed: {
            id: 'q',
            text,
            ...(withAttachments === undefined ? {} : { attachments: withAttachments }),
          },
        },
      },
    },
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
  render(<Transcript state={reduceAll(emptyConversation(), events)} isFresh={() => false} />);
}

describe('人的泡泡畫這一句帶的附件（#732）', () => {
  it('即時的人話：附件標籤排在泡泡上方，圖與檔都是名字＋大小、不畫圖片', async () => {
    show([claimed('請看附件', attachments)]);
    const chips = screen.getAllByTestId('sent-attachment');
    expect(chips.map((chip) => chip.textContent)).toEqual([
      'red.png' + 'PNG · 221 B · 96×96',
      'note.txt' + 'TXT · 55 B',
    ]);
    expect(chips.map((chip) => chip.getAttribute('data-kind'))).toEqual(['image', 'file']);
    expect(document.querySelector('[data-testid=sent-attachments] img')).toBeNull();
    // 圖示分得出圖與檔。
    expect(chips[0]!.querySelector('svg')?.getAttribute('class')).toContain('lucide-image');
    expect(chips[1]!.querySelector('svg')?.getAttribute('class')).toContain('lucide-file-text');
    expect(screen.getByText('請看附件')).toBeTruthy();
    const group = screen.getByTestId('sent-attachments');
    const bubble = document.querySelector('[data-slot=bubble]')!;
    // 標籤在泡泡前面（上方）。
    expect(group.compareDocumentPosition(bubble) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('只有附件、沒有字的那一句：只畫標籤，不畫空泡泡', () => {
    show([claimed('', attachments)]);
    expect(screen.getAllByTestId('sent-attachment')).toHaveLength(2);
    expect(document.querySelector('[data-slot=bubble]')).toBeNull();
  });

  it('沒帶附件的人話：畫面與以前一樣，沒有附件那一排', () => {
    show([claimed('問', undefined)]);
    expect(screen.queryByTestId('sent-attachments')).toBeNull();
    expect(screen.getByText('問')).toBeTruthy();
  });

  it('歷史重播的人話（重新整理後）：同樣畫出附件標籤，文字照畫', () => {
    show([
      frame({
        event: 'message-start',
        role: 'human',
        id: 'h1',
        run_id: 'r1',
        attachments,
      }),
      frame({
        event: 'content-block-delta',
        index: 0,
        run_id: 'r1',
        delta: { type: 'text-delta', text: '之前問的' },
      }),
    ]);
    const group = screen.getByTestId('sent-attachments');
    expect(within(group).getAllByTestId('sent-attachment')).toHaveLength(2);
    expect(screen.getByText('之前問的')).toBeTruthy();
  });

  it('形狀壞的附件：歷史當沒有，人話照畫，不畫壞標籤', () => {
    show([
      frame({
        event: 'message-start',
        role: 'human',
        id: 'h1',
        run_id: 'r1',
        attachments: [{ type: 'file', attachmentId: 5 }],
      }),
    ]);
    expect(screen.queryByTestId('sent-attachments')).toBeNull();
  });
});

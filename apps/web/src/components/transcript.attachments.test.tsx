import type { Event } from '@nexus/wire';
import { emptyConversation, IMAGE_OFFLOAD, INBOX, reduceAll } from '@nexus/wire';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AttachmentImageContext,
  OMITTED_EXPLANATION,
  SentAttachments,
} from '@/components/sent-attachments';
import { Transcript } from '@/components/transcript';
import type { AttachmentImageSource } from '@/lib/attachment-image';
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

describe('已送出的圖畫縮圖（#733）', () => {
  const image = {
    type: 'image' as const,
    attachmentId: 'sha256:img',
    mediaType: 'image/png' as const,
    bytes: 221,
    width: 96,
    height: 96,
    name: 'red.png',
  };
  const file = { type: 'file' as const, attachmentId: 'sha256:file', name: 'note.txt', bytes: 55 };

  const mount = (read: AttachmentImageSource['read'] | undefined) =>
    render(
      <AttachmentImageContext.Provider value={read === undefined ? null : { read, dispose() {} }}>
        <SentAttachments attachments={[image, file]} />
      </AttachmentImageContext.Provider>,
    );

  it('讀回來換成縮圖，點縮圖開原圖；檔案不讀、仍是圖示標籤', async () => {
    const read = vi.fn(async () => 'blob:red');
    mount(read);
    const chips = screen.getAllByTestId('sent-attachment');
    await waitFor(() => expect(chips[0]!.getAttribute('data-thumbnail')).toBe('shown'));
    expect(chips[0]!.querySelector('img')?.getAttribute('src')).toBe('blob:red');
    expect(chips[0]!.textContent).toContain('red.png');
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith('sha256:img', 'image/png');
    expect(chips[1]!.getAttribute('data-thumbnail')).toBe('none');
    expect(chips[1]!.querySelector('img')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '看原圖：red.png' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'red.png' }).getAttribute('src')).toBe('blob:red');
  });

  it('讀不到：留著標籤（圖示、名字、大小），不畫壞圖', async () => {
    const read = vi.fn(async () => undefined);
    mount(read);
    await waitFor(() => expect(read).toHaveBeenCalled());
    const chip = screen.getAllByTestId('sent-attachment')[0]!;
    expect(chip.getAttribute('data-thumbnail')).toBe('none');
    expect(chip.querySelector('img')).toBeNull();
    expect(chip.textContent).toContain('PNG · 221 B · 96×96');
  });

  it('沒有提供者：不讀、一律標籤', () => {
    mount(undefined);
    expect(screen.getAllByTestId('sent-attachment')[0]!.getAttribute('data-thumbnail')).toBe(
      'none',
    );
  });
  it('進到畫面才讀：還沒交會不讀，交會了才讀', async () => {
    const callbacks: ((entries: { isIntersecting: boolean }[]) => void)[] = [];
    const fire = (isIntersecting: boolean) => callbacks.forEach((cb) => cb([{ isIntersecting }]));
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
          callbacks.push(callback);
        }
        observe() {}
        disconnect() {}
      },
    );
    try {
      const read = vi.fn(async () => 'blob:red');
      mount(read);
      await act(async () => {});
      expect(read).not.toHaveBeenCalled();
      await act(async () => fire(false));
      expect(read).not.toHaveBeenCalled();
      await act(async () => fire(true));
      await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('排著的插話畫附件（#710）', () => {
  const nextStep = (text: string): Event =>
    ({
      type: 'event',
      event_id: 't:nextstep',
      method: 'custom',
      params: {
        namespace: [],
        timestamp: 0,
        data: {
          name: INBOX,
          payload: {
            items: [],
            nextStep: [{ id: 's', text, source: { kind: 'user' }, attachments }],
          },
        },
      },
    }) as Event;

  it('還沒被領走：附件標籤畫在淡一階的泡泡上方，底下一句仍是下一步送進模型', () => {
    show([nextStep('改看這張')]);
    const bubble = document.querySelector('[data-pending-steer]')!;
    const chips = within(bubble as HTMLElement).getAllByTestId('sent-attachment');
    expect(chips.map((chip) => chip.textContent)).toEqual([
      'red.png' + 'PNG · 221 B · 96×96',
      'note.txt' + 'TXT · 55 B',
    ]);
    expect(bubble.textContent).toContain('改看這張');
    expect(bubble.textContent).toContain('插話・');
  });

  it('只有附件、沒有字：不畫空泡泡，標籤與說明還在', () => {
    show([nextStep('')]);
    const bubble = document.querySelector('[data-pending-steer]')!;
    expect(within(bubble as HTMLElement).getAllByTestId('sent-attachment')).toHaveLength(2);
    expect(bubble.querySelector('[data-slot="bubble"]')).toBeNull();
  });
});

describe('模型已看不到的附件（#1270）', () => {
  /** server 每記一筆 `image/offload` 推的 frame：即時的條目靠 `inboxId` 認、歷史的靠 `seq`。 */
  const offload = (items: readonly unknown[]): Event =>
    ({
      type: 'event',
      event_id: `t:offload:${String(seq++)}`,
      method: 'custom',
      params: { namespace: [], timestamp: 0, data: { name: IMAGE_OFFLOAD, payload: { items } } },
    }) as Event;

  const omittedFlags = () =>
    screen.getAllByTestId('sent-attachment').map((chip) => chip.getAttribute('data-omitted'));

  it('即時：frame 到了，那一件標「模型已看不到」，其它件不標；檔案的位置也算一格', async () => {
    show([claimed('請看附件', attachments), offload([{ seq: 1, inboxId: 'q', positions: [0] }])]);
    expect(omittedFlags()).toEqual(['true', 'false']);
    const notes = screen.getAllByTestId('sent-attachment-omitted');
    expect(notes).toHaveLength(1);
    expect(notes[0]!.textContent).toBe('模型已看不到');
    expect(screen.getAllByTestId('sent-attachment')[0]!.contains(notes[0]!)).toBe(true);
    // 名字與大小照畫：標記是加上去的，不是取代。
    expect(screen.getAllByTestId('sent-attachment')[0]!.textContent).toContain(
      'PNG · 221 B · 96×96',
    );
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('沒有 frame：一件都不標', () => {
    show([claimed('請看附件', attachments)]);
    expect(omittedFlags()).toEqual(['false', 'false']);
    expect(screen.queryByTestId('sent-attachment-omitted')).toBeNull();
  });

  it('冷載入（重新整理後）：歷史的人話帶著 omittedAttachments，標記還在', () => {
    show([
      frame({
        event: 'message-start',
        role: 'human',
        id: 'h1',
        run_id: 'r1',
        attachments,
        omittedAttachments: [0],
      }),
    ]);
    expect(omittedFlags()).toEqual(['true', 'false']);
  });

  it('點開那一行：說明為什麼模型看不到、圖本身還在；不是警示色', () => {
    show([claimed('請看附件', attachments), offload([{ seq: 1, inboxId: 'q', positions: [0] }])]);
    const note = screen.getByRole('button', { name: '模型已看不到：red.png，點開看原因' });
    expect(note.className).not.toMatch(/destructive|warning/);
    fireEvent.click(note);
    expect(screen.getByText(OMITTED_EXPLANATION)).toBeTruthy();
  });

  it('被省略的圖照樣讀縮圖、點得開原圖', async () => {
    const read = vi.fn(async () => 'blob:red');
    render(
      <AttachmentImageContext.Provider value={{ read, dispose() {} }}>
        <SentAttachments attachments={attachments as never} omitted={[0]} />
      </AttachmentImageContext.Provider>,
    );
    const chip = screen.getAllByTestId('sent-attachment')[0]!;
    await waitFor(() => expect(chip.getAttribute('data-thumbnail')).toBe('shown'));
    expect(read).toHaveBeenCalledWith('sha256:img', 'image/png');
    fireEvent.click(screen.getByRole('button', { name: '看原圖：red.png' }));
    expect(screen.getByRole('img', { name: 'red.png' }).getAttribute('src')).toBe('blob:red');
  });
});

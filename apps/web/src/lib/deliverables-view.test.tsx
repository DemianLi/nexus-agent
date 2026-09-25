import type { ConversationState, DeliverablesPresentedPayload, Event } from '@nexus/wire';
import {
  appendHumanTurn,
  DELIVERABLES_PRESENTED,
  emptyConversation,
  reduceAll,
  WORKSPACE_CHANGES,
} from '@nexus/wire';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Transcript } from '@/components/transcript';
import { createChangesStores } from '@/lib/changes-diff';
import { createDeliverableDownloader } from '@/lib/deliverable-download';
import { createDeliverableFileStore } from '@/lib/deliverable-file';
import { transcriptItems } from '@/lib/deliverables-view';
import { memoryStorage, WithRightSidebar } from '@/test/right-sidebar';

/**
 * 交付卡片歸到它那一輪的尾端（#441 第二刀）。狀態從真的 frame 用 `reduceAll` 折出來，折疊器怎麼放那一格在
 * `@nexus/wire` 的 `deliverables.test.ts`；這裡驗 web 怎麼切輪、畫在哪。
 */

beforeEach(() => {
  // 右側欄的版面記在 localStorage，每個測試換一份新的（見 changes-review.test.tsx）。
  vi.stubGlobal('localStorage', memoryStorage());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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
const completed = () => frame('lifecycle', [], { event: 'completed', graph_name: 'root' });

function reply(id: string, text: string): Event[] {
  return [
    frame('messages', ROOT, { event: 'message-start', id: `run-${id}`, run_id: id }),
    frame('messages', ROOT, {
      event: 'content-block-delta',
      index: 0,
      delta: { type: 'text-delta', text },
      run_id: id,
    }),
    frame('messages', ROOT, { event: 'message-finish', reason: 'stop', run_id: id }),
  ];
}

function present(callId: string, paths: readonly string[]): Event[] {
  const namespace = [`tools:${callId}`];
  return [
    frame('tools', namespace, {
      event: 'tool-started',
      tool_call_id: callId,
      tool_name: 'present',
      input: JSON.stringify({ files: paths.map((path) => ({ path })) }),
    }),
    frame('tools', namespace, {
      event: 'tool-finished',
      tool_call_id: callId,
      tool_name: 'present',
      output: paths.map((path) => `Presented ${path}`).join('\n'),
    }),
  ];
}

/**
 * **`seq` 由這裡補，呼叫點不寫**（[#452](https://github.com/DemianLi/nexus-agent/issues/452)）：這幾條測
 * 的是交付卡怎麼歸位，跟讀檔路由的座標無關。但折疊器要求酬載帶得出座標（缺了就整顆略過），所以
 * 要有一個。去重的鍵是 `callId` 不是 `seq`，同一個值餵給每一條是安全的。
 */
function delivered(payload: Omit<DeliverablesPresentedPayload, 'seq'>, seq = 0): Event {
  return frame('custom', [], { name: DELIVERABLES_PRESENTED, payload: { ...payload, seq } });
}

/** 一輪：frame 照線上的順序取 seq，所以本體要在 `running` 之後才建（先建的 seq 比較小，會被當成重複丟掉）。 */
function turn(text: string, events: () => Event[], from = emptyConversation()): ConversationState {
  const start = running();
  const body = events();
  return reduceAll(appendHumanTurn(from, text), [start, ...body, completed()]);
}

/** 每一格的種類；交付卡寫成 `卡:路徑,路徑`，改動卡寫成 `改:seq`。 */
function layout(state: ConversationState): string[] {
  return transcriptItems(state.entries).map((item) =>
    item.kind === 'deliverables'
      ? `卡:${item.files.map((file) => file.path).join(',')}`
      : item.kind === 'changes'
        ? `改:${item.seq}`
        : item.entry.kind,
  );
}

describe('交付卡片歸到輪尾', () => {
  it('夾在工具卡與最後那段話之間的交付，畫在這一輪最後一格之後', () => {
    const state = turn('交付。', () => [
      ...present('c1', ['a.md']),
      delivered({ callId: 'c1', files: [{ path: 'a.md', description: '報告' }] }),
      ...reply('r1', '好了。'),
    ]);
    expect(state.entries.map((entry) => entry.kind)).toEqual([
      'human',
      'tool',
      'deliverables',
      'ai',
    ]);
    expect(layout(state)).toEqual(['human', 'tool', 'ai', '卡:a.md']);
  });

  it('同一輪兩次 present 收攏成一張，順序照宣告；卡的 id 是第一顆交付那一格的', () => {
    const state = turn('兩次。', () => [
      ...present('c1', ['a.md']),
      delivered({ callId: 'c1', files: [{ path: 'a.md' }] }),
      ...present('c2', ['b.md', 'c.md']),
      delivered({ callId: 'c2', files: [{ path: 'b.md' }, { path: 'c.md' }] }),
      ...reply('r1', '好了。'),
    ]);
    expect(layout(state)).toEqual(['human', 'tool', 'tool', 'ai', '卡:a.md,b.md,c.md']);
    expect(transcriptItems(state.entries).at(-1)?.id).toBe('deliverables:c1');
  });

  it('合併成一張卡之後，每個檔案仍然帶著自己那顆事件的座標（#452）', () => {
    const state = turn('兩次。', () => [
      ...present('c1', ['a.md']),
      delivered({ callId: 'c1', files: [{ path: 'a.md' }] }, 11),
      ...present('c2', ['b.md', 'c.md']),
      delivered({ callId: 'c2', files: [{ path: 'b.md' }, { path: 'c.md' }] }, 22),
      ...reply('r1', '好了。'),
    ]);
    const card = transcriptItems(state.entries).at(-1);
    expect(card?.kind).toBe('deliverables');
    // **`b.md` 的 `index` 是 0 不是 1**：它是第二顆事件宣告的第一個檔。合併弄丟的就是這個——卡裡的
    // 位置是 1，而讀檔路由要的是 0。`c.md` 同理跟著 `seq: 22` 走。
    expect(card?.kind === 'deliverables' ? card.files : []).toEqual([
      { path: 'a.md', seq: 11, index: 0 },
      { path: 'b.md', seq: 22, index: 0 },
      { path: 'c.md', seq: 22, index: 1 },
    ]);
  });

  it('只有工具、沒有文字的輪（沒有輪尾）照樣有卡，而且不跑到下一輪', () => {
    const first = turn('只交付。', () => [
      ...present('c1', ['a.md']),
      delivered({ callId: 'c1', files: [{ path: 'a.md' }] }),
    ]);
    const second = turn('再來。', () => reply('r2', '嗯。'), first);
    expect(layout(second)).toEqual(['human', 'tool', '卡:a.md', 'human', 'ai']);
  });

  it('失敗的 present 沒有交付事件，就沒有卡', () => {
    const state = turn('交付。', () => [...present('c1', ['a.md']), ...reply('r1', '好了。')]);
    expect(layout(state)).toEqual(['human', 'tool', 'ai']);
  });

  it('畫在 Transcript 裡：卡跟在回覆後面，卡裡是那幾個檔', () => {
    const state = turn('交付。', () => [
      ...present('c1', ['out/report.pdf']),
      delivered({ callId: 'c1', files: [{ path: 'out/report.pdf', description: '季報' }] }),
      ...reply('r1', '好了。'),
    ]);
    render(<Transcript state={state} isFresh={() => false} />);
    const card = screen.getByRole('region', { name: '這一輪交付的檔案，共 1 個' });
    const reply1 = screen.getByTestId('ai-entry');
    expect(reply1.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(card).getByTestId('deliverable').textContent).toBe(
      'report.pdf季報out/report.pdf',
    );
  });

  it('兩個 store 有交到卡片手上（#452）——沒交到的話那兩顆鈕就不見了', () => {
    // **這條釘的是接線，不是卡片。** `Transcript` 到 `DeliverablesCard` 的那兩個 prop 拿掉任何一個，
    // 卡片仍然畫得出來（檔名、說明、複製路徑都不需要讀檔），畫面看起來正常而鈕默默消失。
    // 量過：拿掉 `download={deliverableDownload}`，這個檔以外一條都不紅。
    const state = turn('交付。', () => [
      ...present('c1', ['out/report.pdf']),
      delivered({ callId: 'c1', files: [{ path: 'out/report.pdf' }] }),
      ...reply('r1', '好了。'),
    ]);
    // 只畫鈕，不會發請求；真的發了就是這條測試問錯問題了。
    const doFetch = (() => {
      throw new Error('這條測試不該發請求');
    }) as unknown as typeof globalThis.fetch;
    const wiring = { threadId: 't1', baseUrl: '', fetch: doFetch };
    const download = createDeliverableDownloader(wiring);
    render(
      <WithRightSidebar
        sources={{
          deliverableFiles: createDeliverableFileStore(wiring),
          deliverableDownload: download,
        }}
      >
        <Transcript state={state} isFresh={() => false} deliverableDownload={download} />
      </WithRightSidebar>,
    );
    const card = screen.getByRole('region', { name: '這一輪交付的檔案，共 1 個' });
    expect(within(card).getByRole('button', { name: '預覽：out/report.pdf' })).toBeTruthy();
    expect(within(card).getByRole('button', { name: '下載：out/report.pdf' })).toBeTruthy();
  });

  it('改動卡（#443）也收到輪尾，排在交付卡前面；不跑到下一輪', () => {
    const first = turn('改檔。', () => [
      ...present('c1', ['a.md']),
      delivered({ callId: 'c1', files: [{ path: 'a.md' }] }),
      frame('custom', [], { name: WORKSPACE_CHANGES, payload: { seq: 42 } }),
      ...reply('r1', '好了。'),
    ]);
    const second = turn('再來。', () => reply('r2', '嗯。'), first);
    expect(first.entries.map((entry) => entry.kind)).toContain('workspace-changes');
    expect(layout(second)).toEqual(['human', 'tool', 'ai', '改:42', '卡:a.md', 'human', 'ai']);
  });

  it('畫在 Transcript 裡：改動卡在回覆之後、交付卡之前；摘要 404 時那一格是空的', async () => {
    const state = turn('改檔。', () => [
      ...present('c1', ['a.md']),
      delivered({ callId: 'c1', files: [{ path: 'a.md' }] }),
      frame('custom', [], { name: WORKSPACE_CHANGES, payload: { seq: 42 } }),
      ...reply('r1', '好了。'),
    ]);
    const summary = {
      files: [{ path: 'a.md', display: 'a.md', added: 3, deleted: 1 }],
      total: 1,
      added: 3,
      deleted: 1,
    };
    const found = createChangesStores({
      threadId: 't',
      baseUrl: '',
      fetch: (async () => new Response(JSON.stringify(summary))) as typeof fetch,
    });
    const view = render(<Transcript state={state} isFresh={() => false} changes={found} />);
    await act(async () => {});
    const regions = screen
      .getAllByRole('region')
      .map((region) => region.getAttribute('aria-label'))
      .filter((label) => label?.startsWith('這一輪'));
    expect(regions).toEqual(['這一輪改動的檔案，共 1 個', '這一輪交付的檔案，共 1 個']);
    const changesCard = screen.getByTestId('changes');
    expect(
      screen.getByTestId('ai-entry').compareDocumentPosition(changesCard) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    view.unmount();

    const gone = createChangesStores({
      threadId: 't',
      baseUrl: '',
      fetch: (async () =>
        new Response('Change summary unavailable.', { status: 404 })) as typeof fetch,
    });
    render(<Transcript state={state} isFresh={() => false} changes={gone} />);
    await act(async () => {});
    expect(screen.queryByTestId('changes')).toBeNull();
    // 空的那一格收起來、不佔列表的間距（`empty:hidden`）。
    const slot = document.querySelector('[data-slot="message-scroller-item"]:empty');
    expect(slot?.className).toContain('empty:hidden');
  });
});

import type { ConversationEntry } from '@nexus/wire';
import { cleanup, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  FORK_SOURCE_FALLBACK,
  LEGACY_REPLAY_TEXT,
  ReplayEndDivider,
  replayEndIndex,
  useReplayedIds,
} from '@/features/transcript/replay-end';
import type { GroupedItem } from '@/features/transcript/tool-runs';

afterEach(cleanup);

const entry = (id: string): ConversationEntry =>
  ({ kind: 'user', id, text: id }) as unknown as ConversationEntry;
const item = (id: string): GroupedItem => ({ kind: 'entry', id, entry: entry(id) });
const run = (id: string, ids: string[]): GroupedItem =>
  ({ kind: 'tool-run', id, entries: ids.map(entry) }) as unknown as GroupedItem;
const tail = (kind: 'changes' | 'deliverables', id: string): GroupedItem =>
  ({ kind, id }) as unknown as GroupedItem;

describe('replayEndIndex（#3054）', () => {
  it('畫在最後一格帶重播條目的訊息之後', () => {
    const grouped = [item('a'), item('b'), item('c')];
    expect(replayEndIndex(grouped, new Set(['a', 'b']))).toBe(1);
  });

  it('邊界在工具段裡：用工具段那一格', () => {
    const grouped = [item('a'), run('run-1', ['t1', 't2']), item('c')];
    expect(replayEndIndex(grouped, new Set(['a', 't2']))).toBe(1);
  });

  it('同一輪尾端的改動卡、交付卡跳過去，線畫在它們下面', () => {
    const grouped = [
      item('a'),
      item('b'),
      tail('changes', 'changes-1'),
      tail('deliverables', 'deliverables-1'),
      item('c'),
    ];
    expect(replayEndIndex(grouped, new Set(['a', 'b']))).toBe(3);
  });

  it('往前翻接在前面的不在重播那一份裡：不影響線的位置', () => {
    const grouped = [item('earlier'), item('a'), item('b'), item('c')];
    expect(replayEndIndex(grouped, new Set(['a', 'b']))).toBe(2);
  });

  it('沒有重播的條目（空的對話）就不畫', () => {
    expect(replayEndIndex([item('c')], new Set())).toBeUndefined();
  });
});

describe('useReplayedIds', () => {
  it('第一頁歷史到之前是 undefined；到了只記那一刻的，之後長出來的不算', () => {
    const { result, rerender } = renderHook(
      ({ ready, entries }: { ready: boolean; entries: ConversationEntry[] }) =>
        useReplayedIds(ready, entries),
      { initialProps: { ready: false, entries: [] as ConversationEntry[] } },
    );
    expect(result.current).toBeUndefined();
    rerender({ ready: true, entries: [entry('a'), entry('b')] });
    expect([...(result.current ?? [])]).toEqual(['a', 'b']);
    rerender({ ready: true, entries: [entry('a'), entry('b'), entry('c')] });
    expect([...(result.current ?? [])]).toEqual(['a', 'b']);
  });
});

describe('ReplayEndDivider', () => {
  it('接續：知道時間就寫在線上，名稱是全句', () => {
    render(<ReplayEndDivider end={{ kind: 'resumed', lastActivity: '2026/11/19 23:40' }} />);
    const divider = screen.getByRole('separator', {
      name: '以上是之前的對話，最後一次是 2026/11/19 23:40',
    });
    expect(divider.textContent).toBe('2026/11/19 23:40');
  });

  it('接續：不知道時間就只畫線', () => {
    render(<ReplayEndDivider end={{ kind: 'resumed' }} />);
    expect(screen.getByRole('separator', { name: '以上是之前的對話' }).textContent).toBe('');
  });

  it('分叉：連結不在 separator 裡，按了切回來源；沒有標題時寫「原對話」', () => {
    const onOpenSource = vi.fn();
    render(<ReplayEndDivider end={{ kind: 'forked', onOpenSource }} />);
    expect(screen.queryByRole('separator')).toBeNull();
    screen.getByRole('button', { name: FORK_SOURCE_FALLBACK }).click();
    expect(onOpenSource).toHaveBeenCalledOnce();
    expect(screen.getByTestId('replay-end').textContent).toBe(`從${FORK_SOURCE_FALLBACK}分出`);
  });

  it('舊格式：線上寫模型不記得以上內容', () => {
    render(<ReplayEndDivider end={{ kind: 'legacy' }} />);
    expect(screen.getByRole('separator', { name: LEGACY_REPLAY_TEXT }).textContent).toBe(
      LEGACY_REPLAY_TEXT,
    );
  });
});

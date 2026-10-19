import type { Event } from '@nexus/wire';
import { emptyConversation, reduceAll } from '@nexus/wire';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { structuredPatch } from 'diff';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Transcript } from '@/components/transcript';
import { patchStats as vendorPatchStats } from '@/vendor/solid-glass/components/ui/diff-view';
import { Script } from '@/test/conversation-frames';

// 包一層計次，行為照原樣。
vi.mock('diff', async (importOriginal) => {
  const actual = await importOriginal<typeof import('diff')>();
  return { ...actual, structuredPatch: vi.fn(actual.structuredPatch) };
});
vi.mock('@/vendor/solid-glass/components/ui/diff-view', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/vendor/solid-glass/components/ui/diff-view')>();
  return { ...actual, patchStats: vi.fn(actual.patchStats) };
});

afterEach(cleanup);

/**
 * #1685 B：工具卡給 SG `step.patch` 之後，從對話流（`Transcript` → `ToolRun` → `ToolCard`）走一遍。
 * 兩顆寫檔收成一段，後面接一則還在吐字的回覆。
 */
function frames() {
  const script = new Script();
  const base: Event[] = [
    script.running(),
    ...script.human('h1', '寫兩份檔'),
    script.started('c1', 'write_file', { file_path: '/a.md', content: '一\n二\n三\n' }),
    script.finished('c1', 'ok'),
    script.started('c2', 'write_file', { file_path: '/b.md', content: '甲\n乙\n' }),
    script.finished('c2', 'ok'),
    script.openAi('rz'),
    script.delta('rz', '寫好'),
  ];
  const before = reduceAll(emptyConversation(), base);
  const after = reduceAll(before, [script.delta('rz', '了。')]);
  return { before, after };
}

const groupButton = () =>
  within(screen.getByTestId('tool-run')).getAllByRole('button', { expanded: false })[0]!;

describe('段與卡共用同一份 patch（#1685 B.6、B.7）', () => {
  it('段收著那一列的名稱含整段的合計；打開之後每張卡各自的行數', () => {
    render(<Transcript state={frames().before} isFresh={() => false} />);
    const group = groupButton();
    expect(group.textContent).toContain('+5');
    expect(within(group).getByText('新增 5 行，刪除 0 行')).toBeTruthy();
    fireEvent.click(group);
    expect(screen.getByRole('button', { name: /寫入檔案.*新增 3 行，刪除 0 行/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /寫入檔案.*新增 2 行，刪除 0 行/ })).toBeTruthy();
  });

  /**
   * 卡（`toStep`）與段（`ToolRun` 的 steps）都向 `toolDiffView` 要 patch，那一則只算一次：字串在 JS 裡依值比較，
   * `Object.is` 分不出是不是同一個實例，所以數 diff 算了幾次。拿掉 `toolDiffView` 的 WeakMap 這條會紅。
   */
  it('段與卡都畫出來時，每一則的 diff 只算一次', () => {
    vi.mocked(structuredPatch).mockClear();
    render(<Transcript state={frames().before} isFresh={() => false} />);
    fireEvent.click(groupButton());
    expect(screen.getAllByTestId('tool-entry')).toHaveLength(2);
    expect(vi.mocked(structuredPatch)).toHaveBeenCalledTimes(2);
  });
});

/**
 * 串流中 `entries` 每一格都換，段（`ToolRun`）跟著重畫，vendor 的 `StepGroup` 每次都對每一顆 `step.patch` 叫 `patchStats`
 * 算合計。nexus 層的快取擋在前面，vendor 那支不再被叫（#1685 B.8）；拿掉快取這條會紅。
 */
describe('串流中段的合計不跟著每一格重算', () => {
  it('寫檔那兩則沒變、只有回覆在吐字：vendor 的 patchStats 不再被叫', () => {
    const { before, after } = frames();
    const tools = (state: typeof before) => state.entries.filter((e) => e.kind === 'tool');
    expect(after.entries).not.toBe(before.entries);
    expect(tools(after)).toEqual(tools(before));
    tools(after).forEach((entry, at) => expect(entry).toBe(tools(before)[at]));

    const { rerender } = render(<Transcript state={before} isFresh={() => false} />);
    fireEvent.click(groupButton());
    const calls = vi.mocked(vendorPatchStats).mock.calls.length;
    rerender(<Transcript state={after} isFresh={() => false} />);
    expect(screen.getByText(/寫好了。/)).toBeTruthy();
    expect(vi.mocked(vendorPatchStats).mock.calls.length).toBe(calls);
  });
});

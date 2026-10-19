import type { Event } from '@nexus/wire';
import { emptyConversation, reduceAll } from '@nexus/wire';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Transcript } from '@/components/transcript';
import { toolDiffView } from '@/lib/tool-diff';
import { Script } from '@/test/conversation-frames';

// 包一層計次，行為照原樣。
vi.mock('@/lib/tool-diff', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tool-diff')>();
  return { ...actual, toolDiffView: vi.fn(actual.toolDiffView) };
});

afterEach(cleanup);

/**
 * 串流中 `entries` 每一格都換，寫檔卡那一則本身沒變：diff（`structuredPatch`）不該跟著每格重算（#1682 審查擋點 1，#625 的理由）。
 * 名字表每格新建一個 `Map` 的話，卡的 `useMemo` deps 每格都變，這條就紅。
 */
describe('串流中工具卡的推導不跟著每一格重算', () => {
  it('寫檔卡那一則沒變、只有回覆在吐字：toolDiffView 不再被叫', () => {
    const script = new Script();
    const base: Event[] = [
      script.running(),
      ...script.human('h1', '寫一份報告'),
      script.started('c1', 'write_file', {
        file_path: '/report.md',
        content: '# 報告\n\n第一段\n',
      }),
      script.finished('c1', 'ok'),
      script.openAi('rz'),
      script.delta('rz', '寫好'),
    ];
    const before = reduceAll(emptyConversation(), base);
    const after = reduceAll(before, [script.delta('rz', '了。')]);
    // 前提：entries 換了，寫檔那一則沒換。
    const write = (state: typeof before) =>
      state.entries.find((e) => e.kind === 'tool' && e.name === 'write_file');
    expect(after.entries).not.toBe(before.entries);
    expect(write(after)).toBe(write(before));

    const { rerender } = render(<Transcript state={before} isFresh={() => false} />);
    const calls = vi.mocked(toolDiffView).mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    rerender(<Transcript state={after} isFresh={() => false} />);
    expect(vi.mocked(toolDiffView).mock.calls.length).toBe(calls);
  });
});

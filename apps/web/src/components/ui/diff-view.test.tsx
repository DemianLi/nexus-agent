import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  capPatch,
  DiffStats,
  DiffView,
  PATCH_STATS_CACHE_SIZE,
  patchStats,
} from '@/components/ui/diff-view';
import { CARD_LINE_MAX_CHARS, CARD_MAX_CHARS } from '@/lib/card-limit';
import { MAX_RENDERED_LINES } from '@/lib/diff-rows';
import { patchStats as vendorPatchStats } from '@/vendor/solid-glass/components/ui/diff-view';

// 包一層計次，行為照原樣。
vi.mock('@/vendor/solid-glass/components/ui/diff-view', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/vendor/solid-glass/components/ui/diff-view')>();
  return { ...actual, patchStats: vi.fn(actual.patchStats) };
});

afterEach(cleanup);

/**
 * nexus 層的 `DiffStats`（#1685 PR A，README 本地修改第 76 條）：看得見的是 vendor 那顆「+N −M」，報讀器唸的是 sr-only 那一段。
 * 兩色（第 75 條）是覆寫檔的事，jsdom 不算樣式，交給 `guard/`。
 */
describe('DiffStats 的 nexus 層（第 76 條）', () => {
  test('看得見的「+12 −3」藏起來，報讀只唸一次「新增 12 行，刪除 3 行」', () => {
    render(
      <button type="button">
        改了一個檔
        <DiffStats added={12} removed={3} />
      </button>,
    );
    const button = screen.getByRole('button', { name: '改了一個檔新增 12 行，刪除 3 行' });
    const visible = button.querySelector('[data-slot="diff-stats"]')!;
    expect(visible.textContent).toBe('+12 −3');
    expect(visible.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  test('數字照 SG 不分位：1234 畫成 +1234，報讀也是 1234', () => {
    const { container } = render(<DiffStats added={1234} removed={0} />);
    expect(container.querySelector('[data-slot="diff-stats"]')!.textContent).toBe('+1234 −0');
    expect(screen.getByText('新增 1234 行，刪除 0 行').className).toBe('sr-only');
  });

  test('外層帶 shrink-0（在 flex 列裡不被擠），className 接在外層', () => {
    const { container } = render(<DiffStats added={1} removed={2} className="ml-auto" />);
    expect((container.firstElementChild as HTMLElement).className).toBe('shrink-0 ml-auto');
  });
});

/**
 * nexus 層的 `DiffView` 與 `patchStats`（#1685 PR B，README 本地修改第 77、78 條；patch 0024 是第 79 條）。
 * 卡片上的整條路徑（工具卡 → SG `StepRow` → 這一層）在 `tool/card.test.tsx` 的「畫面字元上限」那幾條。
 */
describe('DiffView 的 nexus 層：畫之前先截（第 77 條）', () => {
  test('沒撞到上限：原字串原樣交出去（同一個實例）', () => {
    const patch = 'diff --git a/x b/x\n@@\n-a\n+b';
    expect(capPatch(patch)).toBe(patch);
  });

  test(`超過 ${MAX_RENDERED_LINES} 行：畫前 ${MAX_RENDERED_LINES} 行，尾端一行講沒畫幾行；結尾那一個換行不算一行`, () => {
    const patch = `${Array.from({ length: MAX_RENDERED_LINES + 7 }, (_, i) => `+${i}`).join('\n')}\n`;
    const lines = capPatch(patch).split('\n');
    expect(lines).toHaveLength(MAX_RENDERED_LINES + 1);
    expect(lines.at(-1)).toBe('... 還有 7 行沒畫');
  });

  test('單行超過上限從中間截，頭那段留著前綴；其他行不動', () => {
    const long = `+${'字'.repeat(CARD_LINE_MAX_CHARS + 9)}`;
    const lines = capPatch(`@@\n${long}\n-a`).split('\n');
    expect(lines[0]).toBe('@@');
    expect(lines[1]).toMatch(/^\+字+⋯ 中間 10 字沒畫 ⋯字+$/);
    expect(lines[1]!.length).toBeLessThan(CARD_LINE_MAX_CHARS + 20);
    expect(lines[2]).toBe('-a');
  });

  test('交給 vendor 的是截過的，可以停焦點、名稱預設「改動內容」（patch 0024）', () => {
    // 每行 2,000 字、25 行：撞到整張卡的字元預算（DOM 小，不必畫 5,000 行）。
    const patch = Array.from({ length: 25 }, () => `+${'x'.repeat(CARD_LINE_MAX_CHARS - 1)}`).join(
      '\n',
    );
    render(<DiffView patch={patch} />);
    const view = screen.getByRole('generic', { name: '改動內容' });
    expect(view.tabIndex).toBe(0);
    expect(view.children).toHaveLength(CARD_MAX_CHARS / CARD_LINE_MAX_CHARS + 1);
    expect(view.lastElementChild!.textContent).toBe('... 還有 5 行沒畫');
  });
});

describe('patchStats 的 nexus 層：有界快取（第 78 條）', () => {
  const calls = () => vi.mocked(vendorPatchStats).mock.calls.length;

  test('結果同 vendor；同一份 patch 第二次不再叫 vendor', () => {
    const patch = `@@\n+${Math.random()}\n-x`;
    const before = calls();
    expect(patchStats(patch)).toEqual({ added: 1, removed: 1 });
    expect(patchStats(patch)).toEqual({ added: 1, removed: 1 });
    expect(calls()).toBe(before + 1);
  });

  test(`最多記 ${PATCH_STATS_CACHE_SIZE} 份，最久沒用的先丟`, () => {
    const seed = Math.random();
    const patches = Array.from(
      { length: PATCH_STATS_CACHE_SIZE + 1 },
      (_, i) => `@@\n+${seed}-${i}`,
    );
    for (const patch of patches) patchStats(patch);
    const before = calls();
    // 最近那份還在；最早那份被擠掉了，要再叫一次 vendor，結果照樣對。
    patchStats(patches.at(-1)!);
    expect(calls()).toBe(before);
    expect(patchStats(patches[0]!)).toEqual({ added: 1, removed: 0 });
    expect(calls()).toBe(before + 1);
  });
});

import type { WorkspaceChangesSummary, WorkspaceFileDiff } from '@nexus/wire';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChangesCard } from '@/components/changes-card';
import { createChangesStores } from '@/lib/changes-diff';
import { MAX_RENDERED_LINES } from '@/lib/diff-rows';
import { axeViolations } from '@/test/axe';
import { stubCmdkLayout } from '@/test/cmdk';

/** 審查頁（#443 web 第二刀）：點卡片的標頭或一列打開 Sheet，看那個檔在這一輪的比較。 */

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove('dark');
  vi.unstubAllGlobals();
});

const FILES = Array.from({ length: 5 }, (_, at) => ({
  path: `src/f${at}.ts`,
  display: `src/f${at}.ts`,
  added: at + 1,
  deleted: at,
}));

const SUMMARY: WorkspaceChangesSummary = { files: FILES, total: 5, added: 15, deleted: 10 };

function textDiff(overrides: Partial<Extract<WorkspaceFileDiff, { kind: 'text' }>> = {}) {
  return {
    kind: 'text',
    path: 'src/f0.ts',
    display: 'src/f0.ts',
    before: true,
    after: true,
    coarse: false,
    hunks: [
      {
        oldStart: 3,
        oldLines: 3,
        newStart: 3,
        newLines: 2,
        lines: [' keep', '-old one', '-old two', '+new one'],
      },
    ],
    ...overrides,
  } satisfies WorkspaceFileDiff;
}

type Reply = () => Response | Promise<Response>;

/** 摘要照給、比較照 index 給；記下每次比較打的 index。 */
async function renderCard(diffs: (index: number, attempt: number) => Response | Promise<Response>) {
  const asked: number[] = [];
  const fetch = vi.fn(async (url: string | URL | Request) => {
    const target = new URL(String(url));
    if (target.pathname.endsWith('/summary')) return new Response(JSON.stringify(SUMMARY));
    const index = Number(target.searchParams.get('index'));
    asked.push(index);
    return diffs(index, asked.filter((at) => at === index).length);
  }) as unknown as typeof globalThis.fetch;
  const changes = createChangesStores({ threadId: 't', baseUrl: 'http://h', fetch });
  render(<ChangesCard seq={7} changes={changes} />);
  await act(async () => {});
  return { asked };
}

const json =
  (body: unknown): Reply =>
  () =>
    new Response(JSON.stringify(body));

async function click(element: Element) {
  fireEvent.click(element);
  await act(async () => {});
}

const rows = () =>
  screen.getAllByTestId('changed-file').map((row) => within(row).getByRole('button'));

describe('打開審查頁', () => {
  it('點標頭：從第一個檔打開', async () => {
    const { asked } = await renderCard(() => json(textDiff())());
    await click(screen.getByRole('button', { name: /5 個檔案有改動/ }));
    const sheet = screen.getByRole('dialog', { name: '這一輪的改動' });
    expect(within(sheet).getByTestId('review-file').textContent).toBe('src/f0.ts');
    expect(asked).toEqual([0]);
  });

  it('點一列：打開那一列的檔；展開後的列用它在摘要裡的位置', async () => {
    const { asked } = await renderCard((index) =>
      json(textDiff({ path: `src/f${index}.ts`, display: `src/f${index}.ts` }))(),
    );
    await click(rows()[1]!);
    expect(screen.getByTestId('review-file').textContent).toBe('src/f1.ts');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await act(async () => {});
    expect(screen.queryByRole('dialog')).toBeNull();

    await click(screen.getByRole('button', { name: /顯示全部 5 個/ }));
    await click(rows()[4]!);
    expect(screen.getByTestId('review-file').textContent).toBe('src/f4.ts');
    expect(asked).toEqual([1, 4]);
  });

  it('選檔器換檔：讀那個檔的比較', async () => {
    stubCmdkLayout();
    const { asked } = await renderCard(() => json(textDiff())());
    await click(rows()[0]!);
    await click(screen.getByRole('button', { name: '選擇要看的檔案，現在是 src/f0.ts' }));
    await click(screen.getByRole('option', { name: /src\/f3\.ts/ }));
    expect(screen.getByTestId('review-file').textContent).toBe('src/f3.ts');
    expect(asked).toEqual([0, 3]);
  });
});

describe('比較', () => {
  it('單欄：兩側行號、+ 與 -；hunk 標頭', async () => {
    await renderCard(() => json(textDiff())());
    await click(rows()[0]!);
    const body = screen.getByTestId('review-body');
    expect(body.dataset.reviewView).toBe('unified');
    expect(body.textContent).toContain('@@ -3,3 +3,2 @@');
    const lines = [...body.querySelectorAll('[data-diff-line]')];
    expect(lines.map((line) => [line.getAttribute('data-diff-line'), line.textContent])).toEqual([
      ['context', '33 keep'],
      ['del', '4-old one'],
      ['del', '5-old two'],
      ['add', '4+new one'],
    ]);
  });

  it('左右對照：刪除與新增逐列配對；再按回單欄；換檔時選擇留著', async () => {
    await renderCard(() => json(textDiff())());
    await click(rows()[0]!);
    const split = screen.getByRole('button', { name: '左右對照' });
    await click(split);
    expect(split.getAttribute('aria-pressed')).toBe('true');
    const body = screen.getByTestId('review-body');
    expect(body.dataset.reviewView).toBe('split');
    // 不換行時兩欄各自捲動：左欄是舊的、右欄是新的。
    const left = body.querySelector('[data-diff-side="left"]')!;
    const right = body.querySelector('[data-diff-side="right"]')!;
    const texts = (side: Element) =>
      [...side.querySelectorAll('[data-diff-line]')].map((line) => line.textContent);
    expect(texts(left)).toEqual(['3keep', '4old one', '5old two']);
    expect(texts(right)).toEqual(['3keep', '4new one', '']);

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await act(async () => {});
    await click(rows()[1]!);
    expect(screen.getByRole('button', { name: '左右對照' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('自動換行：左右對照改成同一列兩格，一起長高', async () => {
    await renderCard(() => json(textDiff())());
    await click(rows()[0]!);
    await click(screen.getByRole('button', { name: '自動換行' }));
    await click(screen.getByRole('button', { name: '左右對照' }));
    const body = screen.getByTestId('review-body');
    expect(body.dataset.reviewWrap).toBe('true');
    expect(body.querySelector('[data-diff-side]')).toBeNull();
    expect([...body.querySelectorAll('[data-diff-line]')].map((line) => line.textContent)).toEqual([
      '3keep3keep',
      '4old one4new one',
      '5old two',
    ]);
  });

  it.each([
    ['新建', { before: false }, '這一輪新建的檔案'],
    ['刪掉', { after: false }, '這一輪刪掉的檔案'],
    ['兩側相同', { hunks: [] }, '兩側內容相同'],
    ['逾時', { coarse: true }, '逐行比較逾時，改成整檔替換顯示'],
  ])('%s：在 hunks 上面講一聲', async (_name, overrides, note) => {
    await renderCard(() => json(textDiff(overrides))());
    await click(rows()[0]!);
    expect(screen.getByTestId('review-body').textContent).toContain(note);
  });

  it(`超過 ${MAX_RENDERED_LINES} 行只畫前面那些，並講一聲`, async () => {
    const lines = Array.from({ length: MAX_RENDERED_LINES + 10 }, (_, at) => `+${at}`);
    const diff = textDiff({
      before: false,
      hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: lines.length, lines }],
    });
    await renderCard(() => json(diff)());
    await click(rows()[0]!);
    const body = screen.getByTestId('review-body');
    expect(body.textContent).toContain(`只顯示前 ${MAX_RENDERED_LINES} 行`);
    expect(body.querySelectorAll('[data-diff-line]')).toHaveLength(MAX_RENDERED_LINES);
  });
});

describe('讀不到的時候', () => {
  it.each([
    ['二進位', { kind: 'binary', path: 'a', display: 'a' }, '二進位檔，沒辦法顯示改動'],
    ['過大', { kind: 'oversized', path: 'a', display: 'a' }, '檔案過大，沒辦法顯示改動'],
  ])('%s：講為什麼不畫', async (_name, diff, text) => {
    await renderCard(() => json(diff)());
    await click(rows()[0]!);
    expect(screen.getByRole('dialog').textContent).toContain(text);
  });

  it('404：講讀不到了，沒有重試', async () => {
    await renderCard(() => new Response('gone', { status: 404 }));
    await click(rows()[0]!);
    const sheet = screen.getByRole('dialog');
    expect(sheet.textContent).toContain('這一輪的改動已經讀不到了');
    expect(within(sheet).queryByRole('button', { name: '重試' })).toBeNull();
  });

  it('讀壞了：按重試再讀一次，讀到就畫', async () => {
    const { asked } = await renderCard((_index, attempt) =>
      attempt === 1 ? new Response('boom', { status: 500 }) : json(textDiff())(),
    );
    await click(rows()[0]!);
    expect(screen.getByRole('dialog').textContent).toContain('沒辦法讀取改動');
    await click(screen.getByRole('button', { name: '重試' }));
    expect(screen.getByTestId('review-body').querySelectorAll('[data-diff-line]')).toHaveLength(4);
    expect(asked).toEqual([0, 0]);
  });

  it('還在讀：報讀器聽得到', async () => {
    await renderCard(() => new Promise<Response>(() => {}));
    await click(rows()[0]!);
    expect(within(screen.getByRole('dialog')).getByRole('status').textContent).toBe(
      '正在讀取改動…',
    );
  });
});

it('axe：審查頁亮與暗，單欄與左右對照', async () => {
  await renderCard(() => json(textDiff())());
  await click(rows()[0]!);
  expect(await axeViolations(document.body)).toEqual([]);
  await click(screen.getByRole('button', { name: '左右對照' }));
  document.documentElement.classList.add('dark');
  expect(await axeViolations(document.body)).toEqual([]);
});

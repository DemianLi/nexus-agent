import type { WorkspaceChangesSummary } from '@nexus/wire';
import { changesSummaryPath } from '@nexus/wire';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChangesCard, COLLAPSED_ROWS } from '@/components/changes-card';
import { createChangesSummaryStore, isChangesSummary } from '@/lib/changes-summary';
import { axeViolations } from '@/test/axe';

/** 改動卡（#443 web 第一刀）：摘要讀一次、404 不畫、一檔一列、超過三列收起。 */

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove('dark');
});

const SUMMARY: WorkspaceChangesSummary = {
  files: [
    { path: 'src/app.ts', display: 'src/app.ts', added: 1234, deleted: 5 },
    { path: 'logo.png', display: 'logo.png', added: 0, deleted: 0, binary: true },
  ],
  total: 2,
  added: 1234,
  deleted: 5,
};

function json(body: unknown, status = 200) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
}

/** 一個假的 fetch：記下每次打的網址，回給定的回應。 */
function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return respond();
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

async function renderCard(respond: () => Response | Promise<Response>, seq = 7) {
  const { fetch, calls } = fakeFetch(respond);
  const store = createChangesSummaryStore({ threadId: 't 1', baseUrl: 'http://h/', fetch });
  const view = render(<ChangesCard seq={seq} store={store} />);
  // 讓 fetch 與 json 的 promise 都走完。
  await act(async () => {});
  return { ...view, calls, store };
}

describe('改動摘要的讀取', () => {
  it('打 thread 底下的摘要路由，帶 seq 與 content-type（同 wire client）', async () => {
    const { calls } = await renderCard(() => json(SUMMARY));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`http://h${changesSummaryPath('t 1')}?seq=7`);
    expect(calls[0]!.init?.method).toBe('GET');
    expect(calls[0]!.init?.headers).toEqual({ 'content-type': 'application/json' });
  });

  it('同一個 seq 只讀一次：第二張卡直接用快取', async () => {
    const { calls, store } = await renderCard(() => json(SUMMARY));
    render(<ChangesCard seq={7} store={store} />);
    await act(async () => {});
    expect(calls).toHaveLength(1);
    expect(screen.getAllByTestId('changes')).toHaveLength(2);
  });

  it.each([
    ['404（serve 重開後重播的那一格）', () => json('Change summary unavailable.', 404)],
    ['500', () => json('boom', 500)],
    ['斷線', () => Promise.reject(new TypeError('network'))],
    ['形狀不對', () => json({ files: [{ path: 1 }], total: 1, added: 0, deleted: 0 })],
    ['沒有檔', () => json({ files: [], total: 0, added: 0, deleted: 0 })],
  ])('%s：不畫卡，也不重試', async (_name, respond) => {
    const { container, calls, store } = await renderCard(respond);
    expect(container.innerHTML).toBe('');
    render(<ChangesCard seq={7} store={store} />);
    await act(async () => {});
    expect(calls).toHaveLength(1);
  });

  it('形狀檢查認得出合法的摘要', () => {
    expect(isChangesSummary(SUMMARY)).toBe(true);
    expect(isChangesSummary(null)).toBe(false);
    expect(isChangesSummary({ ...SUMMARY, total: '2' })).toBe(false);
  });
});

describe('改動卡', () => {
  it('標頭是總檔數與總行數；一檔一列，二進位的不給行數', async () => {
    await renderCard(() => json(SUMMARY));
    const card = screen.getByRole('region', { name: '這一輪改動的檔案，共 2 個' });
    expect(card.textContent).toContain('2 個檔案有改動');
    expect(screen.getAllByTestId('changed-file').map((row) => row.textContent)).toEqual([
      'src/app.ts+1,234新增 1234 行，−5刪除 5 行',
      'logo.png二進位檔',
    ]);
  });

  it(`超過 ${COLLAPSED_ROWS} 列先收起；總數比列出的多時講一聲`, async () => {
    const files = Array.from({ length: 5 }, (_, i) => ({
      path: `f${i}`,
      display: `f${i}`,
      added: 1,
      deleted: 0,
    }));
    await renderCard(() => json({ files, total: 9, added: 9, deleted: 0 }));
    expect(screen.getAllByTestId('changed-file')).toHaveLength(COLLAPSED_ROWS);
    expect(screen.getByText('另有 4 個檔沒有列出')).toBeTruthy();
    const toggle = screen.getByRole('button', { name: /顯示全部 5 個/ });
    fireEvent.click(toggle);
    expect(screen.getAllByTestId('changed-file')).toHaveLength(5);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('axe：亮與暗', async () => {
    await renderCard(() => json(SUMMARY));
    expect(await axeViolations(document.body)).toEqual([]);
    document.documentElement.classList.add('dark');
    expect(await axeViolations(document.body)).toEqual([]);
  });
});

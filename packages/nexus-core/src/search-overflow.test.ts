/**
 * 搜尋結果筆數上限那一對（[#735](https://github.com/DemianLi/nexus-agent/issues/735)）的單位測試：middleware 開槽、
 * backend 包裝截前段。真組裝、真基座工具的驗收在 `apps/harness/src/search-overflow.test.ts`；這裡量的是那邊的
 * 檔案系統給不出來的形狀——backend 交出的順序跟路徑排序不同、同一次呼叫裡的第二次 backend 呼叫。
 */

import { ToolMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import {
  capSearchResults,
  createSearchOverflowMiddleware,
  previewLine,
  searchSeenOf,
} from './search-overflow.js';

interface Match {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

type Wrap = (
  request: { toolCall: { name: string; id: string; args: object } },
  handler: (request: unknown) => Promise<unknown>,
) => Promise<unknown>;

/** backend 替身：照給定的順序交出全部命中，`maxCount` 有給就照基座截前 N 筆並標 `truncated`。 */
function fakeBackend(matches: readonly Match[]) {
  const calls: (number | null)[] = [];
  return {
    calls,
    grep(_pattern: string, _path?: string, _glob?: string | null, maxCount?: number | null) {
      calls.push(maxCount ?? null);
      if (maxCount != null && matches.length > maxCount) {
        return Promise.resolve({ matches: matches.slice(0, maxCount), truncated: true });
      }
      return Promise.resolve({ matches: [...matches] });
    },
  };
}

/** 在 middleware 的槽裡跑 `body`（代替基座的工具本體），回 `body` 拿到的東西。 */
async function inSlot<T>(
  limit: number,
  body: () => Promise<T>,
  extra: { grepMaxLineBytes?: number } = {},
): Promise<T> {
  const middleware = createSearchOverflowMiddleware({
    limits: { grepMaxMatches: limit, globMaxResults: limit, ...extra },
  });
  const wrap = (middleware as unknown as { wrapToolCall: Wrap }).wrapToolCall;
  let seen: T | undefined;
  await wrap({ toolCall: { name: 'grep', id: 'call_1', args: { pattern: 'x' } } }, async () => {
    seen = await body();
    return new ToolMessage({ content: 'body', tool_call_id: 'call_1', name: 'grep' });
  });
  return seen as T;
}

const m = (path: string, line: number): Match => ({ path, line, text: `${path}#${line}` });

describe('backend 包裝', () => {
  it('backend 交出的順序跟路徑排序不同：先照路徑穩定排序再截，同一檔內保持原順序', async () => {
    // backend 先交 /b、再交 /a；/a 內刻意是 3、1、2。
    const backend = fakeBackend([m('/b', 1), m('/a', 3), m('/a', 1), m('/b', 2), m('/a', 2)]);
    const capped = capSearchResults(backend);
    const page = await inSlot(3, () => capped.grep('x') as Promise<{ matches: Match[] }>);
    expect(page.matches.map((match) => `${match.path}#${match.line}`)).toEqual([
      '/a#3',
      '/a#1',
      '/a#2',
    ]);
    expect(searchSeenOf(page)).toBe(5);
  });

  it('同一次呼叫裡的第二次 backend 呼叫（搜尋卡數總數那一次）原樣通過', async () => {
    const all = Array.from({ length: 10 }, (_, i) => m('/a', i + 1));
    const backend = fakeBackend(all);
    const capped = capSearchResults(backend);
    const [first, second] = await inSlot(3, async () => [
      (await capped.grep('x')) as { matches: Match[] },
      (await capped.grep('x', '/', null, null)) as { matches: Match[] },
    ]);
    expect(first.matches).toHaveLength(3);
    expect(second.matches).toHaveLength(10);
    expect(searchSeenOf(second)).toBeUndefined();
  });

  it('不在槽裡（摘要器、暫存、別的工具）：原樣通過', async () => {
    const backend = fakeBackend(Array.from({ length: 10 }, (_, i) => m('/a', i + 1)));
    const result = (await capSearchResults(backend).grep('x')) as { matches: Match[] };
    expect(result.matches).toHaveLength(10);
    expect(searchSeenOf(result)).toBeUndefined();
  });

  it('不把 truncated 交給基座：設了它，基座會接一句叫模型加大 max_count 的提醒', async () => {
    const backend = fakeBackend(Array.from({ length: 10 }, (_, i) => m('/a', i + 1)));
    const page = await inSlot(3, () => capSearchResults(backend).grep('x') as Promise<object>);
    expect('truncated' in page).toBe(false);
  });
});

describe('previewLine：切在 UTF-8 字元邊界上（#1605，dsh `previewLine`）', () => {
  it('沒超過上限原樣；剛好等於上限也原樣', () => {
    expect(previewLine('abc', 3)).toBe('abc');
    expect(previewLine('一二', 6)).toBe('一二');
    expect(previewLine('', 5)).toBe('');
  });

  it('超過就切、加後綴；上限算保留下來的文字，後綴不算', () => {
    expect(previewLine('abcdef', 4)).toBe('abcd (line truncated)');
  });

  it('切點落在中文字中間：退到前一個字元的邊界，保留下來的文字是合法 UTF-8', () => {
    // 「一」三個位元組：上限 4 只容得下一個字。
    for (const max of [3, 4, 5]) {
      const out = previewLine('一二三', max).replace(' (line truncated)', '');
      expect(out).toBe('一');
      expect(Buffer.byteLength(out)).toBeLessThanOrEqual(max);
      expect(out).not.toContain('\uFFFD');
    }
    expect(previewLine('一二三', 6)).toBe('一二 (line truncated)');
  });

  it('四位元組的字元（emoji）也不被切開', () => {
    const out = previewLine('a😀b', 3).replace(' (line truncated)', '');
    expect(out).toBe('a');
    expect(previewLine('a😀b', 5)).toBe('a😀 (line truncated)');
  });

  it('上限比一個字元還小：留空字串加後綴，不會拋', () => {
    expect(previewLine('一', 2)).toBe(' (line truncated)');
  });
});

describe('每行限長（grepMaxLineBytes）', () => {
  const long = (path: string, line: number): Match => ({ path, line, text: '一'.repeat(400) });

  it('給了上限：每一行切到上限內，沒超過的那些是同一個物件、不複製', async () => {
    const short = m('/a', 1);
    const backend = capSearchResults(fakeBackend([short, long('/a', 2)]));

    const result = await inSlot(
      10,
      () => (backend as ReturnType<typeof fakeBackend>).grep('x') as Promise<{ matches: Match[] }>,
      { grepMaxLineBytes: 100 },
    );

    expect(result.matches[0]).toBe(short);
    const text = result.matches[1]?.text ?? '';
    expect(text.endsWith(' (line truncated)')).toBe(true);
    expect(Buffer.byteLength(text.replace(' (line truncated)', ''))).toBeLessThanOrEqual(100);
  });

  it('沒給上限：一個位元組都不動（舊呼叫端、單元測試的形狀）', async () => {
    const backend = capSearchResults(fakeBackend([long('/a', 1)]));

    const result = await inSlot(
      10,
      () => (backend as ReturnType<typeof fakeBackend>).grep('x') as Promise<{ matches: Match[] }>,
    );

    expect(result.matches[0]?.text).toBe('一'.repeat(400));
  });

  it('超過筆數上限時，存檔的完整結果也是限過長的那一份', async () => {
    const saved: string[] = [];
    const middleware = createSearchOverflowMiddleware({
      limits: { grepMaxMatches: 1, globMaxResults: 1, grepMaxLineBytes: 30 },
      store: {
        saveText: (input: { content: string }) => {
          saved.push(input.content);
          return Promise.resolve({ locator: '/saved', retrievalHint: 'read it' });
        },
      } as never,
    });
    const wrap = (middleware as unknown as { wrapToolCall: Wrap }).wrapToolCall;
    const backend = capSearchResults(fakeBackend([long('/a', 1), long('/a', 2)])) as ReturnType<
      typeof fakeBackend
    >;

    await wrap({ toolCall: { name: 'grep', id: 'call_1', args: { pattern: 'x' } } }, async () => {
      await backend.grep('x');
      return new ToolMessage({ content: 'body', tool_call_id: 'call_1', name: 'grep' });
    });

    expect(saved).toHaveLength(1);
    expect(saved[0]).toContain('(line truncated)');
    expect(saved[0]).not.toContain('一'.repeat(400));
  });
});

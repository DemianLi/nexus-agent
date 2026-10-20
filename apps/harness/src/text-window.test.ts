/**
 * `scanWindow`／`pageOf`（[#1530](https://github.com/DemianLi/nexus-agent/issues/1530)）：新的逐 chunk 掃描要跟舊的算法
 * （基座整份讀進來、`readWithExtent` 切行與位元組）在**沒有行長截斷**時給出一模一樣的頁、範圍、總行數。
 *
 * 比對對象寫成純函式，照 develop `959e9af7` 的 `read-continuation.ts` 與基座 `FilesystemBackend.read` 的語意抄；
 * 輸入是隨機組出來的文字（各種換行位置、結尾有沒有換行、空行、`\r`、多位元組字元），並且**隨機切成 chunk**：
 * chunk 的邊界不能影響結果。
 */

import { describe, expect, it } from 'vitest';

import { pageOf, scanWindow } from './text-window.js';
import type { WindowParams } from './text-window.js';

/** 舊算法：基座 `read(path, offset, MAX)` 之後的 `readWithExtent`。 */
function reference(text: string, offset: number, limit: number, maxBytes: number) {
  if (!text || text.trim() === '') return { kind: 'blank' as const };
  const all = text.split('\n');
  if (offset >= all.length) return { kind: 'beyond' as const, splitLength: all.length };
  const rest = all.slice(offset);
  const remaining = rest.at(-1) === '' ? rest.length - 1 : rest.length;
  const wanted = Math.min(limit, remaining);
  let bytes = 0;
  let shown = 0;
  while (shown < wanted) {
    const cost = Buffer.byteLength(rest[shown] ?? '') + (shown > 0 ? 1 : 0);
    if (shown > 0 && bytes + cost > maxBytes) break;
    bytes += cost;
    shown += 1;
  }
  const capped = shown < wanted;
  return {
    kind: 'page' as const,
    content: rest.slice(0, capped ? shown : limit).join('\n'),
    extent: { offset, shown, total: offset + remaining, cappedByBytes: capped },
  };
}

/** 小的線性同餘亂數，固定種子：失敗時可重現。 */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const PIECES = ['a', 'bc', 'def', '', ' ', '\t', '\r', '你好', '🙂', 'x'.repeat(7)];

function randomText(next: () => number): string {
  const lineCount = Math.floor(next() * 12);
  const lines = Array.from({ length: lineCount }, () => {
    const parts = Math.floor(next() * 4);
    return Array.from({ length: parts }, () => PIECES[Math.floor(next() * PIECES.length)]!).join(
      '',
    );
  });
  const tail = next() < 0.5 ? '\n' : '';
  return lines.join('\n') + tail;
}

/** 把文字隨機切成幾片（含空片）；在 UTF-16 單位上切，所以代理對也可能被切開——掃描只認 `\n`，不受影響。 */
function randomChunks(text: string, next: () => number): string[] {
  const chunks: string[] = [];
  let at = 0;
  while (at < text.length) {
    const size = Math.floor(next() * 6);
    chunks.push(text.slice(at, at + size));
    at += size;
  }
  return chunks;
}

describe('scanWindow＋pageOf 對舊算法：隨機文字、隨機切片', () => {
  it('2000 組：頁、範圍、總行數、空與超出都一樣', async () => {
    const next = rng(1530);
    for (let round = 0; round < 2000; round += 1) {
      const text = randomText(next);
      const offset = Math.floor(next() * 8);
      const limit = 1 + Math.floor(next() * 8);
      const maxBytes = 24 + Math.floor(next() * 60);
      const params: WindowParams = { offset, limit, maxLineLength: Infinity, maxBytes };
      const scan = await scanWindow(randomChunks(text, next), params);
      const got = pageOf(scan, params);
      const want = reference(text, offset, limit, maxBytes);
      // 舊算法一行都塞不下時仍給第一行（偏離二）；dsh 的算法不給。每行最多 3 片、每片最多 7 位元組（21），maxBytes 下限 24，這個分歧碰不到。
      expect({ round, text, got }).toEqual({ round, text, got: want });
    }
  });

  it('不分片與逐字元分片結果相同', async () => {
    const text = 'one\r\ntwo\n\nthree 你好🙂\nlast';
    const params: WindowParams = { offset: 1, limit: 3, maxLineLength: Infinity, maxBytes: 1000 };
    const whole = pageOf(await scanWindow([text], params), params);
    const bytewise = pageOf(await scanWindow([...text], params), params);
    expect(bytewise).toEqual(whole);
  });
});

describe('scanWindow：行長與位元組上限（dsh buildWindow）', () => {
  const params = (overrides: Partial<WindowParams> = {}): WindowParams => ({
    offset: 0,
    limit: 2000,
    maxLineLength: 2000,
    maxBytes: 50 * 1024,
    ...overrides,
  });

  it('超過 2000 字元的行截到 2000 接後綴；剛好 2000 不截', async () => {
    const scan = await scanWindow([`${'x'.repeat(2000)}\n${'y'.repeat(2001)}\n`], params());
    expect(scan.lines).toEqual([
      'x'.repeat(2000),
      `${'y'.repeat(2000)}... (line truncated to 2000 chars)`,
    ]);
  });

  it('沒有換行的巨行：緩衝只留 maxLineLength + 1，行還是只算一行', async () => {
    const chunks = Array.from({ length: 500 }, () => 'z'.repeat(10_000));
    const scan = await scanWindow(chunks, params());
    expect(scan.totalLines).toBe(1);
    expect(scan.lines).toHaveLength(1);
    expect(scan.lines[0]).toBe(`${'z'.repeat(2000)}... (line truncated to 2000 chars)`);
  });

  it('位元組上限：停止收集，但照樣數到檔尾', async () => {
    const lines = Array.from({ length: 100 }, (_, index) => `line ${index}`);
    const scan = await scanWindow([`${lines.join('\n')}\n`], params({ maxBytes: 30 }));
    expect(scan.cappedByBytes).toBe(true);
    expect(scan.lines.length).toBeLessThan(10);
    expect(scan.totalLines).toBe(100);
  });

  it('行尾的 \\r 留著（偏離 2）', async () => {
    const scan = await scanWindow(['a\r\nb\r\n'], params());
    expect(scan.lines).toEqual(['a\r', 'b\r']);
  });

  it('中止就丟 ScanAborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      scanWindow(['abc'], params(), { signal: controller.signal }),
    ).rejects.toMatchObject({
      name: 'ScanAborted',
    });
  });
});

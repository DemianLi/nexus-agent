/**
 * `thread-list-cli.ts` 造的假日誌，列表讀得懂（#2959）：事件種類不在已知清單裡時，每份都算成讀不懂，那支腳本每格作廢。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openJsonlSessionStore } from '../jsonl-session-store.js';
import { listStoredThreads } from '../session-list.js';
import { generate } from './thread-list-data.js';

const temporary: string[] = [];

afterEach(async () => {
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('量會話列表用的假日誌', () => {
  it('每一份都讀得懂、有標題，大小接近要的', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nexus-thread-list-data-'));
    temporary.push(dir);
    const cwd = '/work/measure';
    const total = await generate(dir, { count: 3, fileBytes: 100_000 }, cwd);

    const listed = await listStoredThreads(openJsonlSessionStore({ directory: dir }), {
      cwd,
      title: { maxWords: 5, maxBytes: 40 },
    });
    expect(listed.unreadable).toBe(0);
    expect(listed.items).toHaveLength(3);
    expect(listed.items.every((item) => !item.blank && item.title !== undefined)).toBe(true);
    expect(total / 3).toBeGreaterThanOrEqual(100_000);
    expect(total / 3).toBeLessThan(100_000 + 33 * 1024);
  });
});

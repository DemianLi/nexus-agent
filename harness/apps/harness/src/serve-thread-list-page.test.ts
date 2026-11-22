/**
 * `GET /threads` 一次一部分（[#725](https://github.com/DemianLi/nexus-agent/issues/725)）：真 `runServe`、真落盤，經 wire client 帶查詢參數。
 * 切法的細項在 `@nexus/wire` 的 `thread-list-query.test.ts`；這一檔驗 server 真的照參數切、藏起來的與封存的照規則、不合法的回協定層的錯。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ThreadListQuery, WireClient } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';

import { foldTurn, serveClient } from './fixtures.js';
import { startScriptedServe } from './scripted-serve.js';
import type { ScriptedServe } from './scripted-serve.js';

const opened: ScriptedServe[] = [];
const temporary: string[] = [];

afterEach(async () => {
  for (const serve of opened.splice(0)) await serve.close();
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function say(client: WireClient, threadId: string, text: string): Promise<void> {
  const events = await client.openEvents(threadId);
  expect((await client.runStart(threadId, text)).type).toBe('success');
  await foldTurn(events);
  await events.return?.(undefined);
}

describe('會話列表帶查詢參數', () => {
  it('翻頁、只比標題、封存、指定幾條；不帶參數照舊是整份', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-thread-page-'));
    temporary.push(root);
    const ids = ['p1', 'p2', 'p3', 'p4', 'p5'];
    const serve = await startScriptedServe(
      ids.map((id) => ({ content: `回 ${id}` })),
      { argv: ['--session-log', root] },
    );
    opened.push(serve);
    const client = await serveClient(serve.running);
    for (const id of ids) await say(client, id, `問題 ${id}`);

    const list = async (query?: ThreadListQuery) => {
      const outcome = await client.listThreads(query);
      if (outcome.kind !== 'ok') throw new Error(`列表失敗 ${outcome.message}`);
      return outcome.result;
    };
    const whole = (await list()).items.map(({ threadId }) => threadId);
    expect(whole).toEqual(['p5', 'p4', 'p3', 'p2', 'p1']);
    expect((await list()).nextCursor).toBeUndefined();

    const paged: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await list({ limit: 2, ...(cursor !== undefined && { cursor }) });
      expect(page.items.length).toBeLessThanOrEqual(2);
      // 釘選與封存兩個集合每一頁都帶：畫側欄不必另外問。
      expect(page.archivedThreadIds).toBeDefined();
      paged.push(...page.items.map(({ threadId }) => threadId));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    expect(paged).toEqual(whole);

    expect((await list({ q: '問題 P3' })).items.map(({ threadId }) => threadId)).toEqual(['p3']);

    expect(await client.threadArchive('p4')).toMatchObject({ kind: 'ok', result: { ok: true } });
    expect(
      (await list({ archived: 'exclude', limit: 2 })).items.map(({ threadId }) => threadId),
    ).toEqual(['p5', 'p3']);
    expect((await list({ archived: 'only' })).items.map(({ threadId }) => threadId)).toEqual([
      'p4',
    ]);

    expect(
      (await list({ ids: ['p1', 'nope', 'p5'] })).items.map(({ threadId }) => threadId),
    ).toEqual(['p5', 'p1']);

    const refused = await client.listThreads({ ids: ['p1'], limit: 1 });
    expect(refused).toMatchObject({ kind: 'rejected', code: 'invalid_argument' });
  }, 60_000);
});

/**
 * 產品路徑上的會話列表索引（[#725](https://github.com/DemianLi/nexus-agent/issues/725)）：真 `runServe`、真落盤、腳本模型。
 *
 * `GET /threads` 讀記憶體，所以每一種這個行程做得到的改動之後**立刻**列一次，都要跟同一刻冷讀磁碟的結果一樣：
 * 新開、講話（`updatedAt` 往前）、改名、分叉、刪除、復原。漏接一種，那一步就對不上。
 * 什麼時候重算的細項在 [`thread-index.test.ts`](./thread-index.test.ts)。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { emptyConversation, reduceAll } from '@nexus/wire';
import type { WireClient } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';

import { foldTurn, serveClient } from './fixtures.js';
import { openJsonlSessionStore, projectKey } from './jsonl-session-store.js';
import type { ScriptedTurn } from './scripted-model.js';
import { startScriptedServe } from './scripted-serve.js';
import type { ScriptedServe } from './scripted-serve.js';
import { listStoredThreads } from './session-list.js';
import { threadTitleConfigSchema } from './settings/thread-title.js';

const opened: ScriptedServe[] = [];
const temporary: string[] = [];

afterEach(async () => {
  for (const serve of opened.splice(0)) await serve.close();
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(dir);
  return dir;
}

const TURNS: readonly ScriptedTurn[] = [
  { content: '回一' },
  { content: '回二' },
  { content: '回三' },
];

async function say(client: WireClient, threadId: string, text: string): Promise<void> {
  const events = await client.openEvents(threadId);
  expect((await client.runStart(threadId, text)).type).toBe('success');
  await foldTurn(events);
  await events.return?.(undefined);
}

describe('會話列表索引接在 serve 上', () => {
  it('每一種改動之後立刻列，都跟冷讀磁碟一樣', async () => {
    const root = await tempDir('nexus-thread-index-log-');
    const deleted = await tempDir('nexus-thread-index-store-');
    const serve = await startScriptedServe(TURNS, {
      argv: ['--session-log', root],
      extraRows: `- id: thread-deletion-store\n  config:\n    path: ${JSON.stringify(deleted)}\n`,
    });
    opened.push(serve);
    const client = await serveClient(serve.running);
    const cwd = process.cwd();
    const disk = openJsonlSessionStore({ directory: join(root, projectKey(cwd)) });
    const title = threadTitleConfigSchema.parse({});

    const matchesDisk = async (step: string) => {
      const page = await client.listThreads();
      if (page.kind !== 'ok') throw new Error(`${step}：列表失敗 ${page.message}`);
      const cold = await listStoredThreads(disk, { cwd, title });
      const listed = page.result.items.map(({ running: _running, ...row }) => row);
      expect(listed, step).toEqual(cold.items);
      return listed.map(({ threadId }) => threadId);
    };

    await say(client, 'x', '第一條');
    expect(await matchesDisk('新開 x')).toEqual(['x']);
    await say(client, 'y', '第二條');
    expect(await matchesDisk('新開 y')).toEqual(['y', 'x']);
    await say(client, 'x', '回到第一條');
    expect(await matchesDisk('x 講話')).toEqual(['x', 'y']);

    expect(await client.threadRename('y', '改過的名字')).toMatchObject({
      kind: 'ok',
      result: { ok: true },
    });
    await matchesDisk('改名 y');

    const history = await client.threadHistory('x');
    if (history.kind !== 'ok') throw new Error('歷史拿不到');
    const tail = reduceAll(emptyConversation(), history.result.events).entries.find(
      (entry) => entry.kind === 'ai' && entry.turnTail === true && entry.messageId !== undefined,
    );
    if (tail?.kind !== 'ai' || tail.messageId === undefined) throw new Error('沒有收尾的回覆');
    const fork = await client.threadFork('x', tail.messageId);
    if (fork.kind !== 'ok' || !fork.result.ok) throw new Error('分叉失敗');
    const child = fork.result.value.threadId;
    expect(await matchesDisk('分叉')).toContain(child);

    expect(await client.threadDelete('y')).toMatchObject({ kind: 'ok', result: { ok: true } });
    expect(await matchesDisk('刪 y')).not.toContain('y');
    expect(await client.threadRestore('y')).toMatchObject({ kind: 'ok', result: { ok: true } });
    expect(await matchesDisk('復原 y')).toContain('y');
  }, 60_000);

  it('重啟前刪掉的，重啟後復原：立刻列得出來', async () => {
    // 重啟後建的索引裡本來就沒有這一列：復原的 touch 要補回一條索引從沒見過的（刪除時那一條靠藏起來的集合，測不到這一點）。
    const root = await tempDir('nexus-thread-index-log-');
    const deleted = await tempDir('nexus-thread-index-store-');
    const start = async () => {
      const serve = await startScriptedServe(TURNS, {
        argv: ['--session-log', root],
        extraRows: `- id: thread-deletion-store\n  config:\n    path: ${JSON.stringify(deleted)}\n`,
      });
      opened.push(serve);
      return { serve, client: await serveClient(serve.running) };
    };
    const listedIds = async (client: WireClient) => {
      const page = await client.listThreads();
      if (page.kind !== 'ok') throw new Error(`列表失敗 ${page.message}`);
      return page.result.items.map(({ threadId }) => threadId);
    };

    const first = await start();
    await say(first.client, 'keep', '留著');
    await say(first.client, 'gone', '要刪的');
    expect(await first.client.threadDelete('gone')).toMatchObject({ kind: 'ok' });
    opened.splice(opened.indexOf(first.serve), 1);
    await first.serve.close();

    const second = await start();
    expect(await listedIds(second.client)).toEqual(['keep']);
    expect(await second.client.threadRestore('gone')).toMatchObject({
      kind: 'ok',
      result: { ok: true },
    });
    expect(await listedIds(second.client)).toEqual(['gone', 'keep']);
  }, 60_000);
});

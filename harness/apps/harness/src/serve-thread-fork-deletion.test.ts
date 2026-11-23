/**
 * 刪除碰到分叉（[#2957](https://github.com/DemianLi/nexus-agent/issues/2957)）：真 `runServe`、真落盤、腳本模型。
 *
 * 分出來的子會話是**獨立的 thread**：分叉時把來源的前綴抄進自己的檔（`isSeeded`），header 只留 `parentSession` 指回來源。
 * 刪除只搬那條會話與它的子代理，不搬分叉出去的子會話（`thread-deletion.ts` 的 `planItems`）。這一檔在產品路徑上驗兩個方向：
 *
 * - **刪來源**：子會話還在清單上、歷史完整、講得下去，重啟之後也是；復原來源之後兩條都在。
 * - **刪子會話**：來源還在清單上、歷史完整、講得下去，重啟之後也是。
 *
 * 祖先被刪之後外溢內容還找不找得到，在 [`fork-stash-deleted.test.ts`](./fork-stash-deleted.test.ts)。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { emptyConversation, reduceAll } from '@nexus/wire';
import type { ConversationEntry, WireClient } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';

import { foldTurn, serveClient } from './fixtures.js';
import type { ScriptedTurn } from './scripted-model.js';
import { startScriptedServe } from './scripted-serve.js';
import type { ScriptedServe } from './scripted-serve.js';
import { findSession } from './session-files.fixture.js';

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

/** 每條 thread 各吃一份腳本、從第一輪開始，所以回覆照輪次編號就分得出是第幾輪。 */
const TURNS: readonly ScriptedTurn[] = [
  { content: '回一' },
  { content: '回二' },
  { content: '回三' },
  { content: '回四' },
];

interface Rig {
  readonly root: string;
  start(): Promise<WireClient>;
  stop(): Promise<void>;
}

/** 一組落盤目錄與已刪除存放區，可以重複起、收同一台 serve。 */
async function rig(): Promise<Rig> {
  const root = await tempDir('nexus-fork-del-log-');
  const deleted = await tempDir('nexus-fork-del-store-');
  const workspace = await tempDir('nexus-fork-del-ws-');
  let current: ScriptedServe | undefined;
  return {
    root,
    async start() {
      current = await startScriptedServe(TURNS, {
        workspace,
        argv: ['--session-log', root],
        extraRows: `- id: thread-deletion-store\n  config:\n    path: ${JSON.stringify(deleted)}\n`,
      });
      opened.push(current);
      return serveClient(current.running);
    },
    async stop() {
      if (current === undefined) return;
      opened.splice(opened.indexOf(current), 1);
      await current.close();
      current = undefined;
    },
  };
}

async function say(client: WireClient, threadId: string, text: string): Promise<void> {
  const events = await client.openEvents(threadId);
  expect((await client.runStart(threadId, text)).type).toBe('success');
  await foldTurn(events);
  await events.return?.(undefined);
}

async function entries(client: WireClient, threadId: string): Promise<ConversationEntry[]> {
  const page = await client.threadHistory(threadId);
  if (page.kind !== 'ok') throw new Error(`歷史拿不到：${page.message}`);
  return [...reduceAll(emptyConversation(), page.result.events).entries];
}

/**
 * 這條講過的每一句人話。回覆是哪一句由腳本決定（每條 thread、每次起動都從第一輪吃起），不比內容，只要求每句人話後面都接著一則回覆。
 */
async function said(client: WireClient, threadId: string): Promise<string[]> {
  const list = (await entries(client, threadId)).filter(
    (entry) => entry.kind === 'human' || entry.kind === 'ai',
  );
  const humans: string[] = [];
  list.forEach((entry, index) => {
    if (entry.kind !== 'human') return;
    expect(list[index + 1]?.kind, `「${entry.text}」後面沒有回覆`).toBe('ai');
    humans.push(entry.text);
  });
  return humans;
}

/** 來源講兩輪，從第二輪的回覆分叉，回子會話的 id。 */
async function sourceAndFork(client: WireClient): Promise<string> {
  await say(client, 'src', '一');
  await say(client, 'src', '二');
  const tails = (await entries(client, 'src')).flatMap((entry) =>
    entry.kind === 'ai' && entry.turnTail === true && entry.messageId !== undefined
      ? [entry.messageId]
      : [],
  );
  const outcome = await client.threadFork('src', tails[1]!);
  if (outcome.kind !== 'ok' || !outcome.result.ok) {
    throw new Error(`分叉失敗：${JSON.stringify(outcome)}`);
  }
  return outcome.result.value.threadId;
}

async function listed(client: WireClient): Promise<Map<string, { parentThreadId?: string }>> {
  const page = await client.listThreads();
  if (page.kind !== 'ok') throw new Error(`列表失敗：${page.message}`);
  return new Map(page.result.items.map((item) => [item.threadId, item]));
}

async function deletedIds(client: WireClient): Promise<string[]> {
  const page = await client.deletedThreads();
  if (page.kind !== 'ok') throw new Error(`已刪除清單拿不到：${page.message}`);
  return page.result.items.map((item) => item.threadId);
}

async function expectOk(
  outcome: Promise<{ kind: string; result?: { ok: boolean } }>,
  what: string,
) {
  const settled = await outcome;
  expect(settled, what).toMatchObject({ kind: 'ok', result: { ok: true } });
}

const INHERITED = ['一', '二'];

describe('刪除碰到分叉', () => {
  it('刪來源：子會話留在清單上、歷史完整、講得下去，重啟之後也是；復原來源之後兩條都在', async () => {
    const r = await rig();
    let client = await r.start();
    const child = await sourceAndFork(client);
    await say(client, child, '刪之前子的一句');

    await expectOk(client.threadDelete('src'), '刪來源');
    expect(await findSession(r.root, 'src')).toBeUndefined();
    expect(await findSession(r.root, child)).toBeDefined();
    let rows = await listed(client);
    expect(rows.has('src')).toBe(false);
    expect(rows.get(child)?.parentThreadId).toBe('src');
    expect(await deletedIds(client)).toEqual(['src']);
    expect(await said(client, child)).toEqual([...INHERITED, '刪之前子的一句']);
    await say(client, child, '刪之後子的一句');

    await r.stop();
    client = await r.start();
    rows = await listed(client);
    expect(rows.has('src')).toBe(false);
    expect(rows.get(child)?.parentThreadId).toBe('src');
    await say(client, child, '重啟之後子的一句');
    expect(await said(client, child)).toEqual([
      ...INHERITED,
      '刪之前子的一句',
      '刪之後子的一句',
      '重啟之後子的一句',
    ]);

    await expectOk(client.threadRestore('src'), '復原來源');
    rows = await listed(client);
    expect(rows.has('src')).toBe(true);
    expect(rows.get(child)?.parentThreadId).toBe('src');
    expect(await said(client, 'src')).toEqual(INHERITED);
  }, 60_000);

  it('刪子會話：來源留在清單上、歷史完整、講得下去，重啟之後也是', async () => {
    const r = await rig();
    let client = await r.start();
    const child = await sourceAndFork(client);
    await say(client, child, '子的一句');

    await expectOk(client.threadDelete(child), '刪子會話');
    expect(await findSession(r.root, child)).toBeUndefined();
    let rows = await listed(client);
    expect(rows.has(child)).toBe(false);
    expect(rows.has('src')).toBe(true);
    expect(await deletedIds(client)).toEqual([child]);
    expect(await said(client, 'src')).toEqual(INHERITED);
    await say(client, 'src', '刪之後來源的一句');

    await r.stop();
    client = await r.start();
    rows = await listed(client);
    expect(rows.has(child)).toBe(false);
    expect(rows.has('src')).toBe(true);
    await say(client, 'src', '重啟之後來源的一句');
    expect(await said(client, 'src')).toEqual([
      ...INHERITED,
      '刪之後來源的一句',
      '重啟之後來源的一句',
    ]);
  }, 60_000);
});

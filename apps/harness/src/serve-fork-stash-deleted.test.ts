/**
 * 祖先被刪之後，分叉的子孫還讀得到繼承來的外溢檔（[#2957](https://github.com/DemianLi/nexus-agent/issues/2957)）：
 * 真 `runServe`、真落盤、腳本模型，外溢檔的生產者是真的跨會話引用（`session-reference.ts`）。
 *
 * 鏈是 beta ← child ← grandchild，外溢檔寫在 beta 的暫存目錄。刪除不搬暫存目錄，只搬日誌，所以：
 *
 * - **刪掉存檔的那一代（beta）**：child 重啟後照前綴裡的定位讀得到原文。
 * - **再刪掉中間那一代（child）**：grandchild 的祖先鏈要退回已刪除存放區讀 child 的 header 才找得到 beta；重啟後讀得到原文。
 *
 * 祖先鏈退回存放區的細項在 [`fork-stash-deleted.test.ts`](./fork-stash-deleted.test.ts)，沒刪除時的讀取在
 * [`serve-fork-stash.test.ts`](./serve-fork-stash.test.ts)。**零憑證、零外部連線**。
 */

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SessionEvent } from '@nexus/core';
import { emptyConversation, reduceAll } from '@nexus/wire';
import type { WireClient } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';

import { foldTurn, serveClient } from './fixtures.js';
import { HARNESS_HOME_DIR_NAME } from './harness-home.js';
import { openJsonlSessionStore, projectKey } from './jsonl-session-store.js';
import type { ScriptedTurn } from './scripted-model.js';
import { startScriptedServe } from './scripted-serve.js';
import type { ScriptedServe } from './scripted-serve.js';
import { findSession } from './session-files.fixture.js';
import { TOOL_RESULT_STASH_DIR_NAME } from './settings/tool-result-stash.js';
import { stashSessionDirName } from './tool-result-stash.js';

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

async function say(client: WireClient, threadId: string, text: string): Promise<void> {
  const events = await client.openEvents(threadId);
  expect((await client.runStart(threadId, text)).type).toBe('success');
  await foldTurn(events);
  await events.return?.(undefined);
}

async function mentionOf(client: WireClient, threadId: string, target: string): Promise<string> {
  const outcome = await client.sessionReferences(threadId, '');
  if (outcome.kind !== 'ok' || !outcome.result.available) throw new Error('列不出會話');
  const candidate = outcome.result.candidates.find(({ sessionId }) => sessionId === target);
  if (candidate === undefined) throw new Error(`候選裡沒有 ${target}`);
  return candidate.mention;
}

async function firstTailId(client: WireClient, threadId: string): Promise<string> {
  const page = await client.threadHistory(threadId);
  if (page.kind !== 'ok') throw new Error(`歷史拿不到：${page.message}`);
  const tail = reduceAll(emptyConversation(), page.result.events).entries.find(
    (entry) => entry.kind === 'ai' && entry.turnTail === true && entry.messageId !== undefined,
  );
  if (tail?.kind !== 'ai' || tail.messageId === undefined) throw new Error('沒有收尾的回覆');
  return tail.messageId;
}

async function forkOk(client: WireClient, threadId: string, messageId: string): Promise<string> {
  const outcome = await client.threadFork(threadId, messageId);
  if (outcome.kind !== 'ok' || !outcome.result.ok) {
    throw new Error(`分叉失敗：${JSON.stringify(outcome)}`);
  }
  return outcome.result.value.threadId;
}

async function deleteOk(client: WireClient, threadId: string): Promise<void> {
  expect(await client.threadDelete(threadId), `刪 ${threadId}`).toMatchObject({
    kind: 'ok',
    result: { ok: true },
  });
}

/** 這條 thread 日誌裡 `read_file` 的結果（文字與成敗）；`directory` 是活的目錄或存放區裡這個專案那一格。 */
async function readResults(directory: string, threadId: string) {
  const events: readonly SessionEvent[] = await (
    await openJsonlSessionStore({ directory }).open(threadId, 'read')
  ).read();
  return events.flatMap((event) =>
    event.type === 'tool/result' && JSON.stringify(event.data).includes('read_file')
      ? [{ isError: event.data.isError, text: JSON.stringify(event.data.message) }]
      : [],
  );
}

describe('祖先被刪之後讀繼承來的外溢檔', () => {
  it('刪掉存檔的那一代、再刪掉中間那一代，子孫重啟後都還讀得到原文', async () => {
    const root = await tempDir('nexus-fork-stash-del-log-');
    const deleted = await tempDir('nexus-fork-stash-del-store-');
    const directory = join(root, projectKey(process.cwd()));
    const deletedDirectory = join(deleted, projectKey(process.cwd()));
    const stashRoot = join(homedir(), HARNESS_HOME_DIR_NAME, TOOL_RESULT_STASH_DIR_NAME);
    const dirOf = (threadId: string) =>
      join(stashRoot, stashSessionDirName(`${directory}\0${threadId}`));

    const start = async (turns: readonly ScriptedTurn[]) => {
      const serve = await startScriptedServe(turns, {
        argv: ['--session-log', root],
        extraRows: `- id: thread-deletion-store\n  config:\n    path: ${JSON.stringify(deleted)}\n`,
      });
      opened.push(serve);
      return { serve, client: await serveClient(serve.running) };
    };
    const stop = async (serve: ScriptedServe) => {
      opened.splice(opened.indexOf(serve), 1);
      await serve.close();
    };
    const replies: readonly ScriptedTurn[] = [{ content: '回一' }, { content: '回二' }];

    // 同 `serve-fork-stash.test.ts`：alpha 長到塞不進引用預算，beta 引用它，截掉的全文存進 beta 的暫存目錄。
    const middle = 'MIDDLE-OF-THE-REFERENCED-SESSION'.padEnd(64, '-');
    const first = await start(replies);
    await say(first.client, 'alpha', `${'a'.repeat(64 * 1500)}${middle}${'b'.repeat(64 * 1500)}`);
    await stop(first.serve);

    const second = await start(replies);
    await say(
      second.client,
      'beta',
      `接著上面那條 ${await mentionOf(second.client, 'beta', 'alpha')} 說`,
    );
    const child = await forkOk(second.client, 'beta', await firstTailId(second.client, 'beta'));
    // 從 child 繼承來的那一輪再分叉：grandchild 的 header 指 child，要經過 child 才找得到 beta。
    const grandchild = await forkOk(second.client, child, await firstTailId(second.client, child));
    await stop(second.serve);
    temporary.push(dirOf('beta'), dirOf(child), dirOf(grandchild));

    const [stashed] = await readdir(dirOf('beta'));
    expect(stashed).toMatch(/^[0-9a-f]{12}-session-reference-1\.txt$/u);
    // 中間那一行只在存檔的全文裡，預覽沒有：讀得到它才是真的讀到了 beta 目錄那一份。
    const lines = (await readFile(join(dirOf('beta'), stashed!), 'utf8')).split('\n');
    const at = lines.findIndex((line) => line.includes('MIDDLE-OF'));
    expect(at).toBeGreaterThan(0);
    const reading: readonly ScriptedTurn[] = [
      {
        content: '',
        toolCalls: [
          {
            name: 'read_file',
            args: { file_path: `/large_tool_results/${stashed!}`, offset: at - 1, limit: 3 },
          },
        ],
      },
      { content: '讀完了' },
    ];

    const third = await start(reading);
    await deleteOk(third.client, 'beta');
    await stop(third.serve);

    const fourth = await start(reading);
    await say(fourth.client, child, '把引用的全文讀出來');
    await deleteOk(fourth.client, child);
    await stop(fourth.serve);

    const fifth = await start(reading);
    await say(fifth.client, grandchild, '把引用的全文讀出來');
    await stop(fifth.serve);

    expect(await findSession(root, 'beta')).toBeUndefined();
    expect(await findSession(root, child)).toBeUndefined();
    for (const [where, threadId] of [
      [deletedDirectory, child],
      [directory, grandchild],
    ] as const) {
      const results = await readResults(where, threadId);
      expect(results, threadId).toHaveLength(1);
      expect(results[0], threadId).toMatchObject({ isError: false });
      expect(results[0]!.text, threadId).toContain('MIDDLE-OF');
    }
    // 刪除只搬日誌：beta 的暫存目錄原封不動。
    expect(await readdir(dirOf('beta'))).toEqual([stashed]);
  }, 90_000);
});

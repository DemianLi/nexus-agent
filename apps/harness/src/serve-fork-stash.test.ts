/**
 * 產品路徑上分叉的子 thread 讀繼承來的外溢檔（[#1580](https://github.com/DemianLi/nexus-agent/issues/1580) 驗收 7、Q1 (a)）：
 * 真 `runServe`、真落盤、腳本模型，外溢檔的生產者是真的跨會話引用（`session-reference.ts`）。
 *
 * - 子 thread 重啟後續接，`read_file` 照繼承前綴裡的定位讀得到來源目錄裡的原文；自己的目錄沒有多出一份。
 * - 從子 thread **繼承來的那一輪**再分叉（孫 thread 的日誌只有一顆繼承標記），第一次組裝就讀得到——沿祖先鏈找到來源那一代。
 * - 子 thread 自己新的外溢檔寫在自己的目錄，來源目錄不多出檔。
 *
 * 名單與路由的細項在 [`fork-stash.test.ts`](./fork-stash.test.ts)。**零憑證、零外部連線**。
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
import { TOOL_RESULT_STASH_DIR_NAME } from './settings/tool-result-stash.js';
import { stashSessionDirName } from './tool-result-stash.js';

const opened: ScriptedServe[] = [];
const temporary: string[] = [];

afterEach(async () => {
  for (const serve of opened.splice(0)) await serve.close();
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function start(turns: readonly ScriptedTurn[], root: string): Promise<ScriptedServe> {
  const serve = await startScriptedServe(turns, { argv: ['--session-log', root] });
  opened.push(serve);
  return serve;
}

async function stop(serve: ScriptedServe): Promise<void> {
  opened.splice(opened.indexOf(serve), 1);
  await serve.close();
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

/** 這條 thread 日誌裡 `read_file` 的結果（文字與成敗）。 */
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

describe('分叉的子 thread 讀繼承來的外溢檔（驗收 7）', () => {
  it('重啟後續接、從繼承來的那一輪再分叉都讀得到；新的外溢檔寫在自己的目錄', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-fork-stash-'));
    temporary.push(root);
    const directory = join(root, projectKey(process.cwd()));
    const stashRoot = join(homedir(), HARNESS_HOME_DIR_NAME, TOOL_RESULT_STASH_DIR_NAME);
    const dirOf = (threadId: string) =>
      join(stashRoot, stashSessionDirName(`${directory}\0${threadId}`));
    const replies: readonly ScriptedTurn[] = [{ content: '回一' }, { content: '回二' }];

    // alpha 長到塞不進引用預算；beta 引用它，截掉的全文由真的引用流程存進 beta 的暫存目錄。
    const middle = 'MIDDLE-OF-THE-REFERENCED-SESSION'.padEnd(64, '-');
    const first = await start(replies, root);
    await say(
      await serveClient(first.running),
      'alpha',
      `${'a'.repeat(64 * 5000)}${middle}${'b'.repeat(64 * 5000)}`,
    );
    await stop(first);

    const second = await start(replies, root);
    const client2 = await serveClient(second.running);
    await say(client2, 'beta', `接著上面那條 ${await mentionOf(client2, 'beta', 'alpha')} 說`);
    const childId = await forkOk(client2, 'beta', await firstTailId(client2, 'beta'));
    await stop(second);

    const [stashed] = await readdir(dirOf('beta'));
    expect(stashed).toMatch(/^[0-9a-f]{12}-session-reference-1\.txt$/u);
    // 中間那一行只在存檔的全文裡，預覽沒有：讀得到它才是真的讀到了來源目錄那一份。
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
      { content: '回三' },
    ];

    const third = await start(reading, root);
    const client3 = await serveClient(third.running);
    // 子 thread 重啟後續接（`createAgent` 讀磁碟上的 header）。
    await say(client3, childId, '把引用的全文讀出來');
    // 從子 thread 繼承來的那一輪再分叉：孫 thread 的前綴切在 beta 那一段裡，第一次組裝。
    const grandchildId = await forkOk(client3, childId, await firstTailId(client3, childId));
    await say(client3, grandchildId, '把引用的全文讀出來');
    // 子 thread 自己再引用一次：新的外溢檔寫在子 thread 的目錄。
    await say(client3, childId, `再看一次 ${await mentionOf(client3, childId, 'alpha')}`);
    await stop(third);

    for (const threadId of [childId, grandchildId]) {
      const results = await readResults(directory, threadId);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ isError: false });
      expect(results[0]!.text).toContain('MIDDLE-OF');
    }
    // 讀的是來源那一份：來源目錄仍只有那一個檔，孫 thread 沒有目錄（沒寫過東西）。
    expect(await readdir(dirOf('beta'))).toEqual([stashed]);
    const own = await readdir(dirOf(childId));
    expect(own).toHaveLength(1);
    expect(own[0]).toMatch(/^[0-9a-f]{12}-session-reference-1\.txt$/u);
    expect(own[0]).not.toBe(stashed);
    await expect(readdir(dirOf(grandchildId))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 60_000);
});

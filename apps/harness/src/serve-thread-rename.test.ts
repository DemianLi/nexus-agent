/**
 * 產品路徑上的改名（[#633](https://github.com/DemianLi/nexus-agent/issues/633) 第二張）：真 `runServe`、真落盤。
 *
 * 回應形狀在 [`thread-rename-wire.test.ts`](./thread-rename-wire.test.ts)；這一檔問的是只有產品路徑上量得到的：
 *
 * 1. **列表讀得到新標題**，重啟之後還在（日誌落盤，列表照最後一顆 `session/title` 讀）。
 * 2. **釘住**：改名之後再說話，退回標題不蓋過它。
 * 3. **只在磁碟上的 thread** 重啟之後也改得了名。
 */

import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionEvent } from '@nexus/core';
import { afterEach, describe, expect, it } from 'vitest';
import { foldTurn, serveClient } from './fixtures.js';
import { projectKey } from './jsonl-session-store.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';

let running: RunningServe | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function start(root: string): Promise<RunningServe> {
  running = await runServe({
    argv: ['--port', '0', '--session-log', root],
    log: () => undefined,
    env: {},
  });
  return running as RunningServe;
}

async function stop(server: RunningServe): Promise<void> {
  await server.close();
  running = undefined;
}

async function driveTurn(server: RunningServe, threadId: string, prompt: string): Promise<void> {
  const client = await serveClient(server);
  const events = await client.openEvents(threadId);
  await client.runStart(threadId, prompt);
  await foldTurn(events);
  await events.return?.(undefined);
}

async function titlesOnDisk(root: string, threadId: string): Promise<string[]> {
  const body = await readFile(join(root, projectKey(process.cwd()), `${threadId}.jsonl`), 'utf8');
  return body
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as SessionEvent)
    .flatMap((event) =>
      event.type === 'session/title'
        ? [
            `${(event.data as { source: { kind: string } }).source.kind}:${(event.data as { title: string }).title}`,
          ]
        : [],
    );
}

/** 列表讀的是落盤的那份；落盤是非同步的，所以等到它變成預期的值（逾時就讓斷言講哪裡不對）。 */
async function listedTitleBecomes(
  server: RunningServe,
  threadId: string,
  expected: string,
): Promise<string | undefined> {
  const deadline = Date.now() + 5000;
  let title = await listedTitle(server, threadId);
  while (title !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    title = await listedTitle(server, threadId);
  }
  return title;
}

async function listedTitle(server: RunningServe, threadId: string): Promise<string | undefined> {
  const listed = await (await serveClient(server)).listThreads();
  if (listed.kind !== 'ok') throw new Error(`列表失敗：${listed.message}`);
  return listed.result.items.find((item) => item.threadId === threadId)?.title;
}

describe('serve 上的改名', () => {
  it('改名之後列表讀得到、再說話退回標題不蓋過它、重啟之後還在，日誌上是 source:user', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-serve-rename-'));
    const first = await start(root);
    await driveTurn(first, 'alpha', '請幫我整理這份文件');
    const client = await serveClient(first);
    expect(await client.threadRename('alpha', '  我取的名字 ')).toMatchObject({
      result: { ok: true, value: { title: '我取的名字' } },
    });
    expect(await listedTitleBecomes(first, 'alpha', '我取的名字')).toBe('我取的名字');
    await driveTurn(first, 'alpha', '再問一句別的');
    expect(await listedTitle(first, 'alpha')).toBe('我取的名字');
    await stop(first);
    expect(await titlesOnDisk(root, 'alpha')).toEqual([
      'fallback:請幫我整理這份文件',
      'user:我取的名字',
    ]);

    // 重啟：沒開過的 thread 只在磁碟上，列表照最後一顆讀；再改一次，重開那條 thread。
    const second = await start(root);
    expect(await listedTitle(second, 'alpha')).toBe('我取的名字');
    expect(await (await serveClient(second)).threadRename('alpha', '第二個名字')).toMatchObject({
      result: { ok: true, value: { title: '第二個名字' } },
    });
    expect(await listedTitleBecomes(second, 'alpha', '第二個名字')).toBe('第二個名字');
    expect(await (await serveClient(second)).threadRename('ghost', '沒這條')).toEqual({
      kind: 'ok',
      result: { ok: false, error: { code: 'thread_not_found' } },
    });
    await stop(second);
    expect(await titlesOnDisk(root, 'alpha')).toEqual([
      'fallback:請幫我整理這份文件',
      'user:我取的名字',
      'user:第二個名字',
    ]);
  });
});

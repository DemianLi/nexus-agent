/**
 * 產品路徑上的釘選與封存（[#633](https://github.com/DemianLi/nexus-agent/issues/633)）：真 `runServe`、真落盤。
 *
 * 規則與回應形狀在 [`thread-organization.test.ts`](./thread-organization.test.ts) 與
 * [`thread-organization-wire.test.ts`](./thread-organization-wire.test.ts)；這一檔問的是只有產品路徑上量得到的：
 *
 * 1. **重啟之後集合還在**，而且 `GET /threads` 帶得出來——「存在伺服器端」這一句話的落地。
 * 2. **「存在嗎」問到磁碟**：重啟之後沒開過的會話（只在磁碟上）釘得了；不存在的、別的專案的釘不了。
 * 3. **封存的會話冷啟動也不跑模型**：重啟之後第一句話送到封存的會話，日誌上沒有新的 `turn/start`；取消封存就恢復。
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SESSION_LOG_FORMAT_VERSION } from '@nexus/core';
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

async function readEvents(root: string, threadId: string): Promise<readonly SessionEvent[]> {
  const body = await readFile(join(root, projectKey(process.cwd()), `${threadId}.jsonl`), 'utf8');
  return body
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as SessionEvent);
}

async function blockedEnds(root: string, threadId: string): Promise<number> {
  return (await readEvents(root, threadId)).filter(
    (event) =>
      event.type === 'turn/end' &&
      (event.data as { reason?: { kind?: string } }).reason?.kind === 'blocked',
  ).length;
}

async function until(predicate: () => Promise<boolean>, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > ms) throw new Error('等太久了');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function turnStarts(root: string, threadId: string): Promise<number> {
  return (await readEvents(root, threadId)).filter((event) => event.type === 'turn/start').length;
}

async function sets(server: RunningServe) {
  const listed = await (await serveClient(server)).listThreads();
  if (listed.kind !== 'ok') throw new Error(`列表失敗：${listed.message}`);
  return {
    pinned: listed.result.pinnedThreadIds,
    archived: listed.result.archivedThreadIds,
  };
}

describe('serve 上的釘選與封存', () => {
  it('重啟之後集合與順序還在；磁碟上的會話釘得了，不存在的釘不了，封存的不能釘', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-serve-org-'));
    const first = await start(root);
    await driveTurn(first, 'alpha', '第一條');
    await driveTurn(first, 'beta', '第二條');
    await driveTurn(first, 'gamma', '第三條');
    const client = await serveClient(first);
    await client.threadPin('alpha');
    await client.threadPin('beta');
    expect(await client.threadArchive('gamma')).toMatchObject({
      result: { ok: true, value: { archivedThreadIds: ['gamma'] } },
    });
    expect(await sets(first)).toEqual({ pinned: ['beta', 'alpha'], archived: ['gamma'] });
    await stop(first);

    const second = await start(root);
    expect(await sets(second)).toEqual({ pinned: ['beta', 'alpha'], archived: ['gamma'] });
    const again = await serveClient(second);
    // 這個行程裡一條 thread 都沒開過：「存在嗎」是問磁碟問出來的。
    expect(await again.threadUnpin('beta')).toMatchObject({
      result: { ok: true, value: { pinnedThreadIds: ['alpha'] } },
    });
    expect(await again.threadPin('beta')).toMatchObject({
      result: { ok: true, value: { pinnedThreadIds: ['beta', 'alpha'] } },
    });
    expect(await again.threadPin('ghost')).toEqual({
      kind: 'ok',
      result: { ok: false, error: { code: 'thread_not_found' } },
    });
    expect(await again.threadArchive('ghost')).toEqual({
      kind: 'ok',
      result: { ok: false, error: { code: 'thread_not_found' } },
    });
    expect(await again.threadPin('gamma')).toEqual({
      kind: 'ok',
      result: { ok: false, error: { code: 'thread_archived' } },
    });
    expect(await sets(second)).toEqual({ pinned: ['beta', 'alpha'], archived: ['gamma'] });
  });

  it('列不出來的磁碟會話（別的工作目錄寫的）釘不了；讀不動的 header 是協定層錯誤，不是「沒有這條」', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-serve-org-hidden-'));
    const first = await start(root);
    await driveTurn(first, 'alpha', '這台的');
    await stop(first);
    // 手寫兩份：一份 header 的 cwd 是別處（列表不列，所以不能釘），一份 header 壞了。
    const directory = join(root, projectKey(process.cwd()));
    await writeFile(
      join(directory, 'elsewhere.header.json'),
      JSON.stringify({
        version: SESSION_LOG_FORMAT_VERSION,
        id: 'elsewhere',
        createdAt: 1,
        cwd: '/somewhere/else',
      }),
    );
    await writeFile(join(directory, 'elsewhere.jsonl'), '');
    await writeFile(join(directory, 'broken.header.json'), '{ 壞掉的 header');
    await writeFile(join(directory, 'broken.jsonl'), '');

    const second = await start(root);
    const client = await serveClient(second);
    expect(await client.threadPin('alpha')).toMatchObject({ result: { ok: true } });
    expect(await client.threadPin('elsewhere')).toEqual({
      kind: 'ok',
      result: { ok: false, error: { code: 'thread_not_found' } },
    });
    expect(await client.threadPin('broken')).toMatchObject({
      kind: 'rejected',
      code: 'unknown_error',
    });
    expect(await sets(second)).toEqual({ pinned: ['alpha'], archived: [] });
  });

  it('封存的會話冷啟動也不跑模型：新的話開一輪以 blocked 收、模型看不到它；取消封存就恢復', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-serve-org-gate-'));
    const first = await start(root);
    await driveTurn(first, 'alpha', '先講一句');
    expect(await (await serveClient(first)).threadArchive('alpha')).toMatchObject({
      result: { ok: true },
    });
    await stop(first);
    expect(await turnStarts(root, 'alpha')).toBe(1);

    const second = await start(root);
    const client = await serveClient(second);
    const events = await client.openEvents('alpha');
    await client.runStart('alpha', '封存之後的話');
    // 正向訊號：日誌上出現 blocked 的 turn/end——等到它，之後才數「模型沒被叫」是真的擋下，而不是還沒輪到。
    await until(async () => (await blockedEnds(root, 'alpha')) === 1);
    await events.return?.(undefined);
    await stop(second);
    expect(await turnStarts(root, 'alpha')).toBe(2);
    expect(await blockedEnds(root, 'alpha')).toBe(1);
    expect((await readEvents(root, 'alpha')).some((event) => event.type === 'turn/failed')).toBe(
      false,
    );

    const third = await start(root);
    expect(await (await serveClient(third)).threadUnarchive('alpha')).toMatchObject({
      result: { ok: true, value: { archivedThreadIds: [] } },
    });
    await driveTurn(third, 'alpha', '恢復之後的話');
    await stop(third);
    expect(await turnStarts(root, 'alpha')).toBe(3);
    expect(await blockedEnds(root, 'alpha')).toBe(1);
  });
});

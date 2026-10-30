/**
 * 會話日誌太大，serve 在讀之前就拒收那一條，**其他 thread 照常**（[#2115](https://github.com/DemianLi/nexus-agent/issues/2115)）。
 *
 * 從 `runServe` 起：真的 serve、真的 JSONL 存放處、真的 wire client。不造幾百 MiB 的日誌，把額度換成比那份日誌小一個位元組
 * （`RunServeOptions.sessionLogBudget`）：拒收的判準只看大小，跟換出廠的哪個數無關。出廠容量怎麼算見 `session-log-budget.test.ts`。
 *
 * **零憑證、零外部連線**：模型是腳本。
 */

import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WireRejectedError } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';

import { foldTurn, serveClient } from './fixtures.js';
import { startScriptedServe } from './scripted-serve.js';
import type { ScriptedServe } from './scripted-serve.js';
import { sessionOf } from './session-files.fixture.js';
import { createSessionLogBudget } from './session-log-budget.js';
import type { SessionLogBudget } from './session-log-budget.js';

const TURNS = [{ content: '好。' }, { content: '好。' }, { content: '好。' }] as const;

let serve: ScriptedServe | undefined;
const temporary: string[] = [];

afterEach(async () => {
  await serve?.close();
  serve = undefined;
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** 內容搜尋那一列出廠不開（#631），打開它才量得到搜尋那一道。 */
const OPEN_SEARCH = '- id: thread-search\n  config:\n    openAt: first-search\n';

async function start(root: string, sessionLogBudget?: SessionLogBudget): Promise<ScriptedServe> {
  serve = await startScriptedServe(TURNS as never, {
    argv: ['--session-log', root],
    extraRows: OPEN_SEARCH,
    ...(sessionLogBudget !== undefined && { sessionLogBudget }),
  });
  return serve;
}

async function rejection(promise: Promise<unknown>): Promise<WireRejectedError> {
  const caught = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(caught).toBeInstanceOf(WireRejectedError);
  return caught as WireRejectedError;
}

describe('會話日誌超過額度（#2115）', () => {
  it('太大的那條在讀之前拒收、訊息寫出下一步；同一台 serve 上別的 thread 照常，列表照樣列得出它', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-serve-log-budget-'));
    temporary.push(root);

    // 第一台 serve 寫下 `alpha`，關掉：磁碟上留一條要續接的 thread。
    const first = await start(root);
    const firstClient = await serveClient(first.running);
    const events = await firstClient.openEvents('alpha');
    await firstClient.runStart('alpha', '第一句');
    await foldTurn(events);
    await events.return?.(undefined);
    await first.close();
    serve = undefined;

    const alphaBytes = (await stat((await sessionOf(root, 'alpha')).logPath)).size;
    const second = await start(root, createSessionLogBudget(alphaBytes - 1));
    const client = await serveClient(second.running);

    const refused = await rejection(client.openEvents('alpha'));
    expect(refused.code).toBe('unknown_error');
    expect(refused.serverMessage).toContain('alpha');
    expect(refused.serverMessage).toContain('超過這個行程能收的');
    expect(refused.serverMessage).toContain('--max-old-space-size');

    // 新的 thread 照常：一輪跑得完。
    const beta = await client.openEvents('beta');
    expect(await client.runStart('beta', '第一句')).toMatchObject({ type: 'success' });
    await foldTurn(beta);
    await beta.return?.(undefined);

    // 拒收沒留下租約：再開一次是同一個「太大」，不是「別的寫入者握著」。
    const again = await rejection(client.openEvents('alpha'));
    expect(again.code).toBe('unknown_error');
    expect(again.serverMessage).toContain('超過這個行程能收的');

    // 列表：太大的照列（沒有標題），不算進讀不了的。
    const listed = await client.listThreads();
    expect(listed.kind).toBe('ok');
    if (listed.kind !== 'ok') return;
    expect(listed.result.unreadable).toBe(0);
    expect(listed.result.items.map((thread) => thread.threadId).sort()).toEqual(['alpha', 'beta']);
    expect(
      listed.result.items.find((thread) => thread.threadId === 'alpha')?.title,
    ).toBeUndefined();

    // `@` 引用候選：太大的不列，整次照常回（不是一個錯）。
    const references = await client.sessionReferences('beta', '');
    expect(references.kind).toBe('ok');
    if (references.kind === 'ok' && references.result.available) {
      expect(references.result.candidates.map((candidate) => candidate.sessionId)).not.toContain(
        'alpha',
      );
    }

    // 按內容搜：太大的搜不到它的內容，整次照常回；`beta` 搜得到，證明這一次真的搜過。
    const searched = await client.searchThreads('第一句');
    expect(searched.kind).toBe('ok');
    if (searched.kind === 'ok') {
      const hits = searched.result.items.map((item) => item.threadId);
      expect(hits).toContain('beta');
      expect(hits).not.toContain('alpha');
    }
  });

  it('額度夠的時候同一份照常續接：判準是大小，不是這條 thread', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-serve-log-budget-'));
    temporary.push(root);
    const first = await start(root);
    const firstClient = await serveClient(first.running);
    const events = await firstClient.openEvents('alpha');
    await firstClient.runStart('alpha', '第一句');
    await foldTurn(events);
    await events.return?.(undefined);
    await first.close();
    serve = undefined;

    const alphaBytes = (await stat((await sessionOf(root, 'alpha')).logPath)).size;
    const second = await start(root, createSessionLogBudget(alphaBytes));
    const client = await serveClient(second.running);
    const reopened = await client.openEvents('alpha');
    expect(await client.runStart('alpha', '第二句')).toMatchObject({ type: 'success' });
    await foldTurn(reopened);
    await reopened.return?.(undefined);
  });

  it.each([
    ['不寫：照記憶體上限自動算', '', /^會話日誌額度：\d+\.\d MiB（.*自動算）$/u],
    [
      '寫正整數：固定成那個數',
      '    sessionLogBudgetMiB: 64\n',
      /^會話日誌額度：64\.0 MiB（.*sessionLogBudgetMiB 設的）$/u,
    ],
    [
      '寫 0：不限',
      '    sessionLogBudgetMiB: 0\n',
      /^會話日誌額度：不限（thread-capacity 的 sessionLogBudgetMiB 是 0/u,
    ],
  ])('thread-capacity 的 sessionLogBudgetMiB %s，起動輸出講出來', async (_name, row, expected) => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-serve-log-budget-'));
    temporary.push(root);
    const lines: string[] = [];
    serve = await startScriptedServe(TURNS as never, {
      argv: ['--session-log', root],
      extraRows: row === '' ? '' : `- id: thread-capacity\n  config:\n${row}`,
      log: (line) => lines.push(line),
    });
    const disclosed = lines
      .map((line) => line.replace(/^.*?(?=會話日誌額度：)/u, ''))
      .filter((line) => line.startsWith('會話日誌額度：'));
    expect(disclosed).toHaveLength(1);
    expect(disclosed[0]).toMatch(expected);
  });
});

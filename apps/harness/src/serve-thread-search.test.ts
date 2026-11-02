/**
 * 產品路徑上的 `POST /threads/search`——[#631](https://github.com/DemianLi/nexus-agent/issues/631)。
 *
 * 搜得對不對在 [`thread-search.test.ts`](./thread-search.test.ts)；這一檔問的是只有產品路徑上量得到的：
 *
 * 1. **出廠的清單不開**：有東西可搜時回失敗，沒有時回空；patch 一列打開之後，serve 寫下的日誌搜得到。
 * 2. **出廠的清單一次都不載入 `node:sqlite`**：Node 22 載入它會在 stderr 印一行實驗功能的警告，dsh 用測試釘同一件事
 *    （`apps/cli/tests/lazy-search-startup.compat.spec.ts:103-123`，`477b4f4`）。**判準是模組有沒有載入，不是 stderr
 *    有沒有那一行**：Node 24 以後不印，本機跑的是哪一版就量不到那一行。所以另起一個行程，退出時自己講載入過沒有。
 * 3. 線上的閘門：`content-type`、方法、body。
 * 4. **活的 thread 讀記憶體**（[#1599](https://github.com/DemianLi/nexus-agent/issues/1599)）：落盤窗口拉長，批次窗口裡的那一句搜得到；新建、
 *    分叉、重啟後續接的 root 拿來比的 header 都是真的寫進檔的那一份；還沒實體化的 thread 不進索引，搜尋也不替它建檔。
 */

import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyConversation, reduceAll, THREAD_SEARCH_PATH } from '@nexus/wire';
import type { WireClient } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';

import { fetchWithCookie, exchangeServeToken, foldTurn, serveClient } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import type { ScriptedTurn } from './scripted-model.js';
import { startScriptedServe } from './scripted-serve.js';
import type { ScriptedServe } from './scripted-serve.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';
import {
  findSession,
  rewriteSessionHeader,
  sessionEvents,
  sessionsUnder,
} from './session-files.fixture.js';
import { THREAD_SEARCH_DISABLED_MESSAGE } from './thread-search.js';

const serveEntry = fileURLToPath(new URL('./serve.ts', import.meta.url));
const harnessDir = fileURLToPath(new URL('../', import.meta.url));

let running: RunningServe | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'nexus-serve-search-'));
}

/** 寫一份只改內容搜尋那一列的 patch。 */
async function patch(body: string): Promise<string> {
  const file = join(await tmp(), 'search.patch.yml');
  await writeFile(file, body);
  return file;
}

const OPEN_ON_FIRST_SEARCH = '- id: thread-search\n  config:\n    openAt: first-search\n';

async function start(root: string, patchFile?: string): Promise<RunningServe> {
  running = await runServe({
    argv: [
      '--port',
      '0',
      '--session-log',
      root,
      ...(patchFile === undefined ? [] : ['--patch', patchFile]),
    ],
    log: () => undefined,
    env: {},
  });
  return running as RunningServe;
}

async function stop(server: RunningServe): Promise<void> {
  await server.close();
  running = undefined;
}

async function driveTurn(client: WireClient, threadId: string, prompt: string): Promise<void> {
  const events = await client.openEvents(threadId);
  await client.runStart(threadId, prompt);
  await foldTurn(events);
  await events.return?.(undefined);
}

/** 跑兩條 thread 再關掉：關掉才保證落盤寫完。 */
async function seed(root: string): Promise<void> {
  const server = await start(root);
  const client = await serveClient(server);
  await driveTurn(client, 'alpha', '請幫我修正會話清單的搜尋功能');
  await driveTurn(client, 'beta', '把 README 翻成英文');
  await stop(server);
}

describe('出廠的清單', () => {
  it('不開：沒有會話時回空，有會話時回失敗、講這個部署沒開', async () => {
    const root = await tmp();
    const empty = await serveClient(await start(root));
    expect(await empty.searchThreads('會話')).toEqual({
      kind: 'ok',
      result: { items: [], hasMore: false },
    });
    await stop(running!);

    await seed(root);
    const client = await serveClient(await start(root));
    expect(await client.searchThreads('會話')).toEqual({
      kind: 'rejected',
      code: 'not_supported',
      message: THREAD_SEARCH_DISABLED_MESSAGE,
    });
    // 不合法的查詢講的是查詢，不是沒開：同 dsh 先正規化。
    expect(await client.searchThreads('   ')).toEqual({
      kind: 'rejected',
      code: 'invalid_argument',
      message: '搜尋的 query 不能是空的',
    });
  });

  it('patch 打開之後：serve 寫下的日誌搜得到，句子中間的兩個字也搜得到', async () => {
    const root = await tmp();
    await seed(root);
    const client = await serveClient(await start(root, await patch(OPEN_ON_FIRST_SEARCH)));
    expect(await client.searchThreads('會話')).toEqual({
      kind: 'ok',
      result: {
        hasMore: false,
        items: [{ threadId: 'alpha', snippet: '請幫我修正會話清單的搜尋功能' }],
      },
    });
    expect(await client.searchThreads('readme')).toMatchObject({
      kind: 'ok',
      result: { items: [{ threadId: 'beta' }] },
    });
  });

  it('`disabled: true`：沒掛，沒有會話也回失敗（同 dsh 沒掛 sessionQuery）', async () => {
    const root = await tmp();
    const client = await serveClient(
      await start(root, await patch('- id: thread-search\n  disabled: true\n')),
    );
    expect(await client.searchThreads('會話')).toEqual({
      kind: 'rejected',
      code: 'not_supported',
      message: expect.stringContaining('沒掛會話內容搜尋'),
    });
    expect(await client.searchThreads('')).toEqual({
      kind: 'rejected',
      code: 'invalid_argument',
      message: '搜尋的 query 不能是空的',
    });
  });
});

describe('線上的閘門', () => {
  it('沒帶 content-type 回 415；GET 回 404；body 不是 JSON 回 400', async () => {
    const server = await start(await tmp());
    const cookie = await exchangeServeToken(server.authenticatedUrl);
    const doFetch = fetchWithCookie(cookie);
    const url = `${server.url}${THREAD_SEARCH_PATH}`;
    expect((await doFetch(url, { method: 'POST', body: '{"query":"x"}' })).status).toBe(415);
    const json = { 'content-type': 'application/json' };
    expect((await doFetch(url, { method: 'GET', headers: json })).status).toBe(404);
    expect((await doFetch(url, { method: 'POST', headers: json, body: '{壞' })).status).toBe(400);
  });
});

/**
 * 另起一個 serve 行程，退出時由預載的一行印出 `node:sqlite` 載入過沒有。Node 的 `process.moduleLoadList` 記著載入過的
 * 內建模組，`NativeModule sqlite` 在載入之後才出現（2026-09-27 在 Node 25 實測）。
 */
async function sqliteLoadedAfterSearch(root: string, patchFile?: string): Promise<boolean> {
  const home = process.env[HARNESS_HOME_ENV];
  expect(home).toBeDefined();
  expect(home).not.toBe(join(homedir(), '.nexus-agent'));
  const probe =
    'data:text/javascript,process.on("exit",()=>{process.stderr.write(process.moduleLoadList.includes("NativeModule sqlite")?"\\nSQLITE:loaded\\n":"\\nSQLITE:not-loaded\\n")})';
  const child = spawn(
    process.execPath,
    [
      '--import',
      probe,
      '--import',
      'tsx',
      serveEntry,
      '--port',
      '0',
      '--session-log',
      root,
      ...(patchFile === undefined ? [] : ['--patch', patchFile]),
    ],
    { cwd: harnessDir, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<void>((settle) => child.once('exit', () => settle()));
  try {
    let stdout = '';
    const authenticatedUrl = await new Promise<string>((resolve, reject) => {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
        const match = /nexus-agent 在 (\S+)/u.exec(stdout);
        if (match !== null) resolve(match[1]!);
      });
      void exited.then(() => reject(new Error('serve 沒有起來就結束了')));
    });
    const client = await serveClient({
      url: new URL(authenticatedUrl).origin,
      authenticatedUrl,
    });
    // 有會話可搜：出廠的那一份在這裡回失敗，打開的那一份在這裡載入。兩邊都問到了搜尋那一層。
    const outcome = await client.searchThreads('會話');
    expect(outcome.kind).toBe(patchFile === undefined ? 'rejected' : 'ok');
  } finally {
    child.kill('SIGINT');
    await exited;
  }
  const verdict = /SQLITE:(loaded|not-loaded)/u.exec(stderr)?.[1];
  expect(verdict).toBeDefined();
  return verdict === 'loaded';
}

describe('出廠的清單一次都不載入 node:sqlite', () => {
  it('搜過一次之後照樣沒載入；對照：打開的那一份載入了', async () => {
    const root = await tmp();
    await seed(root);
    expect(await sqliteLoadedAfterSearch(root)).toBe(false);
    expect(await sqliteLoadedAfterSearch(root, await patch(OPEN_ON_FIRST_SEARCH))).toBe(true);
  }, 60_000);
});

/** 落盤窗口拉長（批次窗口裡的留在記憶體）＋內容搜尋打開。 */
const LIVE_ROWS = `- id: session-persistence\n  config:\n    windowMs: 600000\n${OPEN_ON_FIRST_SEARCH}`;

/**
 * 每條 thread 各吃一份腳本、從第一輪開始（重啟續接的也重新從第一輪）。**一輪開頭人打的字在叫模型之前就落盤了**（耐久檢查點），
 * 留在批次窗口裡的是最後一輪的回覆，所以搜的是回覆：第 N 輪回 `REPLIES[N-1]`。
 */
const REPLIES: readonly ScriptedTurn[] = [
  { content: '第一輪的回覆' },
  { content: '第二輪的回覆暗號' },
  { content: '第三輪的回覆暗號' },
];

const scripted: ScriptedServe[] = [];

afterEach(async () => {
  for (const serve of scripted.splice(0)) await serve.close();
});

async function startLive(root: string): Promise<{ serve: ScriptedServe; client: WireClient }> {
  const serve = await startScriptedServe(REPLIES, {
    argv: ['--session-log', root],
    extraRows: LIVE_ROWS,
  });
  scripted.push(serve);
  return { serve, client: await serveClient(serve.running) };
}

async function stopLive(serve: ScriptedServe): Promise<void> {
  scripted.splice(scripted.indexOf(serve), 1);
  await serve.close();
}

/** 這條 thread 第一則收尾回覆的 `messageId`，分叉指名的就是它。 */
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

/** 盤上那一份有沒有回過這句。 */
async function repliedOnDisk(root: string, threadId: string, text: string): Promise<boolean> {
  const session = await findSession(root, threadId);
  if (session === undefined) return false;
  return (await sessionEvents(session)).events.some(
    (event) => event.type === 'assistant/message' && JSON.stringify(event.data).includes(text),
  );
}

/**
 * 正向對照：把盤上那份 header 的 `createdAt` 改掉，搜尋就要被拒——證明活的那一條真的拿記憶體那份 header 去比，
 * 不是拿不到 header 而跳過。比完還原。
 */
async function conflictsWhenDiskHeaderChanges(
  client: WireClient,
  root: string,
  threadId: string,
  query: string,
): Promise<void> {
  const restore = await rewriteSessionHeader(root, threadId, (header) => ({
    ...header,
    createdAt: (header['createdAt'] as number) + 1,
  }));
  try {
    expect(await client.searchThreads(query)).toEqual({
      kind: 'rejected',
      code: 'unknown_error',
      message: expect.stringContaining(`thread "${threadId}" 列表給的 header 與讀到的對不上`),
    });
  } finally {
    await restore();
  }
}

async function hits(client: WireClient, query: string): Promise<string[]> {
  const outcome = await client.searchThreads(query);
  if (outcome.kind !== 'ok') throw new Error(`搜尋失敗：${JSON.stringify(outcome)}`);
  return outcome.result.items.map((item) => item.threadId);
}

describe('活的 thread 讀記憶體（#1599）', () => {
  it('新建的 root 與分叉出來的子 thread、重啟後續接的兩條：批次窗口裡的那一句都搜得到，header 不誤判', async () => {
    const root = await tmp();
    const first = await startLive(root);
    await driveTurn(first.client, 'src', '一');
    // 分叉回傳時子 thread 的檔就在（seed 在回應之前排空）。
    const childId = await forkOk(first.client, 'src', await firstTailId(first.client, 'src'));
    await driveTurn(first.client, childId, '子一');
    await driveTurn(first.client, childId, '子二');
    await driveTurn(first.client, 'src', '二');
    // 前提：兩條第二輪的回覆都還沒寫出去——一律冷讀的話搜不到。
    expect(await repliedOnDisk(root, 'src', '第二輪的回覆暗號')).toBe(false);
    expect(await repliedOnDisk(root, childId, '第二輪的回覆暗號')).toBe(false);
    expect((await hits(first.client, '第二輪的回覆暗號')).sort()).toEqual([childId, 'src'].sort());
    for (const threadId of [childId, 'src']) {
      await conflictsWhenDiskHeaderChanges(first.client, root, threadId, '第二輪的回覆暗號');
    }
    await stopLive(first.serve);

    // 續接：root 的 header 是讀回來的那一份。重啟後腳本從第一輪重來，第三輪的回覆兩條都沒回過。
    const second = await startLive(root);
    for (const threadId of [childId, 'src']) {
      for (const text of ['再一', '再二', '再三']) await driveTurn(second.client, threadId, text);
    }
    expect(await repliedOnDisk(root, 'src', '第三輪的回覆暗號')).toBe(false);
    expect(await repliedOnDisk(root, childId, '第三輪的回覆暗號')).toBe(false);
    expect((await hits(second.client, '第三輪的回覆暗號')).sort()).toEqual([childId, 'src'].sort());
    for (const threadId of [childId, 'src']) {
      await conflictsWhenDiskHeaderChanges(second.client, root, threadId, '第三輪的回覆暗號');
    }
  });

  it('還沒實體化的 thread：搜不到（不進索引），搜過之後磁碟上也沒有多出它的檔', async () => {
    const root = await tmp();
    const { client } = await startLive(root);
    await driveTurn(client, 'seen', '已落盤的話');
    // 讀歷史就把 `fresh` 組起來了（活的、在 `ready` 上），還沒有一輪，批次窗口也還沒到：磁碟上沒有它。
    expect((await client.threadHistory('fresh')).kind).toBe('ok');
    expect(await findSession(root, 'fresh')).toBeUndefined();
    const before = (await sessionsUnder(root)).map((session) => session.header.id).sort();
    expect(before).toEqual(['seen']);

    expect(await hits(client, '已落盤的話')).toEqual(['seen']);
    expect(await findSession(root, 'fresh')).toBeUndefined();
    expect((await sessionsUnder(root)).map((session) => session.header.id).sort()).toEqual(before);
  });
});

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
 */

import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { THREAD_SEARCH_PATH } from '@nexus/wire';
import type { WireClient } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';

import { fetchWithCookie, exchangeServeToken, foldTurn, serveClient } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';
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

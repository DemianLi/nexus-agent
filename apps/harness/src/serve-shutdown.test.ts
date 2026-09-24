/**
 * `serve` 收到 SIGINT 時的收尾（[#599](https://github.com/DemianLi/nexus-agent/issues/599)），對著**另起的
 * 一個行程**量：退出碼與訊號只存在於行程上，同 `cli.test.ts` 的「CLI 行程」那一組（也同它的偏離：
 * 沒有建構產物，用 tsx 跑原始碼入口）。dsh 同型的測試是 `apps/cli/tests/headless-shutdown.e2e.ts`。
 *
 * **直接起 node，不經 `pnpm run serve`**：tsx 的 CLI 會再包一層轉發訊號的父行程，那一層的時序
 * 不是這裡要量的東西，而且讓「送一次」變得不確定。
 *
 * 一輪之中的檢查點本身（模型被叫之前那一份已經寫到後端）釘在 `@nexus/core` 的
 * `session-checkpoint-policy.test.ts`，那裡是確定性的；這一檔量的是整條路接起來之後的結果。
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConversationEntry, ConversationState, WireClient } from '@nexus/wire';
import { appendHumanTurn, emptyConversation, reduceAll, reduceConversation } from '@nexus/wire';
import type { SessionEvent } from '@nexus/core';
import { afterEach, describe, expect, it } from 'vitest';
import { serveClient } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';

const serveEntry = fileURLToPath(new URL('./serve.ts', import.meta.url));
const harnessDir = fileURLToPath(new URL('../', import.meta.url));

let child: ChildProcess | undefined;
let restarted: RunningServe | undefined;

afterEach(async () => {
  if (child !== undefined && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
  }
  child = undefined;
  await restarted?.close();
  restarted = undefined;
});

interface ServeProcess {
  readonly url: string;
  readonly authenticatedUrl: string;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  readonly process: ChildProcess;
}

/** 起一台 serve 行程，等到它印出網址。**網址帶 token，不印、不寫進斷言訊息。** */
async function startServe(root: string): Promise<ServeProcess> {
  // 繼承的 env 帶著 `test-home.setup.ts` 設好的暫存 home；當場確認，不信任它（#424）。
  const home = process.env[HARNESS_HOME_ENV];
  expect(home).toBeDefined();
  expect(home).not.toBe(join(homedir(), '.nexus-agent'));
  const spawned = spawn(
    process.execPath,
    ['--import', 'tsx', serveEntry, '--port', '0', '--session-log', root],
    { cwd: harnessDir, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child = spawned;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((settle) => {
    spawned.once('exit', (code, signal) => void settle({ code, signal }));
  });
  spawned.stderr.resume();
  let stdout = '';
  const authenticatedUrl = await new Promise<string>((resolve, reject) => {
    spawned.stdout.setEncoding('utf8');
    spawned.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      const match = /nexus-agent 在 (\S+)/u.exec(stdout);
      if (match !== null) resolve(match[1]!);
    });
    void exited.then(() => {
      reject(new Error('serve 沒有起來就結束了'));
    });
  });
  return { url: new URL(authenticatedUrl).origin, authenticatedUrl, exited, process: spawned };
}

/** 說一句話，折到這一輪收掉。 */
async function say(client: WireClient, threadId: string, prompt: string): Promise<void> {
  const events = await client.openEvents(threadId);
  await client.runStart(threadId, prompt);
  let state: ConversationState = appendHumanTurn(emptyConversation(), prompt);
  while (state.status === 'running') {
    const next = await events.next();
    if (next.done === true) break;
    state = reduceConversation(state, next.value);
  }
  void events.return?.(undefined).catch(() => undefined);
}

/** 會話根底下那一條 thread 的日誌。 */
async function threadLog(root: string, threadId: string): Promise<readonly SessionEvent[]> {
  const [project] = await readdir(root);
  const path = join(root, project!, `${threadId}.jsonl`);
  return (await readFile(path, 'utf8'))
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as SessionEvent);
}

function line(entry: ConversationEntry): string {
  return entry.kind === 'human' || entry.kind === 'ai' ? `${entry.kind}:${entry.text}` : entry.kind;
}

describe('serve 收到 SIGINT', () => {
  it('一次：排空、關檔之後以 130 結束；重開之後那一輪一顆不少', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-serve-shutdown-'));
    const server = await startServe(root);
    await say(await serveClient(server), 'alpha', '把這句話回聲一次。');
    // 就緒的那一刻立刻送，同 #599 的重現：這時候整輪多半還沒被窗口寫下去。
    server.process.kill('SIGINT');

    expect(await server.exited).toEqual({ code: 130, signal: null });
    const events = await threadLog(root, 'alpha');
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index));
    expect(events[0]?.type).toBe('turn/start');
    expect(events.at(-1)?.type).toBe('turn/end');

    // 重開：同一個目錄、同一條 thread，歷史裡有那句話與回覆。
    const again = await runServe({
      argv: ['--port', '0', '--session-log', root],
      log: () => undefined,
    });
    if (again === undefined) throw new Error('重開沒有起來');
    restarted = again;
    const page = await (await serveClient(again)).threadHistory('alpha');
    if (page.kind !== 'ok') throw new Error(`歷史拿不到：${page.message}`);
    const entries = reduceAll(emptyConversation(), page.result.events).entries.map(line);
    expect(entries[0]).toBe('human:把這句話回聲一次。');
    expect(entries.some((entry) => entry.startsWith('ai:') && entry !== 'ai:')).toBe(true);
  }, 90_000);

  it('收尾中再來一次：當場以 130 結束，使用者那句話已經在日誌裡', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-serve-shutdown-'));
    const server = await startServe(root);
    await say(await serveClient(server), 'beta', '把這句話回聲一次。');
    server.process.kill('SIGINT');
    // 連送兩次會被合成一次（標準訊號不排隊），隔一點再送第二次。
    await new Promise((resolve) => setTimeout(resolve, 5));
    server.process.kill('SIGINT');

    expect(await server.exited).toEqual({ code: 130, signal: null });
    // 第二次可能早於排空、也可能晚於，兩種順序下這一句都要成立：那句話在模型被叫之前就被
    // 檢查點寫下去了。沒有檢查點時這裡會偶發地連檔案都沒有（#599 實測 4 次 1 次）。
    const events = await threadLog(root, 'beta');
    expect(events[0]).toMatchObject({
      type: 'turn/start',
      data: { text: '把這句話回聲一次。' },
    });
  }, 90_000);
});

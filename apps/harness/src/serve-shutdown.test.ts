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
import { mkdtemp, readdir, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConversationEntry, WireClient } from '@nexus/wire';
import { emptyConversation, reduceAll } from '@nexus/wire';
import type { SessionEvent } from '@nexus/core';
import { afterEach, describe, expect, it } from 'vitest';
import { foldTurn, serveClient } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { HOME_LOCK_FILE_NAME, HomeInUseError } from './home-lock.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';
import { sessionEventsOf } from './session-files.fixture.js';

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
  /** 到目前為止收到的 stderr。 */
  stderr(): string;
}

/** 起一台 serve 行程，等到它印出網址。**網址帶 token，不印、不寫進斷言訊息。** */
async function startServe(
  root: string,
  extra: { readonly args?: readonly string[]; readonly env?: Record<string, string> } = {},
): Promise<ServeProcess> {
  // 繼承的 env 帶著 `test-home.setup.ts` 設好的暫存 home；當場確認，不信任它（#424）。
  const home = process.env[HARNESS_HOME_ENV];
  expect(home).toBeDefined();
  expect(home).not.toBe(join(homedir(), '.nexus-agent'));
  const spawned = spawn(
    process.execPath,
    ['--import', 'tsx', serveEntry, '--port', '0', '--session-log', root, ...(extra.args ?? [])],
    { cwd: harnessDir, env: { ...process.env, ...extra.env }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child = spawned;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((settle) => {
    spawned.once('exit', (code, signal) => void settle({ code, signal }));
  });
  let stderr = '';
  spawned.stderr.setEncoding('utf8');
  spawned.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
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
  return {
    url: new URL(authenticatedUrl).origin,
    authenticatedUrl,
    exited,
    process: spawned,
    stderr: () => stderr,
  };
}

/** 說一句話，折到這一輪收掉。 */
async function say(client: WireClient, threadId: string, prompt: string): Promise<void> {
  const events = await client.openEvents(threadId);
  await client.runStart(threadId, prompt);
  await foldTurn(events);
  void events.return?.(undefined).catch(() => undefined);
}

/** 會話根底下那一條 thread 的日誌。 */
async function threadLog(root: string, threadId: string): Promise<readonly SessionEvent[]> {
  const [project] = await readdir(root);
  return sessionEventsOf(join(root, project!), threadId);
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
    // 人送出的話先進送出佇列（#637）：第一顆是送進來的那一顆，緊接著開跑。
    // 在它前面是接上日誌時釘進去的核准政策起始值（#437）。
    expect(events.slice(0, 3).map((event) => event.type)).toEqual([
      'approval/policy',
      'inbox/spliced',
      'turn/start',
    ]);
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
    // 檢查點寫下去了。沒有檢查點時這裡會偶發地連檔案都沒有（#599 實測 4 次 1 次）。送出佇列（#637）之後
    // 它在送進來的當下就落在第一顆 `inbox/spliced` 裡，比開跑的 `turn/start` 還早；就算只來得及寫下這一顆，
    // 重開之後它也停在佇列裡，不會丟。
    const events = await threadLog(root, 'beta');
    expect(events.find((event) => event.type !== 'approval/policy')).toMatchObject({
      type: 'inbox/spliced',
      data: { inserted: [{ text: '把這句話回聲一次。' }] },
    });
  }, 90_000);
});

const probePatch = fileURLToPath(new URL('./fail-loud-probe.patch.yml', import.meta.url));

/** 起一台掛了探針的 serve，說一句話等那一輪收掉（thread 閒著），回行程與探針的三個檔路徑。 */
async function startProbedServe(): Promise<{
  readonly server: ServeProcess;
  readonly marker: string;
  readonly arm: string;
  readonly leak: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'nexus-serve-fail-loud-'));
  const marker = join(root, 'probe.marker');
  const arm = join(root, 'probe.arm');
  const leak = join(root, 'probe.leak');
  const server = await startServe(await mkdtemp(join(tmpdir(), 'nexus-serve-fail-loud-log-')), {
    args: ['--patch', probePatch],
    env: {
      FAIL_LOUD_PROBE_MARKER: marker,
      FAIL_LOUD_PROBE_ARM: arm,
      FAIL_LOUD_PROBE_LEAK: leak,
    },
  });
  // 等那一輪折到 `turn/end` 才算閒著；一輪中途的排空是訊號收尾 5 秒預算的事，不壓在 2 秒裡。
  await say(await serveClient(server), 'idle', '把這句話回聲一次。');
  return { server, marker, arm, leak };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** 診斷那一行的前綴出現幾次（`inspect` 的堆疊會跨行，數前綴不數行）。 */
function labelCount(stderr: string, label: string): number {
  return stderr.split(`nexus-agent serve: ${label}: `).length - 1;
}

describe('serve 遇到未處理的例外（#1501）', () => {
  // 正對照：同一顆探針、同一份 patch、不漏，改送一次 SIGTERM。這一條綠了，下一條「標記檔存在」才有意義。
  it('正對照：SIGTERM 之後以 0 結束，探針的收尾記號存在', async () => {
    const { server, marker, arm } = await startProbedServe();
    await writeFile(arm, '');
    server.process.kill('SIGTERM');

    expect(await server.exited).toEqual({ code: 0, signal: null });
    expect(await exists(marker)).toBe(true);
    expect(labelCount(server.stderr(), 'fatal')).toBe(0);
  }, 90_000);

  it('閒著的 thread 漏一顆 rejection：印一行帶標籤的診斷、走完收尾（記號存在）、以 1 結束', async () => {
    const { server, marker, arm, leak } = await startProbedServe();
    await writeFile(arm, '');
    await writeFile(leak, '');

    expect(await server.exited).toEqual({ code: 1, signal: null });
    const stderr = server.stderr();
    expect(labelCount(stderr, 'fatal load failure')).toBe(1);
    expect(stderr).toContain('fail-loud probe');
    // 收尾真的跑了：Node 預設（沒有 handler）當場結束，這個檔不會在。
    expect(await exists(marker)).toBe(true);
  }, 90_000);
});

/** 同一個 home 的 serve 行程已經結束之後，在這個行程裡起一台（`env` 不給，吃測試的暫存 home，跟子行程同一個）。 */
async function startInProcess(): Promise<RunningServe> {
  const started = await runServe({ argv: ['--port', '0'], log: () => undefined });
  if (started === undefined) throw new Error('runServe 沒有起來');
  restarted = started;
  return started;
}

describe('home 鎖跟著行程走（#1503）', () => {
  it('SIGKILL：什麼都沒收、不刪任何檔，新的 serve 照樣起得來；活著的時候擋得住', async () => {
    const server = await startServe(await mkdtemp(join(tmpdir(), 'nexus-serve-home-lock-')));
    // 子行程活著、握著鎖：同一個 home 的第二台被拒。
    await expect(runServe({ argv: ['--port', '0'], log: () => undefined })).rejects.toThrow(
      HomeInUseError,
    );

    server.process.kill('SIGKILL');
    expect(await server.exited).toEqual({ code: null, signal: 'SIGKILL' });
    // 鎖檔還在（釋放不刪檔），但 kernel 已經放了鎖。
    expect(await exists(join(process.env[HARNESS_HOME_ENV]!, HOME_LOCK_FILE_NAME))).toBe(true);
    await startInProcess();
  }, 90_000);

  it('致命退出（#1501）：行程以 1 結束之後，立刻重啟的新行程拿得到鎖', async () => {
    const { server, arm, leak } = await startProbedServe();
    await writeFile(arm, '');
    await writeFile(leak, '');

    expect(await server.exited).toEqual({ code: 1, signal: null });
    await startInProcess();
  }, 90_000);
});

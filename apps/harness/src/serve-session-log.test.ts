/**
 * `serve` 那條路上的會話日誌落盤——[#174](https://github.com/DemianLi/nexus-agent/issues/174)。
 *
 * CLI 那半在 [`session-log-durability.test.ts`](./session-log-durability.test.ts)，
 * 上游那半在 `@nexus/core` 的 `session-persistence.test.ts`。這一檔只問 `serve` 獨有的
 * 三件事，而三件都不是 CLI 那條路上存在的問題：
 *
 * 1. **一個專案目錄一格、一條 thread 一個檔，重開 server 之後接得回來。** 會話根按目錄分
 *    （照 dsh 的 `projectDir(root, cwd)`，[#251](https://github.com/DemianLi/nexus-agent/issues/251)
 *    拍板的第 3 件），檔名就是 thread id，所以同一條 thread 重開之後找得回自己那一份。CLI 的
 *    root 固定叫 `cli`，放在固定的地方會每次都撞，所以它仍然每次一個 run 目錄。
 * 2. **thread id 是呼叫端給的。** 它會出現在檔名裡，所以兩個壓平後同名的 id 必須落成
 *    兩個檔——不然第二條 thread 的日誌會安靜地消失（`jsonl-session-store.ts` 的
 *    `safeBaseName`）。
 * 3. **披露那一行**：一台正在把每一條 thread 的對話寫上磁碟的 server，畫面上要看得出來。
 */

import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendHumanTurn,
  createWireClient,
  emptyConversation,
  reduceConversation,
} from '@nexus/wire';
import type { ConversationState } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';
import { openJsonlSessionStore, projectKey } from './jsonl-session-store.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';
import type { SessionEvent } from '@nexus/core';

let running: RunningServe | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function tmp(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/** 會話根底下，這個專案的那一格。`runServe` 沒給 `cwd`，所以是這個行程的。 */
function projectDirOf(root: string): string {
  return join(root, projectKey(process.cwd()));
}

/** 會話根底下只有這個專案那一格，回它。 */
async function onlyProjectDir(root: string): Promise<string> {
  expect(await readdir(root)).toEqual([projectKey(process.cwd())]);
  return projectDirOf(root);
}

/**
 * 跑完一整輪，讓 `turn/start` 與 `turn/end` 都落地。
 *
 * 折疊器的 `status` 是收線條件——同 `serve.test.ts` 那條，理由也一樣：這一層沒有
 * 「這一輪完了」的單一封包，有的是折出來的狀態。
 */
async function driveTurn(url: string, threadId: string): Promise<void> {
  const client = createWireClient({ baseUrl: url });
  const events = await client.openEvents(threadId);
  const prompt = '把這句話回聲一次。';
  await client.runStart(threadId, prompt);
  let state: ConversationState = appendHumanTurn(emptyConversation(), prompt);
  while (state.status === 'running') {
    const next = await events.next();
    if (next.done === true) break;
    state = reduceConversation(state, next.value);
  }
  await events.return?.(undefined);
}

function readEvents(body: string): readonly SessionEvent[] {
  return body
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as SessionEvent);
}

describe('serve 的 --session-log', () => {
  it('每條 thread 一個檔，seq 各自從 0 連續', async () => {
    const root = await tmp('nexus-serve-log-');
    running = await runServe({
      argv: ['--port', '0', '--session-log', root],
      log: () => undefined,
      env: {},
    });
    const started = running as RunningServe;
    await driveTurn(started.url, 'alpha');
    await driveTurn(started.url, 'beta');
    // 收線會排空並關檔——落盤的驗收只有在 `close()` 之後才成立。
    await started.close();
    running = undefined;

    const runDir = await onlyProjectDir(root);
    const files = (await readdir(runDir)).filter((name) => name.endsWith('.jsonl')).sort();
    expect(files).toEqual(['alpha.jsonl', 'beta.jsonl']);

    for (const file of files) {
      const events = readEvents(await readFile(join(runDir, file), 'utf8'));
      expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index));
      expect(events.map((event) => event.type)).toContain('turn/start');
      expect(events.map((event) => event.type)).toContain('turn/end');
    }
  });

  it('header 記的是 thread id', async () => {
    const root = await tmp('nexus-serve-log-');
    running = await runServe({
      argv: ['--port', '0', '--session-log', root],
      log: () => undefined,
      env: {},
    });
    const started = running as RunningServe;
    await driveTurn(started.url, 'gamma');
    await started.close();
    running = undefined;

    const runDir = await onlyProjectDir(root);
    const header = JSON.parse(await readFile(join(runDir, 'gamma.header.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(header.id).toBe('gamma');
    expect(header.parentSession).toBeUndefined();
  });

  /**
   * **這一條擋的是把 `wx` 誤當成護欄。**
   *
   * `thread id` 從 `/threads/:id/...` 進來，是呼叫端給的。舊的壓平規則把每個不在
   * `[A-Za-z0-9._-]` 裡的字元換成 `_`，而 `~` 在 URL 路徑段裡是合法的 unreserved
   * 字元——於是 `a~b` 與 `a_b`（線上兩條不同的 thread）壓成同一個檔名，第二條的第一次
   * 寫入撞上 `open(..., 'wx')` 而失敗。**而協調器按設計吞掉那個失敗**（暫停自動路徑、
   * 一行 warn），所以那條 thread 的日誌就這麼沒了，沒有人會發現。
   *
   * `wx` 那條拒絕是留給「未來的 resume 誤開了已存的會話」的絆索
   * （`session-store.ts` 檔頭），不是拿來擋這個的。
   */
  it('壓平後同名的兩條 thread 各自落成一個檔', async () => {
    const root = await tmp('nexus-serve-log-');
    running = await runServe({
      argv: ['--port', '0', '--session-log', root],
      log: () => undefined,
      env: {},
    });
    const started = running as RunningServe;
    await driveTurn(started.url, 'a~b');
    await driveTurn(started.url, 'a_b');
    await started.close();
    running = undefined;

    const runDir = await onlyProjectDir(root);
    const files = (await readdir(runDir)).filter((name) => name.endsWith('.jsonl'));
    expect(files).toHaveLength(2);
    // 兩個檔都真的有內容——「開得起來」與「寫得進去」是兩件事。
    for (const file of files) {
      expect(readEvents(await readFile(join(runDir, file), 'utf8')).length).toBeGreaterThan(0);
    }
  });

  it('沒給旗標就什麼都不落盤，而且畫面上講得出來', async () => {
    const lines: string[] = [];
    running = await runServe({
      argv: ['--port', '0'],
      log: (line) => lines.push(line),
      env: {},
    });
    await driveTurn((running as RunningServe).url, 'delta');
    expect(lines.join('\n')).toContain('會話日誌：只在記憶體裡');
    expect(lines.join('\n')).toContain('--session-log');
  });

  it('給了旗標就把落腳處印出來', async () => {
    const root = await tmp('nexus-serve-log-');
    const lines: string[] = [];
    running = await runServe({
      argv: ['--port', '0', '--session-log', root],
      log: (line) => lines.push(line),
      env: {},
    });
    // 印的要是**那一格**，不只是根：根是那一格的前綴，斷言根的話印哪一個都綠。
    expect(lines.join('\n')).toContain(`會話日誌：${projectDirOf(root)}`);
  });

  it('--session-log 不能落在 --workspace 底下', async () => {
    const workspace = await tmp('nexus-serve-ws-');
    await expect(
      runServe({
        argv: ['--port', '0', '--workspace', workspace, '--session-log', join(workspace, 'logs')],
        log: () => undefined,
        env: {},
      }),
    ).rejects.toThrow('--session-log 不能在 --workspace 底下');
  });

  it('--session-log 給空字串是錯的，不是「沒給」', async () => {
    await expect(
      runServe({ argv: ['--port', '0', '--session-log', '  '], log: () => undefined, env: {} }),
    ).rejects.toThrow('--session-log 要給一個目錄路徑');
  });
});

/**
 * 重開 server、同一條 thread——serve 那一半的續接（照 dsh：碰到一個已存的 session id 就
 * resume）。回來的是住在日誌上的那一半，對話照舊從頭開始（門 B 不開）。
 *
 * **失敗的那幾條都要斷言兩件事**：這條 thread 起不來，而且檔案一個位元組都沒動。只斷言
 * 前一件的話，「退到新開、撞上 `wx`、被收成一行 warn」那條路一樣起不來——而那正是要擋的
 * 靜默遺失。
 */
describe('重開 server 之後接得回同一條 thread', () => {
  async function start(root: string, extra: readonly string[] = []): Promise<RunningServe> {
    running = await runServe({
      argv: ['--port', '0', '--session-log', root, ...extra],
      log: () => undefined,
      env: {},
    });
    return running as RunningServe;
  }

  async function stop(server: RunningServe): Promise<void> {
    await server.close();
    running = undefined;
  }

  function count(events: readonly SessionEvent[], type: string): number {
    return events.filter((event) => event.type === type).length;
  }

  it('同一個 thread id：同一個檔接著寫，seq 連續，中間只有一顆 end-seed', async () => {
    const root = await tmp('nexus-serve-resume-');
    const first = await start(root);
    await driveTurn(first.url, 'alpha');
    await stop(first);
    const second = await start(root);
    await driveTurn(second.url, 'alpha');
    await stop(second);

    const dir = await onlyProjectDir(root);
    expect((await readdir(dir)).filter((name) => name.endsWith('.jsonl'))).toEqual(['alpha.jsonl']);
    const events = readEvents(await readFile(join(dir, 'alpha.jsonl'), 'utf8'));
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index));
    expect(count(events, 'session/end-seed')).toBe(1);
    expect(count(events, 'turn/start')).toBe(2);
  });

  it('日誌壞了：這條 thread 起不來，檔案一個位元組都沒動', async () => {
    const root = await tmp('nexus-serve-resume-');
    const first = await start(root);
    await driveTurn(first.url, 'alpha');
    await stop(first);
    const log = join(projectDirOf(root), 'alpha.jsonl');
    const lines = (await readFile(log, 'utf8')).split('\n');
    lines[0] = '{壞的';
    await writeFile(log, lines.join('\n'));
    const before = await readFile(log, 'utf8');

    const second = await start(root);
    await expect(driveTurn(second.url, 'alpha')).rejects.toThrow();
    await stop(second);
    expect(await readFile(log, 'utf8')).toBe(before);
  });

  it('別的把手握著：起不來；它放了之後同一台 server 重試接得回來', async () => {
    const root = await tmp('nexus-serve-resume-');
    const first = await start(root);
    await driveTurn(first.url, 'alpha');
    await stop(first);
    const holder = await openJsonlSessionStore({ directory: projectDirOf(root) }).resume('alpha');

    const second = await start(root);
    await expect(driveTurn(second.url, 'alpha')).rejects.toThrow();
    await holder.stored.close();
    await driveTurn(second.url, 'alpha');
    await stop(second);

    const events = readEvents(await readFile(join(projectDirOf(root), 'alpha.jsonl'), 'utf8'));
    expect(count(events, 'turn/start')).toBe(2);
  });

  /**
   * **租約在失敗時放掉了。** 目錄比對在讀回之後、已經拿了租約；擋下之後沒放的話，同一台
   * server 下一次請求（`wire-handler.ts` 說好的重試）撞上的是自己上一次留下的租約。
   */
  it('目錄對不上：擋下；改回來之後同一台 server 重試接得回來', async () => {
    const root = await tmp('nexus-serve-resume-');
    const first = await start(root);
    await driveTurn(first.url, 'alpha');
    await stop(first);
    const headerPath = join(projectDirOf(root), 'alpha.header.json');
    const good = await readFile(headerPath, 'utf8');
    await writeFile(headerPath, JSON.stringify({ ...JSON.parse(good), cwd: '/別的地方' }));
    const log = join(projectDirOf(root), 'alpha.jsonl');
    const before = await readFile(log, 'utf8');

    const second = await start(root);
    await expect(driveTurn(second.url, 'alpha')).rejects.toThrow();
    expect(await readFile(log, 'utf8')).toBe(before);
    await writeFile(headerPath, good);
    await driveTurn(second.url, 'alpha');
    await stop(second);
  });

  it('沙箱模式跟著回來；日誌記著模式而這一次沒給 --workspace：擋下', async () => {
    const root = await tmp('nexus-serve-resume-');
    const workspace = await tmp('nexus-serve-resume-ws-');
    const first = await start(root, ['--workspace', workspace]);
    const client = createWireClient({ baseUrl: first.url });
    await client.slashRun('alpha', '/sandbox read-only');
    await stop(first);

    const bare = await start(root);
    // 建不起這條 thread 是協定層的錯（`wire-handler.ts` 的 `threadOrError`）：斜線命令回
    // `rejected`，不是拋。原因要講到 `--workspace`——那是人唯一改得動的東西。
    const refused = await createWireClient({ baseUrl: bare.url }).slashRun('alpha', '/sandbox');
    expect(refused).toMatchObject({ kind: 'rejected' });
    expect(JSON.stringify(refused)).toContain('--workspace');
    await stop(bare);

    const second = await start(root, ['--workspace', workspace]);
    const reported = await createWireClient({ baseUrl: second.url }).slashRun('alpha', '/sandbox');
    await stop(second);
    // 前提：預設是 workspace-write，所以看得到 read-only 才證明是從日誌回來的。
    expect(JSON.stringify(reported)).toContain('read-only');
  });
});

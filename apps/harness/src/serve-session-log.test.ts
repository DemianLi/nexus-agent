/**
 * `serve` 那條路上的會話日誌落盤——[#174](https://github.com/DemianLi/nexus-agent/issues/174)。
 *
 * CLI 那半在 [`session-log-durability.test.ts`](./session-log-durability.test.ts)，
 * 上游那半在 `@nexus/core` 的 `session-persistence.test.ts`。這一檔只問 `serve` 獨有的
 * 三件事，而三件都不是 CLI 那條路上存在的問題：
 *
 * 1. **一個行程一個 run 目錄、一條 thread 一個檔。** CLI 的 root 固定叫 `cli`，
 *    只有一條；`serve` 有幾條 thread 就有幾份日誌。
 * 2. **thread id 是呼叫端給的。** 它會出現在檔名裡，所以兩個壓平後同名的 id 必須落成
 *    兩個檔——不然第二條 thread 的日誌會安靜地消失（`jsonl-session-store.ts` 的
 *    `safeBaseName`）。
 * 3. **披露那一行**：一台正在把每一條 thread 的對話寫上磁碟的 server，畫面上要看得出來。
 */

import { mkdtemp, readdir, readFile } from 'node:fs/promises';
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

/** run 目錄底下唯一的那一個。 */
async function onlyRunDir(root: string): Promise<string> {
  const entries = await readdir(root);
  expect(entries).toHaveLength(1);
  return join(root, entries[0]!);
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

    const runDir = await onlyRunDir(root);
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

    const runDir = await onlyRunDir(root);
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

    const runDir = await onlyRunDir(root);
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
    expect(lines.join('\n')).toContain(`會話日誌：${root}`);
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

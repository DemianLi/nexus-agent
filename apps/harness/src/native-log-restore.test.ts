/**
 * native 下對話只從日誌推（[#2360](https://github.com/DemianLi/nexus-agent/issues/2360)）：serve `--agent-loop native` 不建 checkpointer，
 * 一條 thread 的 state 是那個 agent 行程內的快取。快取不在的時候——重啟之後、閒置逐出之後——下一輪只能從落盤的日誌灌回。
 * 冷復活（背景子代理）那一格在 `background-cold-e2e.test.ts`，per-thread 的在 `per-thread.integration.test.ts`。
 *
 * 每一條同時看兩件事：
 *
 * - **走的是「快取是空的、只靠日誌」那條路**：`NativeAgent.seedThread` 只收快取是空的 thread（不是空的就拋），所以它在新開的那一刻被呼叫、
 *   沒拋，就是快取是空的、對話從日誌來。
 * - **灌回的是對的那一份**：下一輪送到模型的請求裡帶著前一輪的人話與回覆（假 OpenAI 端點收到的 body）。
 *
 * **零憑證、零外部連線**：模型是本機的假端點。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NativeAgent } from '@nexus/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { bodyLog, foldTurn, serveClient } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { fakeEndpoint, hasTools, liveModelPatch, mainOnly } from './log-derived-history.fixture.js';
import type { FakeEndpoint, WireMessage } from './log-derived-history.fixture.js';
import { runServe } from './serve-run.js';
import type { RunningServe } from './serve-run.js';

vi.stubEnv('NVIDIA_API_KEY', 'nvapi-fake-for-native-log-restore');

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const EVICT_ROWS = '- id: thread-capacity\n  config:\n    idleEvictAfterMs: 50\n';

interface Rig {
  readonly upstream: FakeEndpoint;
  /** 每次起 serve 印出來的行，跨重啟累計。 */
  readonly lines: string[];
  start(): Promise<RunningServe>;
}

/** 假端點、home、日誌目錄與 patch；`start` 每次起一台新的 serve，讀同一個日誌目錄。 */
async function rig(extraRows = ''): Promise<Rig> {
  const upstream = await fakeEndpoint(
    mainOnly((k) => ({ content: `第 ${k} 次回覆` })),
    true,
  );
  cleanups.push(() => upstream.close());
  const home = await mkdtemp(join(tmpdir(), 'nexus-native-restore-home-'));
  const logs = await mkdtemp(join(tmpdir(), 'nexus-native-restore-logs-'));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  cleanups.push(() => rm(logs, { recursive: true, force: true }));
  const patch = join(home, 'patch.yml');
  await writeFile(patch, liveModelPatch(upstream.baseURL, extraRows), { mode: 0o600 });
  const lines: string[] = [];
  return {
    upstream,
    lines,
    async start() {
      const running = (await runServe({
        argv: [
          '--port',
          '0',
          '--live',
          '--agent-loop',
          'native',
          '--session-log',
          logs,
          '--patch',
          patch,
        ],
        log: bodyLog(lines),
        env: { [HARNESS_HOME_ENV]: home },
      })) as RunningServe;
      cleanups.push(() => running.close());
      return running;
    },
  };
}

/** 開一條下行說一句話，等 root 收尾，再用 signal 放掉下行（`return()` 不取消本文，連線會留著）。 */
async function say(server: RunningServe, thread: string, prompt: string): Promise<void> {
  const client = await serveClient(server);
  const downlink = new AbortController();
  const events = await client.openEvents(thread, { signal: downlink.signal });
  await client.runStart(thread, prompt);
  await foldTurn(events);
  downlink.abort();
  await events.return?.(undefined).catch(() => undefined);
}

function textOf(message: WireMessage): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return JSON.stringify(message.content ?? '');
  return (message.content as { type?: unknown; text?: unknown }[])
    .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('');
}

/** 主呼叫裡最後一則人話是 `prompt` 的那一次，回它每一則的角色與文字。 */
function requestFor(upstream: FakeEndpoint, prompt: string): string[] {
  const body = upstream.bodies.findLast(
    (candidate) => hasTools(candidate) && textOf(candidate.messages.at(-1)!).includes(prompt),
  );
  if (body === undefined) throw new Error(`模型沒收到「${prompt}」那一次`);
  return body.messages
    .filter((message) => message.role !== 'system')
    .map((message) => `${message.role}:${textOf(message)}`);
}

/** 這條 thread 被 `seedThread` 灌了幾次；每一次都沒拋（快取是空的）。 */
function seedsOf(spy: ReturnType<typeof spyOnSeed>, thread: string): number {
  const at = spy.mock.calls.flatMap(([config], index) =>
    config.configurable?.['thread_id'] === thread ? [index] : [],
  );
  for (const index of at) expect(spy.mock.results[index]?.type).toBe('return');
  return at.length;
}

const spyOnSeed = () => vi.spyOn(NativeAgent.prototype, 'seedThread');

async function until(predicate: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!predicate()) throw new Error('等太久了');
}

describe('serve --agent-loop native：快取不在時對話只從日誌來（#2360）', () => {
  it('重啟續聊：新的一台開同一條 thread，從日誌灌回，下一輪模型收到重啟之前的人話與回覆', async () => {
    const seed = spyOnSeed();
    const r = await rig();
    const first = await r.start();
    await say(first, 'restart', '暗號是藍鯨');
    // 前提：第一次開的時候日誌是空的，沒有東西可灌。
    expect(seedsOf(seed, 'restart')).toBe(0);
    await first.close();

    const second = await r.start();
    await say(second, 'restart', '剛才的暗號是什麼');
    expect(seedsOf(seed, 'restart')).toBe(1);
    expect(requestFor(r.upstream, '剛才的暗號是什麼')).toEqual([
      expect.stringContaining('暗號是藍鯨'),
      'assistant:第 0 次回覆',
      expect.stringContaining('剛才的暗號是什麼'),
    ]);
  }, 60_000);

  it('閒置逐出後回來：撤掉的 thread 再開，從日誌灌回，下一輪模型收到撤之前的人話與回覆', async () => {
    const seed = spyOnSeed();
    const r = await rig(EVICT_ROWS);
    const server = await r.start();
    await say(server, 'evicted', '暗號是虎鯨');
    expect(seedsOf(seed, 'evicted')).toBe(0);
    await until(() => r.lines.some((line) => line.startsWith('[閒置逐出] thread "evicted"')));

    await say(server, 'evicted', '撤之前的暗號是什麼');
    expect(seedsOf(seed, 'evicted')).toBe(1);
    expect(requestFor(r.upstream, '撤之前的暗號是什麼')).toEqual([
      expect.stringContaining('暗號是虎鯨'),
      'assistant:第 0 次回覆',
      expect.stringContaining('撤之前的暗號是什麼'),
    ]);
  }, 60_000);

  it('對照：沒撤也沒重啟，同一台的第二輪不再灌（快取在），模型照樣收到上一輪', async () => {
    const seed = spyOnSeed();
    const r = await rig();
    const server = await r.start();
    await say(server, 'warm', '暗號是座頭鯨');
    await say(server, 'warm', '暗號是什麼');
    expect(seedsOf(seed, 'warm')).toBe(0);
    expect(requestFor(r.upstream, '暗號是什麼')).toEqual([
      expect.stringContaining('暗號是座頭鯨'),
      'assistant:第 0 次回覆',
      expect.stringContaining('暗號是什麼'),
    ]);
  }, 60_000);
});

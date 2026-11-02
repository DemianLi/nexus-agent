/**
 * **插件宣告的會話投影，即時與重新整理之後長出同一份**——[#1026](https://github.com/DemianLi/nexus-agent/issues/1026) 的驗收。
 *
 * 走產品組裝：真的 `runServe`、真的 handler、真的 client，玩具插件（`projection-toy.fixture.ts`）用 `--patch` 插進出貨清單。
 * 玩具投影的 key 不在 `thread-pump.ts`、`conversation-history.ts`、`conversation.ts` 的任何一處——它能長進 web 的
 * `projections`，就證明新增一個投影不必動那三處的逐種分支。
 *
 * 量的是：
 * 1. **baseline**：還沒有任何相關事件時，歷史最新一頁已經帶了這個 key（初值不平凡）。
 * 2. **即時**：每打一次斜線命令，下行多一顆 `projection` frame，折出來的值跟歷史一致。
 * 3. **冷 thread**：server 重開之後，第一次開這條 thread 的歷史（還沒有任何即時 frame）就有目前的值——單元清單不只綁在某個
 *    活著的 pump 上。
 * 4. **`disabled: true`**：投影整個消失（下行、歷史都沒有），其他一切照舊。
 * 5. `stateVersion` 隨 frame 送出，即時與歷史是同一個。
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AIMessage } from '@langchain/core/messages';
import { PROJECTION_KEY_PATTERN, SessionLog, toLoggedMessage } from '@nexus/core';
import type { ProjectionUnit } from '@nexus/core';
import { PLAN_COMMAND_NAME } from '@nexus/plugin-plan-mode';
import type { Event, WireClient } from '@nexus/wire';
import {
  emptyConversation,
  PROJECTION,
  PROJECTION_KEY_PATTERN as WIRE_KEY_PATTERN,
  reduceAll,
} from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';

import { historyPage } from './conversation-history.js';
import { serveClient } from './fixtures.js';
import { TOY_PROJECTION_KEY, TOY_PROJECTION_VERSION, toyUnit } from './projection-toy.fixture.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';
import type { PumpAgent } from './thread-pump.js';
import { ThreadPump } from './thread-pump.js';

const TOY = fileURLToPath(new URL('./projection-toy.patch.yml', import.meta.url));
const TOY_DISABLED = fileURLToPath(new URL('./projection-toy-disabled.patch.yml', import.meta.url));

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** 折出 `projections` 這一格。 */
const projectionsOf = (frames: readonly Event[]) =>
  reduceAll(emptyConversation(), frames).projections;

/** 這串 frame 裡的 `projection` frame 酬載，照收到的先後。 */
const projectionPayloads = (frames: readonly Event[]) =>
  frames
    .filter((frame) => frame.method === 'custom')
    .map((frame) => frame.params.data as { name: string; payload: unknown })
    .filter((data) => data.name === PROJECTION)
    .map((data) => data.payload);

let running: RunningServe | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function start(root: string, patch: string): Promise<RunningServe> {
  const server = (await runServe({
    argv: ['--port', '0', '--session-log', root, '--patch', patch],
    log: () => {},
    env: {},
  })) as RunningServe;
  running = server;
  return server;
}

/** 這條 thread 的歷史最新一頁折出的 `projections`。 */
async function refreshed(client: WireClient, threadId: string) {
  const outcome = await client.threadHistory(threadId);
  if (outcome.kind !== 'ok') throw new Error(`歷史沒拿到：${JSON.stringify(outcome)}`);
  return projectionsOf(outcome.result.events);
}

/** 等下行追上：`projection` frame 收到第 `count` 顆。 */
async function untilProjectionFrames(frames: readonly Event[], count: number): Promise<void> {
  for (let tries = 0; tries < 400 && projectionPayloads(frames).length < count; tries += 1) {
    await settle();
  }
}

/** 開下行並在背景抽進陣列。 */
async function follow(client: WireClient, threadId: string): Promise<Event[]> {
  const frames: Event[] = [];
  const events = await client.openEvents(threadId);
  void (async () => {
    try {
      for await (const frame of events) frames.push(frame);
    } catch {
      // server 收掉時下行會斷，不是測試要量的事。
    }
  })();
  return frames;
}

describe('玩具投影端到端', () => {
  it('baseline 在任何相關事件之前就有；每打一次命令即時多一顆；重新整理長出同一份', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-projection-'));
    const server = await start(root, TOY);
    const client = await serveClient(server);
    const live = await follow(client, 't');

    // 前提：一個命令都還沒打。歷史（= baseline）已經帶了這個 key、初值、版本。
    const baseline = await refreshed(client, 't');
    expect(baseline).toEqual({
      [TOY_PROJECTION_KEY]: {
        version: TOY_PROJECTION_VERSION,
        view: { commands: 0, label: '玩具' },
      },
    });
    // 對照：即時這一側不在 subscribe 時補 baseline（值由歷史的最新一頁送）。
    expect(projectionPayloads(live)).toEqual([]);

    await client.slashRun('t', `/${PLAN_COMMAND_NAME}`);
    await untilProjectionFrames(live, 1);
    expect(projectionPayloads(live)).toEqual([
      { key: TOY_PROJECTION_KEY, version: 3, view: { commands: 1, label: '玩具' } },
    ]);
    expect(projectionsOf(live)).toEqual(await refreshed(client, 't'));

    await client.slashRun('t', `/${PLAN_COMMAND_NAME} off`);
    await untilProjectionFrames(live, 2);
    expect(projectionsOf(live)[TOY_PROJECTION_KEY]).toEqual({
      version: 3,
      view: { commands: 2, label: '玩具' },
    });
    expect(projectionsOf(live)).toEqual(await refreshed(client, 't'));
  });

  it('冷 thread：server 重開之後，第一次開歷史就有目前的值', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-projection-cold-'));
    const first = await start(root, TOY);
    const before = await serveClient(first);
    await before.slashRun('t', `/${PLAN_COMMAND_NAME}`);
    await before.slashRun('t', `/${PLAN_COMMAND_NAME} off`);
    await first.close();
    running = undefined;

    // 另一台 server、另一個行程狀態：還沒有任何即時 frame，歷史就要帶目前的值（包含續接前那一段）。
    const second = await start(root, TOY);
    const after = await serveClient(second);
    expect(await refreshed(after, 't')).toEqual({
      [TOY_PROJECTION_KEY]: { version: 3, view: { commands: 2, label: '玩具' } },
    });

    // 接上之後的第一顆命令接著數，不是從 0 起跳（pump 接上日誌時 seed，不發 frame）。
    const live = await follow(after, 't');
    await after.slashRun('t', `/${PLAN_COMMAND_NAME}`);
    await untilProjectionFrames(live, 1);
    expect(projectionPayloads(live)).toEqual([
      { key: TOY_PROJECTION_KEY, version: 3, view: { commands: 3, label: '玩具' } },
    ]);
  });

  it('disabled: true：投影整個消失，命令與其他 frame 照舊', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-projection-off-'));
    const server = await start(root, TOY_DISABLED);
    const client = await serveClient(server);
    const live = await follow(client, 't');

    expect(await refreshed(client, 't')).toEqual({});
    const ran = await client.slashRun('t', `/${PLAN_COMMAND_NAME}`);
    // 對照：產品路徑沒壞——命令照常跑，計劃模式的 frame 照常來。
    expect(ran.kind).not.toBe('error');
    for (
      let tries = 0;
      tries < 400 && reduceAll(emptyConversation(), live).planMode === null;
      tries += 1
    ) {
      await settle();
    }
    expect(projectionPayloads(live)).toEqual([]);
    expect(projectionsOf(live)).toEqual({});
    expect(reduceAll(emptyConversation(), live).planMode).toEqual({ active: true });
    expect(await refreshed(client, 't')).toEqual({});
  });
});

/** 在 `command/run` 上拋的單元。 */
const thrower: ProjectionUnit<number, number> = {
  key: 'thrower',
  stateVersion: 0,
  init: () => 0,
  apply: (state, event) => {
    if (event.type === 'command/run') throw new Error('壞掉的投影');
    return state;
  },
  view: (state) => state,
};

const COMMAND = { commandId: 'c1', name: 'plan', source: { kind: 'user' } } as const;

describe('單元拋錯只停用自己', () => {
  it('即時：壞的那個送一顆 failed、別的照常、之後不再重送；伺服器日誌講一次', async () => {
    const warnings: string[] = [];
    const pump = new ThreadPump(
      {} as PumpAgent,
      'proj-throw',
      undefined,
      undefined,
      undefined,
      undefined,
      (message) => void warnings.push(message),
      false,
      undefined,
      [thrower, toyUnit],
    );
    const frames: Event[] = [];
    const line = new AbortController();
    const draining = (async () => {
      for await (const frame of pump.subscribe(['custom'], line.signal)) frames.push(frame);
    })();
    pump.sessionLog.append('command/run', COMMAND);
    pump.sessionLog.append('command/run', { ...COMMAND, commandId: 'c2' });
    await untilProjectionFrames(frames, 3);
    await settle();

    expect(projectionPayloads(frames)).toEqual([
      { key: 'thrower', version: 0, view: null, failed: true },
      { key: TOY_PROJECTION_KEY, version: 3, view: { commands: 1, label: '玩具' } },
      { key: TOY_PROJECTION_KEY, version: 3, view: { commands: 2, label: '玩具' } },
    ]);
    expect(warnings.filter((message) => message.includes('"thrower"'))).toHaveLength(1);
    // 折出來：壞的那格是失敗，好的那格照常。
    expect(projectionsOf(frames)).toEqual({
      thrower: { version: 0, view: null, failed: true },
      [TOY_PROJECTION_KEY]: { version: 3, view: { commands: 2, label: '玩具' } },
    });
    line.abort();
    pump.close();
    await draining;
  });
});

describe('歷史頁', () => {
  const units = [toyUnit, thrower];

  it('空日誌也每個單元一筆（baseline），壞的那個是 failed 的初始（init 沒拋，所以是好的值）', () => {
    const page = historyPage([], {}, undefined, undefined, undefined, undefined, units);
    expect(projectionsOf(page.events)).toEqual({
      [TOY_PROJECTION_KEY]: { version: 3, view: { commands: 0, label: '玩具' } },
      thrower: { version: 0, view: 0 },
    });
  });

  it('折壞的單元在歷史也是 failed，與即時同一格', () => {
    const log = new SessionLog('hist-throw');
    log.append('command/run', COMMAND);
    const page = historyPage(
      [...log.events],
      {},
      undefined,
      undefined,
      undefined,
      undefined,
      units,
    );
    expect(projectionsOf(page.events)).toEqual({
      [TOY_PROJECTION_KEY]: { version: 3, view: { commands: 1, label: '玩具' } },
      thrower: { version: 0, view: null, failed: true },
    });
  });

  it('只在最新一頁：往前翻的較舊頁不帶（免得把新的蓋回舊的）', () => {
    const log = new SessionLog('hist-pages');
    for (const text of ['一', '二', '三']) {
      log.append('turn/start', { kind: 'message', text });
      log.append('assistant/message', {
        message: toLoggedMessage(new AIMessage(text)),
      });
      log.append('turn/end', {});
    }
    const events = [...log.events];
    const latest = historyPage(
      events,
      { maxMessages: 1 },
      undefined,
      undefined,
      undefined,
      undefined,
      units,
    );
    expect(latest.hasMore).toBe(true);
    expect(Object.keys(projectionsOf(latest.events))).toContain(TOY_PROJECTION_KEY);
    const older = historyPage(
      events,
      { maxMessages: 1, beforeSeq: latest.firstSeq, throughSeq: latest.throughSeq },
      undefined,
      undefined,
      undefined,
      undefined,
      units,
    );
    expect(projectionsOf(older.events)).toEqual({});
  });
});

describe('key 格式', () => {
  it('wire 複製的那份和 core 的逐字相同（wire 不 import core 的值，所以由這裡釘住）', () => {
    expect(String(WIRE_KEY_PATTERN)).toBe(String(PROJECTION_KEY_PATTERN));
  });
});

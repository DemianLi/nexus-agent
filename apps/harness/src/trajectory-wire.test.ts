/**
 * **軌跡投影走真的產品路徑**——[#1027](https://github.com/DemianLi/nexus-agent/issues/1027) 的驗收。
 *
 * 真的 `runServe`、真的 handler、真的 client，出貨清單上掛的 `trajectory`（不是測試插進去的）。量四件事：
 *
 * 1. **即時 = 歷史**：下行收到的最後一顆 `trajectory`／`request-snapshots` 投影，跟同一條 thread 重新整理之後歷史帶的是同一份。
 * 2. **回答得出關於這一輪的問題**：幾次模型呼叫、哪個工具、成不成、花多久——全從 view 讀，不必去翻日誌。
 * 3. **只觀察**：把 `trajectory` 關掉，除了那兩顆投影 frame 以外，下行與歷史逐位元組不變。
 * 4. **view 不帶內文**：使用者原話只以有上限的預覽出現，不會整份再送一次。
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Event, WireClient } from '@nexus/wire';
import {
  emptyConversation,
  PROJECTION,
  reduceAll,
  TRAJECTORY_PREVIEW_CHARS,
  TRAJECTORY_PROJECTION,
  REQUEST_SNAPSHOTS_PROJECTION,
  TRAJECTORY_DETAIL_TURNS,
  TOKEN_METER_PROJECTION,
} from '@nexus/wire';
import type { RequestSnapshotsView, TrajectoryView } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';

import { serveClient } from './fixtures.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';

const DISABLED = fileURLToPath(new URL('./trajectory-disabled.patch.yml', import.meta.url));
const METER_DISABLED = fileURLToPath(new URL('./token-meter-disabled.patch.yml', import.meta.url));

let running: RunningServe | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function start(root: string, patch?: string): Promise<RunningServe> {
  const server = (await runServe({
    argv: [
      '--port',
      '0',
      '--session-log',
      root,
      ...(patch === undefined ? [] : ['--patch', patch]),
    ],
    log: () => {},
    env: {},
  })) as RunningServe;
  running = server;
  return server;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** 開下行，說一句話，等到 root 收尾之後再多等一會兒（投影 frame 跟在收尾事件之後）。 */
async function sayAndCollect(
  client: WireClient,
  threadId: string,
  prompt: string,
): Promise<Event[]> {
  const frames: Event[] = [];
  const events = await client.openEvents(threadId);
  let done = false;
  void (async () => {
    try {
      for await (const frame of events) {
        frames.push(frame);
        const data = frame.params.data as { event?: unknown; graph_name?: unknown } | null;
        if (
          frame.method === 'lifecycle' &&
          frame.params.namespace.length === 0 &&
          data?.graph_name === 'root' &&
          (data.event === 'completed' || data.event === 'failed')
        ) {
          done = true;
        }
      }
    } catch {
      // server 收掉時下行會斷。
    }
  })();
  await client.runStart(threadId, prompt);
  for (let tries = 0; tries < 2000 && !done; tries += 1) await settle();
  // 收尾之後還有 `turn/end` 等事件的投影 frame 在路上：等到軌跡那一顆說這一輪收了（或等不到就讓斷言去講）。
  const closed = () =>
    frames.some((frame) => {
      if (!isProjection(frame)) return false;
      const payload = (frame.params.data as { payload: { key: string; view: TrajectoryView } })
        .payload;
      return (
        payload.key === TRAJECTORY_PROJECTION && payload.view?.turns?.at(-1)?.end !== undefined
      );
    });
  for (let tries = 0; tries < 300 && !closed(); tries += 1)
    await new Promise((r) => setTimeout(r, 10));
  // 不呼叫 `events.return`：背景那個 `for await` 還掛著一個 `next()`，async generator 的 return 會排在它後面等到天荒地老。
  // 下行由 server 收掉時結束（`afterEach`）。
  return frames;
}

async function historyFrames(client: WireClient, threadId: string): Promise<Event[]> {
  const outcome = await client.threadHistory(threadId);
  if (outcome.kind !== 'ok') throw new Error(`歷史沒拿到：${JSON.stringify(outcome)}`);
  return [...outcome.result.events];
}

/** 這串 frame 裡最後一顆軌跡投影的 view。 */
const latestTrajectory = (frames: readonly Event[]): TrajectoryView | undefined =>
  frames
    .filter(isProjection)
    .map(
      (frame) => (frame.params.data as { payload: { key: string; view: TrajectoryView } }).payload,
    )
    .filter((payload) => payload.key === TRAJECTORY_PROJECTION)
    .at(-1)?.view;

const isProjection = (frame: Event) =>
  frame.method === 'custom' && (frame.params.data as { name?: string } | null)?.name === PROJECTION;

/**
 * 去掉投影 frame 之後的下行／歷史，抹掉兩次跑法本來就不同的東西，拿來比「除了投影以外是否一模一樣」。
 *
 * 抹掉的：傳輸 `seq`／`event_id`（少了投影 frame 就會往前挪）、時間戳、隨機 id（uuid 形狀的）、耗時。
 * 其餘——frame 的種類、順序、每一格酬載——逐字不動。
 */
const withoutProjections = (frames: readonly Event[]) =>
  frames
    .filter((frame) => !isProjection(frame))
    .map((frame) =>
      JSON.stringify(frame)
        .replace(/"(seq|timestamp|llmMs|toolMs|durationMs)":\d+/gu, '"$1":0')
        .replace(/"event_id":"[^"]*"/gu, '"event_id":""')
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu, 'ID'),
    );

describe('軌跡投影走產品路徑', () => {
  it('即時與重新整理長出同一份，而且回答得出這一輪發生了什麼', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-trajectory-'));
    const server = await start(root);
    const client = await serveClient(server);
    const prompt = `記住暗號是藍鯨。${'很長的一句話'.repeat(80)}`;
    const live = await sayAndCollect(client, 't', prompt);

    const liveState = reduceAll(emptyConversation(), live);
    const refreshed = reduceAll(emptyConversation(), await historyFrames(client, 't'));

    // 1. 即時 = 歷史。
    const liveTrajectory = liveState.projections[TRAJECTORY_PROJECTION];
    expect(liveTrajectory).toBeDefined();
    expect(refreshed.projections[TRAJECTORY_PROJECTION]).toEqual(liveTrajectory);
    expect(refreshed.projections[REQUEST_SNAPSHOTS_PROJECTION]).toEqual(
      liveState.projections[REQUEST_SNAPSHOTS_PROJECTION],
    );

    // 2. 回答得出問題。
    const view = liveTrajectory?.view as TrajectoryView;
    expect(view.turns).toHaveLength(1);
    const turn = view.turns[0]!;
    expect(turn.end).toBe('completed');
    expect(turn.logical).toBe(true);
    expect(turn.callCount).toBeGreaterThanOrEqual(1);
    expect(turn.toolCount).toBeGreaterThanOrEqual(1);
    expect(turn.unattributed).toBe(0);
    expect(turn.looseTools).toEqual([]);
    for (const each of turn.calls) {
      expect(each.reply).toBeDefined();
      expect(each.endTime).toBeDefined();
      expect(each.durationMs).toBeGreaterThanOrEqual(0);
    }
    const tools = turn.calls.flatMap((each) => each.tools);
    expect(tools.length).toBe(turn.toolCount);
    for (const tool of tools) expect(['ok', 'error']).toContain(tool.status);

    // 呼叫上記的快照位置，在 `request-snapshots` 投影裡找得到內容（兩個投影靠 `seq` 接起來）。
    const snapshots = liveState.projections[REQUEST_SNAPSHOTS_PROJECTION]
      ?.view as RequestSnapshotsView;
    expect(snapshots.system.length).toBeGreaterThanOrEqual(1);
    for (const each of turn.calls) {
      expect(snapshots.system.map((snapshot) => snapshot.seq)).toContain(each.system);
      expect(snapshots.header.map((snapshot) => snapshot.seq)).toContain(each.header);
    }

    // 4. 沒有整份內文：預覽有上限，而且整份 view 裡找不到原話後半段。
    expect(turn.preview?.length).toBeLessThanOrEqual(TRAJECTORY_PREVIEW_CHARS);
    expect(turn.chars).toBe(prompt.length);
    expect(JSON.stringify(view)).not.toContain('很長的一句話'.repeat(30));
  });

  it(
    '超過窗口的長會話：即時與重新整理仍是同一份，更早的輪退成摘要',
    { timeout: 60_000 },
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'nexus-trajectory-long-'));
      const server = await start(root);
      const client = await serveClient(server);
      // 同一條下行上連說 TRAJECTORY_DETAIL_TURNS + 2 句：即時那一側從頭折到尾，歷史那一側整份重折。
      const frames: Event[] = [];
      const events = await client.openEvents('t');
      void (async () => {
        try {
          for await (const frame of events) frames.push(frame);
        } catch {
          // server 收掉時下行會斷。
        }
      })();
      const rounds = TRAJECTORY_DETAIL_TURNS + 2;
      for (let round = 1; round <= rounds; round += 1) {
        await client.runStart('t', `第 ${round} 句`);
        for (let tries = 0; tries < 600; tries += 1) {
          const view = latestTrajectory(frames);
          if (
            view !== undefined &&
            view.digests.length + view.turns.length === round &&
            view.turns.at(-1)?.end !== undefined
          )
            break;
          await new Promise((r) => setTimeout(r, 10));
        }
      }
      const live = reduceAll(emptyConversation(), frames).projections[TRAJECTORY_PROJECTION];
      const refreshed = reduceAll(emptyConversation(), await historyFrames(client, 't'))
        .projections[TRAJECTORY_PROJECTION];
      const view = live?.view as TrajectoryView;
      expect(view.turns).toHaveLength(TRAJECTORY_DETAIL_TURNS);
      expect(view.digests).toHaveLength(2);
      expect(view.digests.map((digest) => digest.index)).toEqual([0, 1]);
      expect(refreshed).toEqual(live);
    },
  );

  it(
    '關掉 trajectory：除了那兩顆投影 frame，下行與歷史逐位元組不變',
    { timeout: 30_000 },
    async () => {
      const onRoot = await mkdtemp(join(tmpdir(), 'nexus-trajectory-on-'));
      const on = await start(onRoot);
      const onClient = await serveClient(on);
      const onLive = await sayAndCollect(onClient, 't', '回聲一次');
      const onHistory = await historyFrames(onClient, 't');
      await on.close();
      running = undefined;

      const offRoot = await mkdtemp(join(tmpdir(), 'nexus-trajectory-off-'));
      const off = await start(offRoot, DISABLED);
      const offClient = await serveClient(off);
      const offLive = await sayAndCollect(offClient, 't', '回聲一次');
      const offHistory = await historyFrames(offClient, 't');

      // 前提：開著的時候投影 frame 真的來過，關著的時候一顆都沒有（不然下面的比較什麼都沒量到）。
      expect(onLive.some(isProjection)).toBe(true);
      expect(onHistory.some(isProjection)).toBe(true);
      expect(
        offLive
          .filter(isProjection)
          .map((f) => (f.params.data as { payload: { key: string } }).payload.key),
      ).not.toContain(TRAJECTORY_PROJECTION);
      expect(
        offHistory
          .filter(isProjection)
          .map((f) => (f.params.data as { payload: { key: string } }).payload.key),
      ).not.toContain(TRAJECTORY_PROJECTION);

      expect(withoutProjections(offLive)).toEqual(withoutProjections(onLive));
      expect(withoutProjections(offHistory)).toEqual(withoutProjections(onHistory));
    },
  );

  it(
    '關掉 token-meter（#1028）：除了它的投影 frame，下行與歷史逐位元組不變；軌跡照樣在',
    { timeout: 30_000 },
    async () => {
      const keysOf = (frames: readonly Event[]) =>
        frames
          .filter(isProjection)
          .map((f) => (f.params.data as { payload: { key: string } }).payload.key);
      const onRoot = await mkdtemp(join(tmpdir(), 'nexus-meter-on-'));
      const on = await start(onRoot);
      const onClient = await serveClient(on);
      const onLive = await sayAndCollect(onClient, 't', '回聲一次');
      const onHistory = await historyFrames(onClient, 't');
      await on.close();
      running = undefined;

      const offRoot = await mkdtemp(join(tmpdir(), 'nexus-meter-off-'));
      const off = await start(offRoot, METER_DISABLED);
      const offClient = await serveClient(off);
      const offLive = await sayAndCollect(offClient, 't', '回聲一次');
      const offHistory = await historyFrames(offClient, 't');

      // 前提：開著的時候用量投影真的來過（即時與歷史），關著的時候一顆都沒有；軌跡兩邊都在。
      expect(keysOf(onLive)).toContain(TOKEN_METER_PROJECTION);
      expect(keysOf(onHistory)).toContain(TOKEN_METER_PROJECTION);
      expect(keysOf(offLive)).not.toContain(TOKEN_METER_PROJECTION);
      expect(keysOf(offHistory)).not.toContain(TOKEN_METER_PROJECTION);
      expect(keysOf(offLive)).toContain(TRAJECTORY_PROJECTION);
      expect(keysOf(offHistory)).toContain(TRAJECTORY_PROJECTION);

      expect(withoutProjections(offLive)).toEqual(withoutProjections(onLive));
      expect(withoutProjections(offHistory)).toEqual(withoutProjections(onHistory));
    },
  );
});

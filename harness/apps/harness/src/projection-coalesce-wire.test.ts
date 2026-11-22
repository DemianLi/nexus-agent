/**
 * **投影 frame 的合併走產品路徑**——[#1071](https://github.com/DemianLi/nexus-agent/issues/1071) 的驗收。
 *
 * 經 wire 跑一輪「多次模型呼叫、每次帶好幾個工具」的真的 agent（`createCliAgent` 的出貨清單、`createWireHandler`、wire client
 * 的下行與歷史路由），模型是腳本。量三件事：
 *
 * 1. **少送了**：軌跡投影在下行上的 frame 數與位元組，比「每顆讓 view 改變的事件各送一顆」少——後者不靠另一條實作估，而是把
 *    同一份 root 日誌逐顆餵給同一個折疊器（`createProjectionFold`），數它交出幾顆、各多大。
 * 2. **最終值不變**：下行最後一顆軌跡投影＝日誌折出來的最終值＝重新整理（歷史）長出來的值，逐位元組。
 * 3. **合併發生在輪中**：輪收尾之後下行不再有待送的舊值倒過來蓋掉新值（frame 的 `turns` 單調不縮）。
 *
 * 設了 `NEXUS_COALESCE_REPORT`（一個檔案路徑）就把數字以一行 JSON 附加進去，PR 的數字從那裡來。
 *
 * **零憑證、零外部連線**。
 */

import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { tool } from '@langchain/core/tools';
import type { PluginEntry, SessionEvent, SessionRegistry } from '@nexus/core';
import { createProjectionFold } from '@nexus/core';
import type { Event, TrajectoryView } from '@nexus/wire';
import { createWireClient, emptyConversation, PROJECTION, reduceAll } from '@nexus/wire';
import { TRAJECTORY_PROJECTION } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createCliAgent } from './assembly-root.js';
import {
  TEST_BROWSER_AUTH,
  loopbackRequest,
  shippedPlugins,
  withScriptedModel,
} from './fixtures.js';
import { PROJECTION_FLUSH_MS } from './projection-coalescer.js';
import type { ScriptedTurn } from './scripted-model.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';

const shipped = await shippedPlugins();

const THREAD_ID = 'coalesce';
/** 一輪裡的模型呼叫數、每次呼叫帶的工具數。量滿載的形狀時用環境變數換大（預設是小的，測試才快）。 */
const CALLS = Number(process.env['NEXUS_COALESCE_CALLS'] ?? 6);
const TOOLS_PER_CALL = Number(process.env['NEXUS_COALESCE_TOOLS'] ?? 4);
/** 模型每吐一個字等這麼久：一次呼叫的長度要大於合併視窗，才像真的模型（呼叫與呼叫之間隔得開）。 */
const TOKEN_DELAY_MS = 25;
const CALL_TEXT = '先查一下資料。';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const QUICK: PluginEntry = {
  plugin: {
    name: 'quick-lookup',
    apply(registry) {
      registry.tools.register(
        tool(async () => '查到了。', {
          name: 'quick_lookup',
          description: '很快查完。',
          schema: z.object({}),
        }),
      );
    },
  },
};

const script: ScriptedTurn[] = [
  ...Array.from({ length: CALLS }, () => ({
    content: CALL_TEXT,
    tokenDelayMs: TOKEN_DELAY_MS,
    toolCalls: Array.from({ length: TOOLS_PER_CALL }, () => ({ name: 'quick_lookup', args: {} })),
  })),
  { content: '查好了。', tokenDelayMs: TOKEN_DELAY_MS },
];

const isTrajectory = (frame: Event): boolean => {
  if (frame.method !== 'custom') return false;
  const data = frame.params.data as { name?: string; payload?: { key?: string } } | null;
  return data?.name === PROJECTION && data.payload?.key === TRAJECTORY_PROJECTION;
};

interface Outcome {
  readonly live: readonly Event[];
  readonly history: readonly Event[];
  readonly log: readonly SessionEvent[];
  readonly units: Parameters<typeof createProjectionFold>[0];
}

async function run(flushMs?: number): Promise<Outcome> {
  const root = await mkdtemp(join(tmpdir(), 'nexus-coalesce-'));
  roots.push(root);
  const built = await createCliAgent(
    { live: false, workspace: root },
    withScriptedModel([...shipped, QUICK], script),
    root,
  );
  let sessions: SessionRegistry | undefined;
  const handler = createWireHandler({
    auth: TEST_BROWSER_AUTH,
    ...(flushMs === undefined ? {} : { projectionFlushMs: flushMs }),
    createAgent: async () => ({
      agent: built.agent as unknown as PumpAgent,
      commands: built.commands,
      projections: built.projections,
      dispose: built.dispose,
      attachSessions: (registry, backgroundPort) => {
        sessions = registry;
        return built.attachSessions(registry, backgroundPort);
      },
    }),
  });
  const client = createWireClient({
    baseUrl: 'http://coalesce.test',
    fetch: async (input, init) => handler.handle(loopbackRequest(input as string, init)),
  });
  const live: Event[] = [];
  try {
    const events = await client.openEvents(THREAD_ID);
    // 背景一直收：root 收尾的 lifecycle 之後，`turn/end` 的投影 frame 才到。
    void (async () => {
      try {
        for await (const frame of events) live.push(frame);
      } catch {
        // server 收掉時下行會斷。
      }
    })();
    await client.runStart(THREAD_ID, '查一下。');
    const closed = () =>
      live.filter(isTrajectory).some((frame) => {
        const payload = (frame.params.data as { payload: { view: TrajectoryView } }).payload;
        return payload.view.turns.at(-1)?.end !== undefined;
      });
    for (let tries = 0; tries < 6000 && !closed(); tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // 收尾之後再多等兩個合併視窗，看有沒有遲到的待送值倒過來蓋掉最終值。
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(flushMs ?? PROJECTION_FLUSH_MS, 200) * 2),
    );
    const page = await client.threadHistory(THREAD_ID);
    if (page.kind !== 'ok') throw new Error(`歷史拿不到：${page.message}`);
    if (sessions === undefined) throw new Error('attachSessions 沒被叫到');
    return {
      live,
      history: page.result.events,
      log: [...sessions.root.events],
      units: built.projections.list(),
    };
  } finally {
    await handler.close();
  }
}

async function report(row: Record<string, unknown>): Promise<void> {
  const path = process.env['NEXUS_COALESCE_REPORT'];
  if (path === undefined || path === '') return;
  await appendFile(path, `${JSON.stringify(row)}\n`);
}

describe('投影 frame 的合併（#1071）', () => {
  it('輪中少送、最終值不變：下行最後一顆＝日誌折出來的＝歷史長出來的', async () => {
    const outcome = await run();

    // 不合併的話會送什麼：同一份日誌逐顆餵同一個折疊器，交出幾顆軌跡值、各多大。
    const session = createProjectionFold(outcome.units).session([]);
    const uncoalesced: string[] = [];
    for (const event of outcome.log) {
      for (const value of session.push(event)) {
        if (value.key === TRAJECTORY_PROJECTION) uncoalesced.push(JSON.stringify(value.view));
      }
    }
    const liveFrames = outcome.live.filter(isTrajectory);
    const liveBytes = liveFrames.reduce((sum, frame) => sum + JSON.stringify(frame).length, 0);
    const uncoalescedBytes = uncoalesced.reduce((sum, view) => sum + view.length, 0);
    await report({
      calls: CALLS,
      toolsPerCall: TOOLS_PER_CALL,
      flushMs: PROJECTION_FLUSH_MS,
      events: outcome.log.length,
      uncoalescedFrames: uncoalesced.length,
      uncoalescedBytes,
      liveFrames: liveFrames.length,
      liveBytes,
    });

    // 前提：真的有一串要合併的東西——不合併至少要送一大把，否則「少了」量不出東西。
    expect(uncoalesced.length).toBeGreaterThanOrEqual(CALLS * TOOLS_PER_CALL);
    expect(liveFrames.length).toBeGreaterThanOrEqual(1);
    // 1. 少送了：frame 數與位元組都明顯少於不合併的。
    expect(liveFrames.length).toBeLessThan(uncoalesced.length / 2);
    expect(liveBytes).toBeLessThan(uncoalescedBytes / 2);

    // 2. 最終值：下行折出來的、歷史折出來的、日誌逐顆折出來的最後一份，是同一份。
    const liveView = reduceAll(emptyConversation(), outcome.live).projections[TRAJECTORY_PROJECTION]
      ?.view as TrajectoryView | undefined;
    const historyView = reduceAll(emptyConversation(), outcome.history).projections[
      TRAJECTORY_PROJECTION
    ]?.view;
    expect(liveView).toBeDefined();
    expect(JSON.stringify(liveView)).toBe(uncoalesced.at(-1));
    expect(JSON.stringify(historyView)).toBe(uncoalesced.at(-1));
    expect(liveView?.turns.at(-1)?.end).toBe('completed');

    // 輪結束的那一顆是 `turn/end` 當場送的，不是等視窗：收尾的值貼著日誌那一筆到，不到半個視窗。
    // （沒有 flush 的話它要等滿一個視窗才出來，差不多整個 PROJECTION_FLUSH_MS。）
    const turnEnd = outcome.log.findLast((event) => event.type === 'turn/end');
    const finalFrame = liveFrames.at(-1);
    expect(turnEnd).toBeDefined();
    expect(finalFrame!.params.timestamp - turnEnd!.time).toBeLessThan(PROJECTION_FLUSH_MS / 2);

    // 3. 沒有舊值倒過來蓋新值：frame 帶的呼叫數單調不減。
    const callCounts = liveFrames.map((frame) => {
      const payload = (frame.params.data as { payload: { view: TrajectoryView } }).payload;
      return payload.view.turns.at(-1)?.callCount ?? 0;
    });
    expect(callCounts).toEqual([...callCounts].sort((a, b) => a - b));
  }, 120000);
  /**
   * **視窗是設定**（`projection-flush` 那一列）：同一段腳本，`createWireHandler` 的 `projectionFlushMs` 設大，下行上的軌跡 frame
   * 就比設 1 少。量的是產品路徑（真的 handler → 真的 `ThreadPump` → 合併器），不是合併器建構子傳值——後者證明不了設定有接上。
   * 兩邊的終值結構相同（視窗只影響輪中的 frame 數，不影響終值）。
   *
   * 突變：讓 pump 不用傳進來的值（寫死預設 100）→ 兩邊 frame 數接近，這條紅。
   */
  it('視窗是設定：設大的比設 1 的少送，終值結構相同', async () => {
    const tight = await run(1);
    const wide = await run(1500);
    const frames = (outcome: Outcome) => outcome.live.filter(isTrajectory);
    // 終值的**結構**相同（兩次執行的時刻與 id 不同，所以不比逐位元組）：輪數、每輪呼叫數、工具數、結局。
    const shapeOf = (outcome: Outcome) => {
      const view = reduceAll(emptyConversation(), outcome.live).projections[TRAJECTORY_PROJECTION]
        ?.view as TrajectoryView | undefined;
      return (view?.turns ?? []).map((turn) => ({
        end: turn.end,
        calls: turn.calls.length,
        tools: turn.calls.reduce((sum, call) => sum + call.tools.length, 0),
      }));
    };
    await report({ flushMs: [1, 1500], frames: [frames(tight).length, frames(wide).length] });
    // 前提：1 毫秒的視窗幾乎不合併，至少要送出一大把，否則比較量不出東西。
    expect(frames(tight).length).toBeGreaterThanOrEqual(CALLS);
    expect(frames(wide).length * 2).toBeLessThanOrEqual(frames(tight).length);
    expect(shapeOf(tight)).toEqual([
      { end: 'completed', calls: CALLS + 1, tools: CALLS * TOOLS_PER_CALL },
    ]);
    expect(shapeOf(wide)).toEqual(shapeOf(tight));
  }, 60_000);
});

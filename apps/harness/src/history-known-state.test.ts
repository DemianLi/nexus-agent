/**
 * **讀歷史不從日誌開頭重算**（[#2117](https://github.com/DemianLi/nexus-agent/issues/2117)）：最新一頁的投影值拿 pump 的即時折疊，
 * `legacy` 在 root 日誌長度沒變時沿用上一次的值。不帶已知值的話，大日誌每讀一頁都要重折投影、重推整份對話，這段同步工作
 * 會擋住同一個行程裡的每一條 thread。
 *
 * 計次走真的 handler：拿掉 `handleHistory` 傳的 `known`（或其中任一欄），熱讀的計次就會長。
 */

import { createProjectionFold, SessionLog } from '@nexus/core';
import type { ProjectionUnit, SessionEvent } from '@nexus/core';
import * as core from '@nexus/core';
import { createWireClient, emptyConversation, reduceAll } from '@nexus/wire';
import { describe, expect, it, vi } from 'vitest';

import { historyPage, isLegacyLog } from './conversation-history.js';
import { emptyCommandPoint, loopbackRequest, noSessions, TEST_BROWSER_AUTH } from './fixtures.js';
import { TOY_PROJECTION_KEY, toyUnit } from './projection-toy.fixture.js';
import type { PumpAgent } from './thread-pump.js';
import { ThreadPump } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';

vi.mock('@nexus/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nexus/core')>();
  return { ...actual, replayConversation: vi.fn(actual.replayConversation) };
});

const COMMAND = { commandId: 'c', name: 'plan', source: { kind: 'user' } } as const;

/** 數 `apply` 被叫幾次的玩具單元。 */
function countingUnit(): { unit: ProjectionUnit; applies: () => number } {
  let applies = 0;
  return {
    unit: {
      ...toyUnit,
      apply: (state, event) => {
        applies += 1;
        return toyUnit.apply(state as never, event);
      },
    } as ProjectionUnit,
    applies: () => applies,
  };
}

function seedOf(commands: number): readonly SessionEvent[] {
  const log = new SessionLog('seed');
  for (let index = 0; index < commands; index += 1) {
    log.append('command/run', { ...COMMAND, commandId: `c${String(index)}` });
  }
  return [...log.events];
}

const projectionsOf = (events: Parameters<typeof reduceAll>[1]) =>
  reduceAll(emptyConversation(), events).projections;

describe('handler 讀歷史', () => {
  it('熱讀一頁：投影不重折、對話不重推，值照舊', async () => {
    const counting = countingUnit();
    const handler = createWireHandler({
      auth: TEST_BROWSER_AUTH,
      createAgent: async () => ({
        agent: {} as PumpAgent,
        attachSessions: noSessions,
        commands: emptyCommandPoint(),
        projections: { list: () => [counting.unit] },
        rootSeed: seedOf(3),
        dispose: async () => undefined,
      }),
    });
    const client = createWireClient({
      baseUrl: 'http://wire.test',
      fetch: async (input, init) => handler.handle(loopbackRequest(input as string, init)),
    });
    const replay = vi.mocked(core.replayConversation);

    const cold = await client.threadHistory('t');
    if (cold.kind !== 'ok') throw new Error(JSON.stringify(cold));
    const appliesAfterCold = counting.applies();
    const replaysAfterCold = replay.mock.calls.length;

    const warm = await client.threadHistory('t');
    if (warm.kind !== 'ok') throw new Error(JSON.stringify(warm));
    expect(counting.applies()).toBe(appliesAfterCold);
    expect(replay.mock.calls.length).toBe(replaysAfterCold);
    expect(projectionsOf(warm.result.events)[TOY_PROJECTION_KEY]?.view).toEqual({
      commands: 3,
      label: '玩具',
    });
    expect(warm.result.legacy).toBe(cold.result.legacy);
    await handler.close();
  });
});

describe('pump 的已知值', () => {
  it('投影值跟著日誌走，與從頭折的相同；legacy 長度變了才重算', () => {
    const pump = new ThreadPump(
      {} as PumpAgent,
      'known',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      [toyUnit],
    );
    const fold = () => createProjectionFold([toyUnit]).fold(pump.sessionLog.events);
    expect(pump.projectionValues).toEqual(fold());

    const replay = vi.mocked(core.replayConversation);
    const first = pump.legacyLog();
    const replays = replay.mock.calls.length;
    expect(pump.legacyLog()).toBe(first);
    expect(replay.mock.calls.length).toBe(replays);

    pump.sessionLog.append('command/run', COMMAND);
    expect(pump.projectionValues).toEqual(fold());
    expect(pump.legacyLog()).toBe(isLegacyLog(pump.sessionLog.events));
    expect(replay.mock.calls.length).toBe(replays + 2);

    pump.close();
    expect(pump.projectionValues).toBeUndefined();
  });
});

describe('historyPage 用已知的投影值', () => {
  const events = seedOf(2);
  const stale = [{ key: TOY_PROJECTION_KEY, version: 3, view: { commands: 99, label: '已知' } }];

  it('涵蓋整份日誌的最新一頁用它', () => {
    const page = historyPage(
      events,
      {},
      undefined,
      undefined,
      undefined,
      undefined,
      [toyUnit],
      undefined,
      {
        projections: stale,
      },
    );
    expect(projectionsOf(page.events)[TOY_PROJECTION_KEY]?.view).toEqual({
      commands: 99,
      label: '已知',
    });
  });

  it('切在較早的 throughSeq 就照那一段重折', () => {
    const page = historyPage(
      events,
      { throughSeq: 0 },
      undefined,
      undefined,
      undefined,
      undefined,
      [toyUnit],
      undefined,
      { projections: stale },
    );
    expect(projectionsOf(page.events)[TOY_PROJECTION_KEY]?.view).toEqual({
      commands: 1,
      label: '玩具',
    });
  });
});

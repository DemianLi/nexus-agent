/**
 * `ThreadPump` 的 `onTurnFailed` 回呼（[#1536](https://github.com/DemianLi/nexus-agent/issues/1536)）：失敗輪回報一次，
 * `seq` 指向會話日誌裡那筆 `turn/failed`，請求編號從錯誤上的標頭來；回呼拋錯不改變這一輪的收尾；成功的輪不回報。
 *
 * 一個直接拋錯的假 agent 就夠——分類走真的 `classifyTurnFailure`。從 `runServe` 起量的接線在
 * `turn-failed-log-wiring.test.ts`。
 */

import { TURN_CANCEL_CONFIG_KEY, TurnBlockedError } from '@nexus/core';
import { describe, expect, it } from 'vitest';

import { ThreadPump } from './thread-pump.js';
import type { PumpAgent, TurnFailedReport } from './thread-pump.js';

/** streamEvents 一叫就拋這顆錯（像 OpenAI SDK 的 APIError：`status` 與 `headers` 在錯誤物件上）。 */
function failingAgent(error: unknown): PumpAgent {
  return {
    streamEvents: () => Promise.reject(error),
    getState: () => Promise.resolve({ values: {} }),
    updateState: () => Promise.resolve(undefined),
  } as unknown as PumpAgent;
}

function providerError(headers: Record<string, string>): Error {
  return Object.assign(new Error('Bad gateway SECRET-PROBE'), {
    status: 502,
    headers: new Headers(headers),
  });
}

async function settle(pump: ThreadPump): Promise<void> {
  for (let round = 0; round < 20; round += 1) {
    await pump.whenIdle();
    await new Promise((resolve) => setImmediate(resolve));
    if (!pump.running) return;
  }
}

/** 說一句話並等這一輪收尾；失敗的輪 `submit` 會把錯誤再拋給呼叫端，這裡接住（斷言的是日誌與回報）。 */
async function say(pump: ThreadPump, text: string): Promise<unknown> {
  let failure: unknown;
  await pump.submit({ kind: 'message', text }).catch((error: unknown) => {
    failure = error;
  });
  await settle(pump);
  return failure;
}

function pumpWith(agent: PumpAgent, onTurnFailed: (report: TurnFailedReport) => void) {
  return new ThreadPump(
    agent,
    't1',
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    undefined,
    [],
    undefined,
    undefined,
    undefined,
    undefined,
    onTurnFailed,
  );
}

describe('ThreadPump 的 onTurnFailed', () => {
  it('失敗輪回報一次：seq 是日誌裡 turn/failed 的那一筆，碼、狀態、請求編號與佇列項的 run id 都在', async () => {
    const reports: TurnFailedReport[] = [];
    const pump = pumpWith(failingAgent(providerError({ 'x-request-id': 'gw-9' })), (report) =>
      reports.push(report),
    );
    await say(pump, '嗨');

    expect(reports).toHaveLength(1);
    const report = reports[0]!;
    expect(report).toEqual({
      threadId: 't1',
      runId: expect.any(String),
      seq: report.seq,
      code: 'SERVER',
      status: 502,
      requestId: 'gw-9',
    });
    expect(pump.sessionLog.events[report.seq]?.type).toBe('turn/failed');
    // 失敗訊息本文留在會話日誌，回報裡沒有。
    expect(JSON.stringify(report)).not.toContain('SECRET-PROBE');
  });

  it('沒有請求編號標頭：回報裡沒有 requestId 這一格', async () => {
    const reports: TurnFailedReport[] = [];
    const pump = pumpWith(failingAgent(providerError({})), (report) => reports.push(report));
    await say(pump, '嗨');

    expect(reports).toHaveLength(1);
    expect('requestId' in reports[0]!).toBe(false);
  });

  it('回呼拋錯：吞掉，turn/failed 照樣寫完、這一輪照樣收尾、下一句話照樣能送', async () => {
    let calls = 0;
    const pump = pumpWith(failingAgent(providerError({ 'x-request-id': 'gw-9' })), () => {
      calls += 1;
      throw new Error('回呼炸了');
    });
    const first = await say(pump, '嗨');
    const second = await say(pump, '再一句');

    expect(calls).toBe(2);
    // 呼叫端看到的仍是供應商那顆錯，不是回呼的錯。
    for (const failure of [first, second]) {
      expect(failure).toMatchObject({ message: 'Bad gateway SECRET-PROBE' });
    }
    expect(pump.sessionLog.events.filter((event) => event.type === 'turn/failed')).toHaveLength(2);
    expect(pump.running).toBe(false);
  });

  it('按停止：這一輪以 aborted 收，不是失敗，回報 0 次', async () => {
    const reports: TurnFailedReport[] = [];
    // 一直等到這一輪的中止訊號舉起來，才拋（被切斷的請求拋什麼看供應商，pump 認的是訊號）。
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => (started = resolve));
    const waiting: PumpAgent = {
      streamEvents: (_input: unknown, config: { configurable: Record<string, unknown> }) =>
        new Promise((_resolve, reject) => {
          started();
          const signal = config.configurable[TURN_CANCEL_CONFIG_KEY] as AbortSignal;
          signal.addEventListener('abort', () => reject(new Error('被切斷')), { once: true });
        }),
      getState: () => Promise.resolve({ values: {} }),
      updateState: () => Promise.resolve(undefined),
    } as unknown as PumpAgent;
    const pump = pumpWith(waiting, (report) => reports.push(report));
    const done = pump.submit({ kind: 'message', text: '嗨' });
    await running;
    expect(pump.cancel()).toBe('run');
    await done;
    await settle(pump);

    expect(reports).toEqual([]);
    const types = pump.sessionLog.events.map((event) => event.type);
    expect(types).not.toContain('turn/failed');
    expect(pump.sessionLog.events.find((event) => event.type === 'turn/end')?.data).toMatchObject({
      reason: { kind: 'aborted' },
    });
  });

  it('準入閘門擋下（封存的會話）：這一輪以 blocked 收，不是失敗，回報 0 次', async () => {
    const reports: TurnFailedReport[] = [];
    const pump = pumpWith(failingAgent(new TurnBlockedError()), (report) => reports.push(report));
    await pump.submit({ kind: 'message', text: '嗨' });
    await settle(pump);

    expect(reports).toEqual([]);
    expect(pump.sessionLog.events.some((event) => event.type === 'turn/failed')).toBe(false);
    expect(pump.sessionLog.events.find((event) => event.type === 'turn/end')?.data).toMatchObject({
      reason: { kind: 'blocked' },
    });
  });

  it('沒有掛回呼：照常失敗收尾', async () => {
    const pump = new ThreadPump(failingAgent(providerError({})), 't1');
    await say(pump, '嗨');
    expect(pump.sessionLog.events.some((event) => event.type === 'turn/failed')).toBe(true);
  });
});

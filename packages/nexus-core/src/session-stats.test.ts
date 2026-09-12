/**
 * 會話統計那道折疊的規則。每一條對著一份手寫的事件串驗；真的跑一場對話之後讀不讀得出來，
 * 在 `apps/harness/src/session-stats.test.ts`。
 */

import { describe, expect, it } from 'vitest';
import type { SessionEvent, SessionEventType } from './session-log.js';
import { deriveSessionStats, sessionStatsUnit } from './session-stats.js';

/** 一顆事件。`time` 由呼叫端給，折疊只讀它。 */
function ev(type: SessionEventType, time: number, data: unknown = {}): SessionEvent {
  return { type, time, data, seq: 0 } as unknown as SessionEvent;
}

const message = (time: number) => ev('turn/start', time, { kind: 'message', text: '嗨' });
const resume = (time: number) => ev('turn/start', time, { kind: 'resume' });
const call = (time: number, callId: string) =>
  ev('tool/call', time, { callId, name: 'echo', arguments: '{}' });
const result = (time: number, callId: string) =>
  ev('tool/result', time, { callId, isError: false });

describe('輪與步', () => {
  it('兩輪、三次模型呼叫：turns 2、steps 3，llmMs 是每一對的差加總', () => {
    expect(
      deriveSessionStats([
        message(0),
        ev('model/start', 10),
        ev('model/end', 30),
        ev('model/start', 40),
        ev('model/end', 45),
        ev('turn/end', 50),
        message(100),
        ev('model/start', 110),
        ev('model/end', 200),
        ev('turn/end', 210),
      ]),
    ).toEqual({ turns: 2, steps: 3, llmMs: 20 + 5 + 90, toolMs: 0 });
  });

  /** 核准之後那顆 `turn/start` 是同一輪的延續。直接數 `turn/start` 的實作在這裡是 2。 */
  it('resume 併回前一輪', () => {
    expect(
      deriveSessionStats([
        message(0),
        ev('model/start', 1),
        ev('model/end', 2),
        ev('interrupt/raised', 3, { interruptId: 'i' }),
        ev('turn/end', 4),
        resume(5),
        ev('model/start', 6),
        ev('model/end', 7),
        ev('turn/end', 8),
      ]),
    ).toMatchObject({ turns: 1, steps: 2 });
  });

  it('沒叫到模型的輪不算', () => {
    expect(
      deriveSessionStats([
        message(0),
        ev('turn/failed', 1, { message: '連不上' }),
        message(2),
        ev('model/start', 3),
        ev('model/end', 4),
        ev('turn/end', 5),
      ]),
    ).toMatchObject({ turns: 1, steps: 1 });
  });

  /** **卡上的驗收句 2。** 呼叫拋了，`model/end` 照樣在 `finally` 裡落下，這一步算數。 */
  it('失敗的那次呼叫也算一步，也計時', () => {
    expect(
      deriveSessionStats([
        message(0),
        ev('model/start', 10),
        ev('model/end', 25),
        ev('turn/failed', 26, { message: '模型不見了' }),
      ]),
    ).toEqual({ turns: 1, steps: 1, llmMs: 15, toolMs: 0 });
  });

  it('subagent 那份沒有 turn/start，整份算一輪', () => {
    expect(
      deriveSessionStats([
        ev('model/start', 0),
        ev('model/end', 1),
        ev('model/start', 2),
        ev('model/end', 3),
      ]),
    ).toMatchObject({ turns: 1, steps: 2 });
  });

  it('goal 排的每一輪各算一輪', () => {
    const goal = (time: number, round: number) =>
      ev('turn/start', time, { kind: 'goal', text: '續', goalId: 'g', revision: 1, round });
    expect(
      deriveSessionStats([
        goal(0, 1),
        ev('model/start', 1),
        ev('model/end', 2),
        ev('turn/end', 3),
        goal(4, 2),
        ev('model/start', 5),
        ev('model/end', 6),
        ev('turn/end', 7),
      ]),
    ).toMatchObject({ turns: 2, steps: 2 });
  });
});

describe('工具耗時', () => {
  it('以 callId 配對，併發的兩顆各算各的', () => {
    expect(
      deriveSessionStats([
        message(0),
        call(10, 'a'),
        call(11, 'b'),
        result(15, 'b'),
        result(30, 'a'),
        ev('turn/end', 40),
      ]).toolMs,
    ).toBe(20 + 4);
  });

  it('叫 constructor 的結果配不到繼承來的東西，toolMs 不變成 NaN', () => {
    expect(deriveSessionStats([message(0), result(5, 'constructor')]).toolMs).toBe(0);
  });

  /**
   * **核准的等待不進帳，承重的那條**：被閘門中斷的那一輪以 `turn/end` 收尾，暫停那顆
   * `tool/call` 在那裡丟掉。拿掉 `turn/end` 那一格清空，下一條「覆寫」仍然擋得住這個形狀，
   * 所以這一條用的是 resume 之後**換了 callId** 的形狀——只剩清空擋得住。
   */
  it('turn/end 丟掉沒配到的呼叫：人等的那段不進帳', () => {
    expect(
      deriveSessionStats([
        message(0),
        call(10, 'a'),
        ev('interrupt/raised', 11, { interruptId: 'i' }),
        ev('turn/end', 12),
        resume(10_000),
        result(10_005, 'a'),
      ]).toolMs,
    ).toBe(0);
  });

  it('turn/failed 也丟', () => {
    expect(
      deriveSessionStats([
        message(0),
        call(10, 'a'),
        ev('turn/failed', 12, { message: '壞了' }),
        message(10_000),
        result(10_005, 'a'),
      ]).toolMs,
    ).toBe(0);
  });

  /** 保險的那條：同一個 callId 再記一顆 `tool/call`，派發時間換成後來那顆。 */
  it('同一個 callId 第二顆 tool/call 覆寫派發時間', () => {
    expect(
      deriveSessionStats([message(0), call(10, 'a'), call(10_000, 'a'), result(10_005, 'a')])
        .toolMs,
    ).toBe(5);
  });

  /** dsh 沒有這條路：崩潰前沒配到的呼叫，不能跟重啟之後的結果配上。 */
  it('session/end-seed 丟掉上一個行程沒配到的呼叫與沒結束的模型呼叫', () => {
    expect(
      deriveSessionStats([
        message(0),
        ev('model/start', 5),
        call(10, 'a'),
        ev('session/end-seed', 60_000),
        resume(60_001),
        result(60_005, 'a'),
        ev('model/end', 60_010),
      ]),
    ).toEqual({ turns: 1, steps: 1, llmMs: 0, toolMs: 0 });
  });

  /**
   * `turnCounted` 是唯一跨過 end-seed 的狀態。重啟之後的另一條路是一個全新的 `message` 輪：
   * 它照樣開新的一輪，不會被併進崩潰前那一輪。
   */
  it('end-seed 之後的 message 開新的一輪', () => {
    expect(
      deriveSessionStats([
        message(0),
        ev('model/start', 1),
        ev('model/end', 2),
        ev('session/end-seed', 3),
        message(4),
        ev('model/start', 5),
        ev('model/end', 6),
        ev('turn/end', 7),
      ]),
    ).toMatchObject({ turns: 2, steps: 2 });
  });
});

describe('單元的形狀', () => {
  it('不相干的事件回同一個參照', () => {
    const state = sessionStatsUnit.init();
    for (const type of ['command/run', 'model/usage', 'plan/mode', 'turn/end'] as const) {
      expect(sessionStatsUnit.apply(state, ev(type, 1))).toBe(state);
    }
  });

  it('狀態是純 JSON', () => {
    let state = sessionStatsUnit.init();
    for (const event of [message(0), call(1, 'a'), ev('model/start', 2)]) {
      state = sessionStatsUnit.apply(state, event);
    }
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });

  /** 沒有載體的格子不是 0，是整個沒有（見檔頭）。 */
  it('view 只有四格', () => {
    expect(Object.keys(deriveSessionStats([])).sort()).toEqual([
      'llmMs',
      'steps',
      'toolMs',
      'turns',
    ]);
  });
});

/**
 * 單筆事件的資料規則與 seed 的信封（[#1549](https://github.com/DemianLi/nexus-agent/issues/1549) N0785、N0556 做法 1）。
 * 照 dsh：資料規則在 `append`（`packages/core/session/src/index.ts:824`）與 seed（`:230`）都跑；信封只在 seed 驗
 * （`:201-243`、`:651`）。讀盤那一側（`jsonl-session-store.ts`）跑同一支資料規則，測在 harness。
 */

import { describe, expect, it } from 'vitest';

import { SessionLog, validateSessionEventData } from './session-log.js';
import type { SessionEvent } from './session-log.js';

/** 一筆信封合格的事件；`extra` 蓋掉或補上任何一格（包括故意壞掉的）。 */
function row(seq: number, extra: Record<string, unknown> = {}): SessionEvent {
  return { type: 'model/usage', seq, time: 1, data: {}, ...extra } as unknown as SessionEvent;
}

const BAD_TOOL_RESULT = { callId: 'c', isError: false, error: { name: 'X' } };
const EMPTY_TOOLS_HEADER = { header: { config: { model: 'm' }, tools: [] }, reason: 'initial' };

describe('N0785 資料規則', () => {
  it('A：append tool/result 帶了 error、isError 卻不是 true 要拋，日誌不變', () => {
    const log = new SessionLog('a');
    expect(() => log.append('tool/result', BAD_TOOL_RESULT as never)).toThrow(TypeError);
    expect(log.length).toBe(0);
    // 對照：isError 是 true 就收。
    log.append('tool/result', { ...BAD_TOOL_RESULT, isError: true } as never);
    expect(log.length).toBe(1);
  });

  it('B：append request/header 帶空的 header.tools 要拋；省略 tools 就收', () => {
    const log = new SessionLog('b');
    expect(() =>
      log.append('request/header', EMPTY_TOOLS_HEADER as never, { ignorable: true }),
    ).toThrow(/tools/);
    log.append(
      'request/header',
      { header: { config: { model: 'm' } }, reason: 'initial' } as never,
      { ignorable: true },
    );
    expect(log.length).toBe(1);
  });

  it.each([
    ['tool/result', BAD_TOOL_RESULT],
    ['request/header', EMPTY_TOOLS_HEADER],
  ])('C：seed 裡有一筆違規的 %s 要拋', (type, data) => {
    const seed = [row(0), row(1, { type, data })];
    expect(() => new SessionLog('c', { seed })).toThrow(TypeError);
  });

  it('不認得規則的種類不看：validateSessionEventData 對其他種類不拋', () => {
    expect(() => validateSessionEventData({ type: 'model/usage', data: 1 }, 'x')).not.toThrow();
  });
});

describe('seed 的信封（照 dsh 的 assertSessionEventEnvelope）', () => {
  it.each([
    ['time 是小數', { time: 1.5 }, /time/],
    ['少了 data', { data: undefined }, /data/],
    ['ignorable 是 false', { ignorable: false }, /ignorable/],
    ['多一個鍵 foo', { foo: 1 }, /foo/],
    ['type 不是字串', { type: 7 }, /type/],
  ])('%s：拿它當 seed 建 SessionLog 要拋', (_name, extra, message) => {
    const broken = row(1, extra);
    // 少了 data：JSON 落盤時那一格就不在，模擬讀回來的樣子。
    if ('data' in extra) delete (broken as { data?: unknown }).data;
    expect(() => new SessionLog('env', { seed: [row(0), broken] })).toThrow(message);
  });

  it('合格的 seed 照收，ignorable: true 也收', () => {
    const log = new SessionLog('ok', { seed: [row(0), row(1, { ignorable: true })] });
    // 兩顆 seed，加上補的 session/end-seed。
    expect(log.length).toBe(3);
  });
});

import { describe, expect, it } from 'vitest';

import { StepLaps } from './serve-under-test.fixture.js';

describe('StepLaps', () => {
  it('回來的步驟只列開始與回來的毫秒；還沒回來的標出已等多久', () => {
    let now = 1000;
    const laps = new StepLaps(() => now);
    now = 1010;
    const startDone = laps.begin('start');
    now = 1700;
    startDone();
    now = 1800;
    laps.begin('close');
    now = 6800;
    expect(laps.render()).toBe(
      [
        'serve 步驟耗時（毫秒，自這支測試第一次呼叫 fixture 起算；現在 +5800）：start 開始 +10、start 回來 +700、close 開始 +800',
        '還沒回來：close（開始後已 5000 ms 沒回來）',
      ].join('\n'),
    );
  });

  it('全都回來了就沒有「還沒回來」那一行', () => {
    let now = 0;
    const laps = new StepLaps(() => now);
    const done = laps.begin('start');
    now = 5;
    done();
    expect(laps.render()).not.toContain('還沒回來');
  });
});

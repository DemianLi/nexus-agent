import {
  PROJECTION,
  TRAJECTORY_PROJECTION,
  TRAJECTORY_VERSION,
  emptyConversation,
  reduceAll,
} from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { Script } from '@/test/conversation-frames';
import { decision, projectionFrame, view } from '@/test/trajectory-fixtures';
import {
  ABSENT,
  clockText,
  durationText,
  TURN_KIND_LABEL,
  signalText,
  snapshotsOf,
  tokenText,
  trajectoryOf,
} from '@/lib/trajectory-view';

describe('格式化：缺席寫「—」，永遠不補 0', () => {
  it('耗時：不到一秒寫 ms、一分鐘內寫秒、再長寫分秒', () => {
    expect(durationText(undefined)).toBe(ABSENT);
    expect(durationText(0)).toBe('0 ms');
    expect(durationText(999)).toBe('999 ms');
    expect(durationText(1000)).toBe('1.0 秒');
    expect(durationText(59_949)).toBe('59.9 秒');
    expect(durationText(60_000)).toBe('1 分 0 秒');
    expect(durationText(125_400)).toBe('2 分 5 秒');
  });

  it('時刻寫本地的 HH:MM:SS；token 加千分位；缺席都是 —', () => {
    const at = new Date(2026, 9, 4, 3, 7, 9).getTime();
    expect(clockText(at)).toBe('03:07:09');
    expect(clockText(undefined)).toBe(ABSENT);
    expect(tokenText(1234567)).toBe('1,234,567');
    expect(tokenText(0)).toBe('0');
    expect(tokenText(undefined)).toBe(ABSENT);
  });
});

describe('signalText：只讀結構化欄位', () => {
  it.each([
    [decision('reminder', 1, { tool: 'ls', count: 3 }), '重複呼叫：ls 連續第 3 次'],
    [decision('reminder', 1, {}), '重複呼叫：同一個工具'],
    [decision('plugin-message', 1, { plugin: 'goal' }), '外掛 goal 插了一則訊息'],
    [decision('goal', 1, { operation: 'create', phase: 'active' }), '建立目標（進行中）'],
    [decision('goal', 1, { operation: 'block', phase: 'blocked' }), '目標卡住了（卡住）'],
    [decision('goal', 1, { operation: 'future-op' }), '目標：future-op'],
    [decision('goal', 1, {}), '目標變更'],
    [decision('plan', 1, { active: true }), '進入計劃模式'],
    [decision('plan', 1, { active: false }), '離開計劃模式'],
    [decision('todo', 1, { items: 4 }), '待辦清單更新，共 4 項'],
    [decision('interrupt', 1, {}), '停下來等人決定'],
  ])('%j → %s', (input, text) => {
    if (input.kind === 'compaction') throw new Error('壓縮不長列');
    expect(signalText(input)).toBe(text);
  });
});

describe('trajectoryOf 的閘門', () => {
  const stateWith = (...frames: ((script: Script) => ReturnType<typeof projectionFrame>)[]) => {
    const script = new Script();
    return reduceAll(
      emptyConversation(),
      frames.map((frame) => frame(script)),
    );
  };

  it('認得的版本、形狀對：回 view', () => {
    const v = view([]);
    const state = stateWith((s) =>
      projectionFrame(s, TRAJECTORY_PROJECTION, TRAJECTORY_VERSION, v),
    );
    expect(trajectoryOf(state)).toEqual(v);
  });

  it.each([
    ['沒有這個 key', []],
    ['別的 key 不算', [(s: Script) => projectionFrame(s, 'other', TRAJECTORY_VERSION, view([]))]],
    [
      '版本差一',
      [(s: Script) => projectionFrame(s, TRAJECTORY_PROJECTION, TRAJECTORY_VERSION + 1, view([]))],
    ],
    [
      'view 缺 digests',
      [
        (s: Script) =>
          projectionFrame(s, TRAJECTORY_PROJECTION, TRAJECTORY_VERSION, { turns: [], omitted: 0 }),
      ],
    ],
    [
      'view 缺 omitted',
      [
        (s: Script) =>
          projectionFrame(s, TRAJECTORY_PROJECTION, TRAJECTORY_VERSION, { turns: [], digests: [] }),
      ],
    ],
    [
      'view 是字串',
      [(s: Script) => projectionFrame(s, TRAJECTORY_PROJECTION, TRAJECTORY_VERSION, 'x')],
    ],
  ])('%s：undefined', (_label, frames) => {
    expect(trajectoryOf(stateWith(...frames))).toBeUndefined();
  });

  it('請求快照投影的閘門一樣；形狀缺 header 就當沒有', () => {
    const ok = stateWith((s) =>
      projectionFrame(s, 'request-snapshots', 1, { system: [], header: [] }),
    );
    expect(snapshotsOf(ok)).toEqual({ system: [], header: [] });
    const bad = stateWith((s) => projectionFrame(s, 'request-snapshots', 1, { system: [] }));
    expect(snapshotsOf(bad)).toBeUndefined();
    const wrongVersion = stateWith((s) =>
      projectionFrame(s, 'request-snapshots', 2, { system: [], header: [] }),
    );
    expect(snapshotsOf(wrongVersion)).toBeUndefined();
    expect(PROJECTION).toBe('projection');
  });
});

describe('輪的起因標籤', () => {
  it('前景子代理的 run（#1070）有自己的字，不跟別種起因混在一起', () => {
    expect(TURN_KIND_LABEL.run).toBe('子代理的一段執行');
    const labels = Object.values(TURN_KIND_LABEL);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

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
  approvalCodeText,
  clockText,
  durationText,
  FAILURE_CODE_LABEL,
  failureCodeText,
  failureReasonText,
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
    [decision('interrupt', 1, { id: 'q1' }), '停下來等人決定'],
    [
      decision('interrupt', 1, { approval: { tool: 'bash' } }),
      '核准 bash：還沒有結局（還沒回答，或停在這裡就關掉了）',
    ],
    [
      decision('interrupt', 1, { approval: { tool: 'bash', outcome: 'allowed-once' } }),
      '核准 bash：允許一次',
    ],
    [
      decision('interrupt', 1, {
        approval: { tool: 'bash', outcome: 'rejected', decidedAt: 1_700_000_000_001 + 12_000 },
      }),
      '核准 bash：已拒絕（等了 12.0 秒）',
    ],
    [
      decision('interrupt', 1, { approval: { tool: 'bash', outcome: 'cancelled' } }),
      '核准 bash：已取消',
    ],
    [
      decision('interrupt', 1, { approval: { tool: 'bash', outcome: 'unavailable' } }),
      '核准 bash：無法回答',
    ],
    [
      decision('interrupt', 1, { approval: { tool: 'bash', outcome: 'future' as never } }),
      '核准 bash：future',
    ],
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

describe('approvalCodeText：核准被拒的碼', () => {
  it.each([
    ['APPROVAL_POLICY_NEVER', '核准政策一律不允許'],
    ['APPROVAL_NO_CHANNEL', '沒有人可以問'],
    ['APPROVAL_REJECTED_BY_USER', '人拒絕了'],
    ['APPROVAL_INVALID_REPLY', '回覆看不懂，沒有執行'],
    ['TOOL_DENIED_BY_LISTENER', '被攔截器拒絕'],
  ])('%s → %s', (code, text) => {
    expect(approvalCodeText(code)).toBe(text);
  });

  it.each(['UNKNOWN_TOOL', 'ABORTED', '', 'constructor', 'toString', '__proto__'])(
    '%j 不是核准的碼 → undefined',
    (code) => {
      expect(approvalCodeText(code)).toBeUndefined();
    },
  );
});

describe('失敗碼：一句話，不認得的原樣顯示', () => {
  it('每個 harness 送的詞彙都有一句話（#1121）', () => {
    const vocabulary = [
      'AUTH',
      'QUOTA',
      'RATE_LIMIT',
      'CONTEXT_WINDOW_EXCEEDED',
      'INVALID_REQUEST',
      'SERVER',
      'TIMEOUT',
      'TRANSPORT',
      'EMPTY_RESPONSE',
      'LOCAL_CAPACITY',
      'INVALID_CREDENTIAL',
      'NESTING_TOO_DEEP',
      'UNKNOWN',
    ];
    for (const code of vocabulary) {
      expect(failureCodeText(code), code).toBe(FAILURE_CODE_LABEL[code]);
      expect(failureCodeText(code), code).not.toBe(code);
    }
    expect(failureCodeText('QUOTA')).toBe('額度用盡');
    expect(failureCodeText('EMPTY_RESPONSE')).toBe('回覆是空的');
    // 本機的碼（#1505、#1632）：講明是這台主機在排隊、請求沒送出，不是供應商那邊的「被限流」或「逾時」。
    expect(failureCodeText('LOCAL_CAPACITY')).toBe('本機排隊太久，請求沒送出，可稍後再送');
    // 本機的金鑰格式不對（#1541、#1652）：請求沒送出，跟供應商拒收的「驗證失敗」分開；重送沒用，要管理者修。
    expect(failureCodeText('INVALID_CREDENTIAL')).toBe(
      '本機金鑰格式不對，請求沒送出，重送無效，請管理者修正',
    );
    // 巢狀太深（#1668、#1753）：講是訊息的形狀、這一輪沒做完，不提層數。
    expect(failureCodeText('NESTING_TOO_DEEP')).toBe('這則訊息巢狀太深，這一輪沒有完成');
  });

  it('重試列的原因：帶了 HTTP 狀態就接在後面，碼本身是同一個 HTTP_<n> 只寫一次（#1449）', () => {
    expect(failureReasonText('RATE_LIMIT', 429)).toBe('被限流 · HTTP 429');
    expect(failureReasonText('HTTP_404', 404)).toBe('HTTP 404');
    expect(failureReasonText('EMPTY_RESPONSE')).toBe('回覆是空的');
    expect(failureReasonText('NEW_KIND', 503)).toBe('NEW_KIND · HTTP 503');
  });

  it('HTTP_<n> 寫成「HTTP <n>」', () => {
    expect(failureCodeText('HTTP_404')).toBe('HTTP 404');
    expect(failureCodeText('HTTP_418')).toBe('HTTP 418');
  });

  it('不認得的碼原樣顯示：不猜、不改成「原因不明」；HTTP_ 後面不是三位數也不算', () => {
    expect(failureCodeText('NEW_KIND')).toBe('NEW_KIND');
    expect(failureCodeText('HTTP_')).toBe('HTTP_');
    expect(failureCodeText('HTTP_4040')).toBe('HTTP_4040');
    expect(failureCodeText('HTTP_4x4')).toBe('HTTP_4x4');
    expect(failureCodeText('http_404')).toBe('http_404');
  });

  it('只認自己的鍵，原型上的名字不會被當成詞彙', () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(failureCodeText(name)).toBe(name);
    }
  });
});

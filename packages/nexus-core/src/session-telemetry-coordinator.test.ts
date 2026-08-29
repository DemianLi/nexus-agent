/**
 * 捕獲協調器：投影、脫敏折疊、圍堵、游標、關機。
 *
 * 對應 [#89](https://github.com/DemianLi/nexus-agent/issues/89) 的驗收：
 * 「脫敏折疊有一條實測——掛一個會拋的規則，那一筆記錄被扣住、agent loop 沒事」，
 * 以及「ledger 與 ops 兩個 channel 分得開，ops 記錄裡確實沒有 `event.seq` 那類識別」。
 */

import { describe, expect, it } from 'vitest';

import { fakeSink } from './fixtures.js';
import type { PluginOrigin } from './plugin.js';
import { SessionLog } from './session-log.js';
import { SessionTelemetryCoordinator } from './session-telemetry-coordinator.js';
import type { SessionTelemetryRedactRule } from './session-telemetry.js';
import type { NamedEntry } from './entries.js';

/** 包一條規則成註冊表那筆的形狀，讓錯誤訊息指得出是誰掛的。 */
function rule(
  name: string,
  index: number,
  fn: SessionTelemetryRedactRule,
): NamedEntry<SessionTelemetryRedactRule> {
  const origin: PluginOrigin = { index, name };
  return { value: fn, origin };
}

describe('ledger 投影', () => {
  it('每筆事件鏡像成一筆 ledger 記錄，識別只有那三個', () => {
    const log = new SessionLog('thread-a');
    const sink = fakeSink();
    new SessionTelemetryCoordinator({ log, sink });

    log.append('turn/start', { kind: 'message', text: '你好' });

    expect(sink.records).toHaveLength(1);
    const record = sink.records[0]!;
    expect(record.channel).toBe('ledger');
    expect(record.severity).toBe('info');
    expect(record.attributes).toEqual({
      'session.id': 'thread-a',
      'event.type': 'turn/start',
      'event.seq': 0,
    });
    expect(record.body).toEqual({ kind: 'message', text: '你好' });
  });

  it('沒有來源的 dsh 欄位就是不在：cwd / parent_id / seed_length 一個都不出現', () => {
    const log = new SessionLog('thread-a');
    const sink = fakeSink();
    new SessionTelemetryCoordinator({ log, sink });
    log.append('turn/end', {});

    const keys = Object.keys(sink.records[0]!.attributes);
    expect(keys).not.toContain('session.cwd');
    expect(keys).not.toContain('session.parent_id');
    expect(keys).not.toContain('session.seed_length');
  });

  it('turn/failed 是 error，其餘是 info', () => {
    const log = new SessionLog('thread-a');
    const sink = fakeSink();
    new SessionTelemetryCoordinator({ log, sink });

    log.append('turn/start', { kind: 'resume' });
    log.append('interrupt/raised', { interruptId: 'i-1' });
    log.append('turn/failed', { message: '模型炸了' });

    expect(sink.records.map((record) => record.severity)).toEqual(['info', 'info', 'error']);
  });

  it('time 是事件的 append 時間，不是送出的時間', () => {
    const log = new SessionLog('thread-a');
    const sink = fakeSink();
    new SessionTelemetryCoordinator({ log, sink });
    const event = log.append('turn/end', {});
    expect(sink.records[0]!.time).toBe(event.time);
  });

  it('live 建構時會補送日誌裡已經有的東西', () => {
    const log = new SessionLog('thread-a');
    log.append('turn/start', { kind: 'resume' });
    log.append('turn/end', {});

    const sink = fakeSink();
    new SessionTelemetryCoordinator({ log, sink });

    expect(sink.records.map((record) => record.attributes['event.seq'])).toEqual([0, 1]);
  });

  it('on-demand 不訂閱，只有被叫到才讀，而且不重送已經交過的', () => {
    const log = new SessionLog('thread-a');
    const sink = fakeSink();
    const coordinator = new SessionTelemetryCoordinator({ log, sink, capture: 'on-demand' });

    log.append('turn/start', { kind: 'resume' });
    expect(sink.records).toHaveLength(0);

    coordinator.captureNow();
    expect(sink.records).toHaveLength(1);

    log.append('turn/end', {});
    coordinator.captureNow();
    expect(sink.records.map((record) => record.attributes['event.seq'])).toEqual([0, 1]);
  });
});

describe('脫敏折疊', () => {
  it('沒有規則時記錄原樣通過', () => {
    const log = new SessionLog('thread-a');
    const sink = fakeSink();
    new SessionTelemetryCoordinator({ log, sink, rules: () => [] });
    log.append('turn/start', { kind: 'message', text: 'sk-abc123' });
    expect(sink.records[0]!.body).toEqual({ kind: 'message', text: 'sk-abc123' });
  });

  it('多條規則依註冊順序折疊：前一條的產物是後一條的輸入', () => {
    const log = new SessionLog('thread-a');
    const sink = fakeSink();
    new SessionTelemetryCoordinator({
      log,
      sink,
      rules: () => [
        rule('scrub', 0, (record) => ({
          ...record,
          body: { ...(record.body as object), step: 1 },
        })),
        rule('stamp', 1, (record) => ({
          ...record,
          body: { ...(record.body as object), step: 2 },
        })),
      ],
    });

    log.append('turn/end', {});
    expect(sink.records[0]!.body).toEqual({ step: 2 });
  });

  it('規則是現讀的：補送歷史時套的是「現在」掛著的策略', () => {
    const log = new SessionLog('thread-a');
    const sink = fakeSink();
    let mounted: NamedEntry<SessionTelemetryRedactRule>[] = [];
    const coordinator = new SessionTelemetryCoordinator({
      log,
      sink,
      capture: 'on-demand',
      rules: () => mounted,
    });

    log.append('turn/start', { kind: 'message', text: 'sk-abc123' });
    mounted = [rule('scrub', 0, (record) => ({ ...record, body: { redacted: true } }))];
    coordinator.captureNow();

    expect(sink.records[0]!.body).toEqual({ redacted: true });
  });

  it('規則拋錯 → 那一筆被扣住、指得出是誰掛的、append 本身沒事', () => {
    const log = new SessionLog('thread-a');
    const sink = fakeSink();
    const warnings: string[] = [];
    new SessionTelemetryCoordinator({
      log,
      sink,
      warn: (message) => void warnings.push(message),
      rules: () => [
        rule('leaky-rule', 2, () => {
          throw new Error('規則自己壞了');
        }),
      ],
    });

    // agent loop 那一側完全沒感覺：append 正常回傳、日誌照樣有這一筆。
    const event = log.append('turn/start', { kind: 'message', text: 'sk-abc123' });

    expect(event.seq).toBe(0);
    expect(log.length).toBe(1);
    // fail-closed：沒有半筆送出去，連沒脫敏的原始版本都沒有。
    expect(sink.records).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('plugins[2] (leaky-rule)');
    expect(warnings[0]).toContain('規則自己壞了');
  });

  it('被扣住的那筆不推進游標，補送時會再試一遍', () => {
    const log = new SessionLog('thread-a');
    const sink = fakeSink();
    let broken = true;
    const coordinator = new SessionTelemetryCoordinator({
      log,
      sink,
      warn: () => {},
      rules: () => [
        rule('flaky', 0, (record) => {
          if (broken) throw new Error('這次不行');
          return record;
        }),
      ],
    });

    log.append('turn/start', { kind: 'resume' });
    expect(sink.records).toHaveLength(0);

    broken = false;
    coordinator.captureNow();
    expect(sink.records.map((record) => record.attributes['event.seq'])).toEqual([0]);
  });
});

describe('圍堵', () => {
  it('後端 emit 拋錯只換來一行 warn，agent loop 那側照常', () => {
    const log = new SessionLog('thread-a');
    const warnings: string[] = [];
    const sink = fakeSink({
      onEmit: () => {
        throw new Error('後端炸了');
      },
    });
    new SessionTelemetryCoordinator({ log, sink, warn: (message) => void warnings.push(message) });

    expect(() => log.append('turn/end', {})).not.toThrow();
    expect(log.length).toBe(1);
    expect(warnings[0]).toContain('後端炸了');
  });
});

describe('flush 提示', () => {
  it('turn 的終結事件給提示，中途的事件不給', () => {
    const log = new SessionLog('thread-a');
    const sink = fakeSink();
    new SessionTelemetryCoordinator({ log, sink });

    log.append('turn/start', { kind: 'resume' });
    log.append('interrupt/raised', { interruptId: 'i-1' });
    expect(sink.flushes.count).toBe(0);

    log.append('turn/end', {});
    expect(sink.flushes.count).toBe(1);

    log.append('turn/start', { kind: 'resume' });
    log.append('turn/failed', { message: '壞了' });
    expect(sink.flushes.count).toBe(2);
  });
});

describe('關機', () => {
  it('發一筆 ops 的 shutdown，然後轉發後端的 shutdown()', async () => {
    const log = new SessionLog('thread-a');
    const sink = fakeSink();
    const coordinator = new SessionTelemetryCoordinator({ log, sink });
    log.append('turn/end', {});

    await coordinator.dispose();

    const last = sink.records.at(-1)!;
    expect(last.channel).toBe('ops');
    expect(last.attributes).toEqual({ 'telemetry.op': 'shutdown', 'session.id': 'thread-a' });
    // ops 記錄刻意不帶 ledger 的識別——帶了就可能被收端誤當成一列去重鍵。
    expect(Object.keys(last.attributes)).not.toContain('event.seq');
    expect(sink.shutdowns.count).toBe(1);
  });

  it('收掉之後就不再跟著日誌走', async () => {
    const log = new SessionLog('thread-a');
    const sink = fakeSink();
    const coordinator = new SessionTelemetryCoordinator({ log, sink });
    await coordinator.dispose();

    const before = sink.records.length;
    log.append('turn/end', {});
    expect(sink.records).toHaveLength(before);
  });

  it('dispose 第二次是 no-op', async () => {
    const log = new SessionLog('thread-a');
    const sink = fakeSink();
    const coordinator = new SessionTelemetryCoordinator({ log, sink });

    await coordinator.dispose();
    await coordinator.dispose();

    expect(sink.shutdowns.count).toBe(1);
    expect(sink.records.filter((record) => record.channel === 'ops')).toHaveLength(1);
  });

  it('後端關機失敗只換來一行 warn，dispose 自己不拋', async () => {
    const log = new SessionLog('thread-a');
    const warnings: string[] = [];
    const sink = fakeSink({
      onShutdown: () => {
        throw new Error('排空失敗');
      },
    });
    const coordinator = new SessionTelemetryCoordinator({
      log,
      sink,
      warn: (message) => void warnings.push(message),
    });

    await expect(coordinator.dispose()).resolves.toBeUndefined();
    expect(warnings.some((message) => message.includes('排空失敗'))).toBe(true);
  });
});

describe('交出去的是拷貝', () => {
  it('ledger 的 body 不是日誌裡那個物件', () => {
    const log = new SessionLog('thread-a');
    const sink = fakeSink();
    new SessionTelemetryCoordinator({ log, sink });

    const event = log.append('turn/start', { kind: 'message', text: '你好' });

    expect(sink.records[0]!.body).toEqual(event.data);
    // 借用的話後端或脫敏規則就地一改等於改寫歷史——這一條是那件事不可能發生的證據。
    expect(sink.records[0]!.body).not.toBe(event.data);
  });

  it('規則就地改動 body 不會碰到正典日誌', () => {
    const log = new SessionLog('thread-a');
    const sink = fakeSink();
    new SessionTelemetryCoordinator({
      log,
      sink,
      rules: () => [
        rule('mutating', 0, (record) => {
          (record.body as { text: string }).text = '[改過了]';
          return record;
        }),
      ],
    });

    const event = log.append('turn/start', { kind: 'message', text: 'sk-abc123' });

    expect(sink.records[0]!.body).toEqual({ kind: 'message', text: '[改過了]' });
    expect(event.data).toEqual({ kind: 'message', text: 'sk-abc123' });
  });
});

describe('flush 的圍堵自成一格', () => {
  it('flush 拋錯不會讓那一筆看起來像捕獲失敗', () => {
    const log = new SessionLog('thread-a');
    const warnings: string[] = [];
    const sink = fakeSink({
      onFlush: () => {
        throw new Error('flush 壞了');
      },
    });
    const coordinator = new SessionTelemetryCoordinator({
      log,
      sink,
      warn: (message) => void warnings.push(message),
      capture: 'on-demand',
    });

    log.append('turn/end', {});
    coordinator.captureNow();

    // 記錄真的交出去了，游標也推進了——所以補送不會再送一次。
    expect(sink.records).toHaveLength(1);
    coordinator.captureNow();
    expect(sink.records).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('flush 壞了');
  });
});

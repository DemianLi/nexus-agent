/**
 * 交付的配套入口：**每一筆交付都對得上一次成功的 `present` 呼叫**，外加形狀。
 *
 * 擋的是「有別的生產者繞過工具往日誌寫交付」——工具只在 `tools/result` 說結果不是錯誤時才寫（#1286 起同步寫，
 * 交付在配對的 `tool/result` 之前；更早的日誌在它之後），所以兩種次序都合法，錯誤的結果不合法。
 */

import { describe, expect, it } from 'vitest';

import { createInvariantRunner, createRegistry, SessionLog } from '@nexus/core';
import type { InvariantError } from '@nexus/core';

import {
  createPresentInvariantPlugin,
  PRESENT_INVARIANT_PACKAGE,
  presentDeliveryInvariant,
} from './invariant.js';
import { PRESENT_TOOL_NAME } from './index.js';

/** 接上配套入口，回收到的違規。 */
function watch(log: SessionLog): InvariantError[] {
  const violations: InvariantError[] = [];
  createInvariantRunner({
    log,
    companions: [
      {
        packageName: PRESENT_INVARIANT_PACKAGE,
        installer: presentDeliveryInvariant,
        origin: { id: 'present-invariant#0', name: 'present-invariant' },
      },
    ],
    onViolation: (error) => violations.push(error),
    warn: (message) => {
      throw new Error(`不該有 warn：${message}`);
    },
  });
  return violations;
}

/** 一次成功的 `present`：呼叫、結果。 */
function presented(log: SessionLog, callId: string, isError = false): void {
  log.append('tool/call', { callId, name: PRESENT_TOOL_NAME, arguments: '{}' });
  log.append('tool/result', { callId, isError });
}

const FILES = [{ path: 'a.md', description: '說明' }, { path: 'b.md' }];

describe('合法的日誌', () => {
  it('新次序（#1286，同 dsh）：呼叫、交付、結果：零違規', () => {
    const log = new SessionLog('new-order');
    const violations = watch(log);
    log.append('tool/call', { callId: 'c1', name: PRESENT_TOOL_NAME, arguments: '{}' });
    log.append('deliverables/presented', { callId: 'c1', files: FILES });
    log.append('tool/result', { callId: 'c1', isError: false });
    expect(violations).toEqual([]);
  });

  it('舊日誌（#1286 之前）：成功的呼叫之後交付一次，零違規', () => {
    const log = new SessionLog('ok');
    const violations = watch(log);
    presented(log, 'c1');
    log.append('deliverables/presented', { callId: 'c1', files: FILES });
    presented(log, 'c2');
    log.append('deliverables/presented', { callId: 'c2', files: [{ path: 'c.md' }] });
    expect(violations).toEqual([]);
  });
});

describe('配對', () => {
  it('前面沒有那顆呼叫', () => {
    const log = new SessionLog('orphan');
    const violations = watch(log);
    log.append('deliverables/presented', { callId: 'nobody', files: FILES });
    expect(violations.map((error) => error.message)).toEqual([
      expect.stringContaining('前面沒有一顆 present 的 tool/call'),
    ]);
  });

  it('那顆呼叫叫的不是 present', () => {
    const log = new SessionLog('other-tool');
    const violations = watch(log);
    log.append('tool/call', { callId: 'c1', name: 'write_file', arguments: '{}' });
    log.append('tool/result', { callId: 'c1', isError: false });
    log.append('deliverables/presented', { callId: 'c1', files: FILES });
    expect(violations.map((error) => error.message)).toEqual([
      expect.stringContaining('前面沒有一顆 present 的 tool/call'),
    ]);
  });

  it('結果還沒落定就交付：合法（新次序下交付寫的時候結果本來就還沒記）', () => {
    const log = new SessionLog('early');
    const violations = watch(log);
    log.append('tool/call', { callId: 'c1', name: PRESENT_TOOL_NAME, arguments: '{}' });
    log.append('deliverables/presented', { callId: 'c1', files: FILES });
    expect(violations).toEqual([]);
  });

  it('交付之後來的結果是錯誤（新次序）', () => {
    const log = new SessionLog('failed-after');
    const violations = watch(log);
    log.append('tool/call', { callId: 'c1', name: PRESENT_TOOL_NAME, arguments: '{}' });
    log.append('deliverables/presented', { callId: 'c1', files: FILES });
    log.append('tool/result', { callId: 'c1', isError: true });
    expect(violations.map((error) => error.message)).toEqual([
      expect.stringContaining('那次呼叫的 tool/result'),
    ]);
  });

  it('那次呼叫的結果是錯誤（舊次序：結果在交付之前）', () => {
    const log = new SessionLog('failed');
    const violations = watch(log);
    presented(log, 'c1', true);
    log.append('deliverables/presented', { callId: 'c1', files: FILES });
    expect(violations.map((error) => error.message)).toEqual([
      expect.stringContaining('那次呼叫的結果是錯誤'),
    ]);
  });

  it('同一次呼叫交付兩次（新次序：兩次都在結果之前）', () => {
    const log = new SessionLog('twice-new');
    const violations = watch(log);
    log.append('tool/call', { callId: 'c1', name: PRESENT_TOOL_NAME, arguments: '{}' });
    log.append('deliverables/presented', { callId: 'c1', files: FILES });
    log.append('deliverables/presented', { callId: 'c1', files: FILES });
    log.append('tool/result', { callId: 'c1', isError: false });
    expect(violations.map((error) => error.message)).toEqual([
      expect.stringContaining('已經交付過一次'),
    ]);
  });

  it('同一次呼叫交付兩次', () => {
    const log = new SessionLog('twice');
    const violations = watch(log);
    presented(log, 'c1');
    log.append('deliverables/presented', { callId: 'c1', files: FILES });
    log.append('deliverables/presented', { callId: 'c1', files: FILES });
    expect(violations.map((error) => error.message)).toEqual([
      expect.stringContaining('已經交付過一次'),
    ]);
  });
});

describe('形狀', () => {
  it('空的 files、空白的 path、不是字串的 description 都報', () => {
    const cases: unknown[] = [[], [{ path: '  ' }], [{ path: 'a', description: 1 }]];
    for (const [index, files] of cases.entries()) {
      const log = new SessionLog(`shape-${index}`);
      const violations = watch(log);
      presented(log, 'c1');
      log.append('deliverables/presented', { callId: 'c1', files: files as never });
      expect(violations, JSON.stringify(files)).toHaveLength(1);
    }
  });
});

describe('掛上去', () => {
  it('配套入口認領自己的包名', () => {
    const registry = createRegistry();
    const plugin = createPresentInvariantPlugin();
    const exit = registry.enter({ id: 'present-invariant#0', name: plugin.plugin.name });
    void plugin.plugin.apply(registry, undefined);
    exit();
    expect(registry.invariants.companions().map((entry) => entry.packageName)).toEqual([
      PRESENT_INVARIANT_PACKAGE,
    ]);
  });
});

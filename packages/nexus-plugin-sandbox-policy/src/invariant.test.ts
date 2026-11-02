/**
 * `sandbox/mode` 的詞彙，**走真的 runner**（[#699](https://github.com/DemianLi/nexus-agent/issues/699)）。
 *
 * 不直接呼叫 installer：那樣驗不到 `register()` 有沒有把包名接上、也驗不到違規會不會
 * 真的從 `onViolation` 出來。續接的那一條（日誌在安裝之前就有東西）走的是重播，所以
 * 安裝前寫進去的與安裝後追加的各驗一次。
 */

import { describe, expect, it } from 'vitest';
import { SANDBOX_MODES, SessionLog, createInvariantRunner, createRegistry } from '@nexus/core';
import type { InvariantError, PluginOrigin } from '@nexus/core';
import { createSandboxPolicyInvariantPlugin } from './invariant.js';

const origin: PluginOrigin = {
  id: 'sandbox-policy-invariant#0',
  name: 'sandbox-policy-invariant',
};

/**
 * 一份日誌 ＋ 掛好的檢查。
 *
 * `seed` 是**安裝之前**就寫進去的事件，用來驗重播那一段——續接讀回來的日誌就是這樣進來的。
 */
function watched(seed: (log: SessionLog) => void = () => {}) {
  const log = new SessionLog('t');
  seed(log);

  const registry = createRegistry();
  const leave = registry.enter(origin);
  createSandboxPolicyInvariantPlugin().plugin.apply(registry, undefined);
  leave();

  const violations: string[] = [];
  createInvariantRunner({
    log,
    companions: registry.invariants.companions(),
    onViolation: (error: InvariantError) => violations.push(error.message),
    warn: (message) => {
      throw new Error(`檢查自己壞了：${message}`);
    },
  });
  return { log, violations };
}

/** 寫一顆模式。型別只收認得的三個，日誌從磁碟讀回來的那條路上沒有這道擋，所以這裡繞過它。 */
function mode(log: SessionLog, value: unknown): void {
  log.append('sandbox/mode', { mode: value } as never);
}

describe('認得的模式不誤報', () => {
  it('三個合法模式，安裝前後都不報', () => {
    const { log, violations } = watched((seeded) => {
      for (const value of SANDBOX_MODES) mode(seeded, value);
    });
    for (const value of SANDBOX_MODES) mode(log, value);
    expect(violations).toEqual([]);
  });
});

describe('認不得的模式', () => {
  it('安裝後追加的：報出來，帶 seq、那個值與包名', () => {
    const { log, violations } = watched();
    mode(log, 'workspace-write');
    mode(log, 'bogus');
    expect(violations).toEqual([expect.stringContaining('"@nexus/plugin-sandbox-policy"')]);
    expect(violations[0]).toContain('seq 1');
    expect(violations[0]).toContain('"bogus"');
  });

  it('安裝前就在日誌裡的（續接的 seed）：重播時報出來', () => {
    const { violations } = watched((seeded) => mode(seeded, 'bogus'));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('seq 0');
    expect(violations[0]).toContain('"bogus"');
  });

  /** 讀回來的純物件連字串都不保證；缺席也算認不得。 */
  it('不是字串、整格缺席：一樣報', () => {
    const { log, violations } = watched();
    mode(log, 1);
    // 日誌只收純 JSON，`{ mode: undefined }` 寫不進去；磁碟上長得出來的是整格不在。
    log.append('sandbox/mode', {} as never);
    expect(violations).toHaveLength(2);
    expect(violations[0]).toContain('mode 是 1');
    expect(violations[1]).toContain('mode 是 undefined');
  });

  it('別的事件種類不看', () => {
    const { log, violations } = watched();
    log.append('turn/start', { kind: 'message', text: 'bogus' });
    expect(violations).toEqual([]);
  });
});

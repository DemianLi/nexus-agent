/**
 * `/plan` 的參數契約，**走真的 runner**。
 *
 * 不直接呼叫 installer：那樣驗不到 `register()` 有沒有把包名接上、也驗不到違規會不會
 * 真的從 `onViolation` 出來。這個檔案要證明的是**這個配套入口不再是在掃空氣**——
 * 它是全樹第三個真的裝上觀察者的（前兩個是 `@nexus/core` 與 `@nexus/plugin-commands`）。
 *
 * 對應 [#120](https://github.com/DemianLi/nexus-agent/issues/120)。
 */

import { describe, expect, it } from 'vitest';
import { SessionLog, createInvariantRunner, createRegistry } from '@nexus/core';
import type { InvariantError, PluginOrigin } from '@nexus/core';
import { PLAN_COMMAND_NAME } from './command.js';
import { createPlanModeInvariantPlugin } from './invariant.js';

const origin: PluginOrigin = { id: 'plan-mode-invariant#0', name: 'plan-mode-invariant' };

/**
 * 一份日誌 ＋ 掛好的檢查。
 *
 * `seed` 是**安裝之前**就寫進去的事件，用來驗重播那一段——協調器晚於日誌成立是常態。
 */
function watched(seed: (log: SessionLog) => void = () => {}) {
  const log = new SessionLog('t');
  seed(log);

  const registry = createRegistry();
  const leave = registry.enter(origin);
  createPlanModeInvariantPlugin().apply(registry);
  leave();

  const violations: string[] = [];
  const detach = createInvariantRunner({
    log,
    companions: registry.invariants.companions(),
    onViolation: (error: InvariantError) => violations.push(error.message),
    warn: (message) => {
      throw new Error(`檢查自己壞了：${message}`);
    },
  });
  return { log, violations, detach };
}

function run(log: SessionLog, commandId: string, args: string, name = PLAN_COMMAND_NAME): void {
  log.append('command/run', { commandId, name, args, source: { kind: 'user' } });
}

function done(log: SessionLog, commandId: string, kind: 'success' | 'error'): void {
  log.append('command/done', { commandId, kind });
}

describe('收得下的參數不誤報', () => {
  it('不帶參數與 off 都可以成功', () => {
    const { log, violations } = watched();
    run(log, 'cmd-1', '');
    done(log, 'cmd-1', 'success');
    run(log, 'cmd-2', ' off');
    done(log, 'cmd-2', 'success');
    expect(violations).toEqual([]);
  });

  /** 空白的處理要跟 handler 同一份判準——這正是那個共用模組存在的理由。 */
  it('只有空白也算不帶參數', () => {
    const { log, violations } = watched();
    run(log, 'cmd-1', '   ');
    done(log, 'cmd-1', 'success');
    expect(violations).toEqual([]);
  });

  /** 別人的命令不歸這條管，就算它的參數在我們的文法裡是非法的。 */
  it('不是 /plan 的一律不看', () => {
    const { log, violations } = watched();
    run(log, 'cmd-1', ' 隨便什麼', 'ping');
    done(log, 'cmd-1', 'success');
    expect(violations).toEqual([]);
  });
});

describe('收不下的參數必須落定成 error', () => {
  it('落成 success 就是違規，而且訊息帶得出那個參數', () => {
    const { log, violations } = watched();
    run(log, 'cmd-1', ' of');
    done(log, 'cmd-1', 'success');

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('@nexus/plugin-plan-mode');
    expect(violations[0]).toContain('of');
  });

  it('落成 error 就沒事', () => {
    const { log, violations } = watched();
    run(log, 'cmd-1', ' of');
    done(log, 'cmd-1', 'error');
    expect(violations).toEqual([]);
  });

  /**
   * **安裝之前就寫進去的也要看。** runner 會重播，而配套入口通常晚於日誌成立——
   * 只看安裝之後的話，一條真的 REPL 上最早的那幾筆永遠檢不到。
   */
  it('重播進來的一樣報得出來', () => {
    const { violations } = watched((log) => {
      run(log, 'cmd-1', ' 亂打的');
      done(log, 'cmd-1', 'success');
    });
    expect(violations).toHaveLength(1);
  });

  /**
   * **非法的那一次落定之後就不再追。** 不重設的話，下一次合法的 `/plan` 落成 success
   * 會被算到上一次頭上——那是誤報，而誤報會讓人開始無視這條檢查。
   */
  it('下一次合法的執行不會被算到上一次頭上', () => {
    const { log, violations } = watched();
    run(log, 'cmd-1', ' of');
    done(log, 'cmd-1', 'error');
    run(log, 'cmd-2', '');
    done(log, 'cmd-2', 'success');
    expect(violations).toEqual([]);
  });
});

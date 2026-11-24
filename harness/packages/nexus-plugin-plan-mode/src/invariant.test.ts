/**
 * `/plan` 的方向與 `plan/mode` 的形狀，**走真的 runner**。
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
import type {} from '@nexus/plugin-commands';
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
  createPlanModeInvariantPlugin().plugin.apply(registry, undefined);
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

function mode(log: SessionLog, active: boolean): void {
  log.append('plan/mode', { active });
}

describe('方向對的不誤報', () => {
  it('不帶參數開、off 關', () => {
    const { log, violations } = watched();
    run(log, 'cmd-1', '');
    mode(log, true);
    done(log, 'cmd-1', 'success');
    run(log, 'cmd-2', ' off');
    mode(log, false);
    done(log, 'cmd-2', 'success');
    expect(violations).toEqual([]);
  });

  /** 空白的處理要跟 handler 同一份判準——這正是那個共用模組存在的理由。 */
  it('只有空白也算不帶參數，帶話的也是開', () => {
    const { log, violations } = watched();
    run(log, 'cmd-1', '   ');
    mode(log, true);
    done(log, 'cmd-1', 'success');
    run(log, 'cmd-2', ' 幫我規劃 ');
    mode(log, true);
    done(log, 'cmd-2', 'success');
    expect(violations).toEqual([]);
  });

  /** 本來就在那個模式：命令沒寫 `plan/mode`，沒有東西可檢，不算違規。 */
  it('沒寫 plan/mode 的 noop 不報', () => {
    const { log, violations } = watched();
    run(log, 'cmd-1', ' off');
    done(log, 'cmd-1', 'success');
    expect(violations).toEqual([]);
  });

  /** 別人的命令不歸這條管，就算它旁邊有人寫了 `plan/mode`。 */
  it('不是 /plan 的一律不看', () => {
    const { log, violations } = watched();
    run(log, 'cmd-1', ' off', 'ping');
    mode(log, true);
    done(log, 'cmd-1', 'success');
    expect(violations).toEqual([]);
  });

  /** 命令之外的 `plan/mode`（例如 `exit_plan_mode` 同意之後）方向不受命令約束。 */
  it('落定之後的 plan/mode 不歸命令管', () => {
    const { log, violations } = watched();
    run(log, 'cmd-1', ' off');
    done(log, 'cmd-1', 'success');
    mode(log, true);
    expect(violations).toEqual([]);
  });
});

describe('方向必須跟參數一致', () => {
  it('off 卻寫成開就是違規，訊息帶得出參數與方向', () => {
    const { log, violations } = watched();
    run(log, 'cmd-1', ' off');
    mode(log, true);
    done(log, 'cmd-1', 'success');

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('@nexus/plugin-plan-mode');
    expect(violations[0]).toContain('off');
    expect(violations[0]).toContain('active: true');
  });

  it('進入卻寫成關也是違規', () => {
    const { log, violations } = watched();
    run(log, 'cmd-1', ' 幫我規劃');
    mode(log, false);
    done(log, 'cmd-1', 'success');
    expect(violations).toHaveLength(1);
  });

  /**
   * **安裝之前就寫進去的也要看。** runner 會重播，而配套入口通常晚於日誌成立——
   * 只看安裝之後的話，一條真的 REPL 上最早的那幾筆永遠檢不到。
   */
  it('重播進來的一樣報得出來', () => {
    const { violations } = watched((log) => {
      run(log, 'cmd-1', ' off');
      mode(log, true);
      done(log, 'cmd-1', 'success');
    });
    expect(violations).toHaveLength(1);
  });

  /**
   * **落定之後就不再追。** 不重設的話，下一次命令之外的 `plan/mode` 會被算到上一次頭上
   * ——那是誤報，而誤報會讓人開始無視這條檢查。
   */
  it('落定之後不再追那一次', () => {
    const { log, violations } = watched();
    run(log, 'cmd-1', ' off');
    mode(log, false);
    done(log, 'cmd-1', 'success');
    mode(log, true);
    expect(violations).toEqual([]);
  });
});

/**
 * `plan/mode` 的形狀，照 dsh 那一條：`active` 只收布林。
 *
 * **型別擋得住 `append`，擋不住從磁碟讀回來的那一份。** `--resume` 的 seed 是 `JSON.parse`
 * 出來的純物件，一路到這裡型別什麼都沒保證——所以用一份帶 seed 的日誌驗，而且它是重播進來的。
 */
describe('plan/mode 只收布林', () => {
  it('布林不報，兩個值都是', () => {
    const { log, violations } = watched();
    log.append('plan/mode', { active: true });
    log.append('plan/mode', { active: false });
    expect(violations).toEqual([]);
  });

  it('從 seed 讀回來的壞形狀報得出來，而且說得出是哪一顆', () => {
    const seed = [{ type: 'plan/mode', seq: 0, time: 1, data: { active: 'yes' } }];
    const log = new SessionLog('t', { seed: seed as never });

    const registry = createRegistry();
    const leave = registry.enter(origin);
    createPlanModeInvariantPlugin().plugin.apply(registry, undefined);
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

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('seq 0');
    expect(violations[0]).toContain('"yes"');
  });
});

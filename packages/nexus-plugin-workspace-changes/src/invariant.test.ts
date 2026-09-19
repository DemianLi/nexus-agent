import { describe, expect, it } from 'vitest';

import { createInvariantRunner, createRegistry, SessionLog } from '@nexus/core';

import {
  createWorkspaceChangesInvariantPlugin,
  WORKSPACE_CHANGES_INVARIANT_PACKAGE,
  workspaceChangesInvariant,
} from './invariant.js';

function watch(log: SessionLog): string[] {
  const violations: string[] = [];
  createInvariantRunner({
    log,
    companions: [
      {
        packageName: WORKSPACE_CHANGES_INVARIANT_PACKAGE,
        installer: workspaceChangesInvariant,
        origin: { id: 'workspace-changes-invariant#0', name: 'workspace-changes-invariant' },
      },
    ],
    onViolation: (error) => violations.push(error.message),
    warn: (message) => {
      throw new Error(`不該有 warn：${message}`);
    },
  });
  return violations;
}

describe('workspace/changes 的配套入口', () => {
  it('跑過工具的一輪裡記一顆、之後再記一顆取代它、核准接回來的那一段也算同一輪：零違規', () => {
    const log = new SessionLog('ok');
    const violations = watch(log);
    log.append('turn/start', { kind: 'message', text: '改。' });
    log.append('tool/result', { callId: 'c1', isError: false });
    log.append('interrupt/raised', { interruptId: 'i' });
    log.append('turn/end', {});
    log.append('turn/start', { kind: 'resume' });
    log.append('workspace/changes', {});
    log.append('workspace/changes', {});
    log.append('turn/end', {});
    expect(violations).toEqual([]);
  });

  it('前面沒有 turn/start（子代理那一份就是這樣）', () => {
    const log = new SessionLog('orphan');
    const violations = watch(log);
    log.append('tool/result', { callId: 'c1', isError: false });
    log.append('workspace/changes', {});
    expect(violations).toEqual([expect.stringContaining('前面沒有 turn/start')]);
  });

  it('所在的那一輪沒有 tool/result：上一輪的結果不算', () => {
    const log = new SessionLog('no-tools');
    const violations = watch(log);
    log.append('turn/start', { kind: 'message', text: '改。' });
    log.append('tool/result', { callId: 'c1', isError: false });
    log.append('turn/end', {});
    log.append('turn/start', { kind: 'message', text: '聊天。' });
    log.append('workspace/changes', {});
    expect(violations).toEqual([expect.stringContaining('沒有任何 tool/result')]);
  });

  it('資料不是空的', () => {
    const log = new SessionLog('data');
    const violations = watch(log);
    log.append('turn/start', { kind: 'message', text: '改。' });
    log.append('tool/result', { callId: 'c1', isError: false });
    log.append('workspace/changes', { turn: 1 } as never);
    expect(violations).toEqual([expect.stringContaining('資料要是空的')]);
  });

  it('配套入口認領自己的包名', () => {
    const registry = createRegistry();
    const plugin = createWorkspaceChangesInvariantPlugin();
    const exit = registry.enter({ id: 'workspace-changes-invariant#0', name: plugin.name });
    void plugin.apply(registry);
    exit();
    expect(registry.invariants.companions().map((entry) => entry.packageName)).toEqual([
      WORKSPACE_CHANGES_INVARIANT_PACKAGE,
    ]);
  });
});

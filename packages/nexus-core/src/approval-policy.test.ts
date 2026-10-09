/**
 * 核准政策旋鈕的驗收（[#437](https://github.com/DemianLi/nexus-agent/issues/437)）：控制器、日誌上的痕跡、續接讀回，
 * 以及 `approval-gate` 那一列怎麼把它接上每一份日誌。
 *
 * 每一條驗收都配反例：「切換會寫事件」配「淨變化為零不寫」，「接上就釘起始值」配「已經是那一格不再釘」。
 */

import { describe, expect, it } from 'vitest';

import { approvalGatePlugin } from './approval.js';
import {
  APPROVAL_POLICY_SERVICE,
  ApprovalPolicyController,
  isApprovalPolicy,
  recordedApprovalPolicy,
} from './approval-policy.js';
import type { PluginRegistry } from './registry.js';
import { SessionLog } from './session-log.js';
import type { SessionInstaller } from './sessions.js';

const policiesOf = (log: SessionLog) =>
  log.events.filter((event) => event.type === 'approval/policy').map((event) => event.data);

describe('ApprovalPolicyController', () => {
  it('預設 ask；來源每次現讀，切換之後拿到新的一格', () => {
    const controller = new ApprovalPolicyController();
    expect(controller.current).toBe('ask');
    expect(controller.source()).toBe('ask');
    controller.switchTo('never');
    expect(controller.source()).toBe('never');
  });

  it('接上日誌就把起始值釘進去；切換再寫一顆；淨變化為零不寫', () => {
    const log = new SessionLog('t');
    const controller = new ApprovalPolicyController();
    controller.attach(log);
    expect(policiesOf(log)).toEqual([{ policy: 'ask' }]);

    expect(controller.switchTo('never')).toEqual({ kind: 'switched', from: 'ask', to: 'never' });
    expect(policiesOf(log)).toEqual([{ policy: 'ask' }, { policy: 'never' }]);

    expect(controller.switchTo('never')).toEqual({ kind: 'unchanged', policy: 'never' });
    expect(policiesOf(log)).toHaveLength(2);
  });

  it('日誌上最後一顆已經是這一格就不再釘（空轉的續接不讓日誌長）', () => {
    const log = new SessionLog('t');
    new ApprovalPolicyController('never').attach(log);
    expect(policiesOf(log)).toEqual([{ policy: 'never' }]);

    // 續接：控制器從日誌讀回的值起算，再接一次什麼都不寫。
    const again = new ApprovalPolicyController(recordedApprovalPolicy(log.events));
    again.attach(log);
    expect(policiesOf(log)).toEqual([{ policy: 'never' }]);

    // 反例：起始值不同（例如沒讀日誌）就要釘，日誌才答得出現在是哪一格。
    new ApprovalPolicyController('ask').attach(log);
    expect(policiesOf(log)).toEqual([{ policy: 'never' }, { policy: 'ask' }]);
  });

  it('收掉接線之後值照樣換得動，只是不再寫進那份日誌', () => {
    const log = new SessionLog('t');
    const controller = new ApprovalPolicyController();
    const detach = controller.attach(log);
    detach();
    controller.switchTo('never');
    expect(controller.current).toBe('never');
    expect(policiesOf(log)).toEqual([{ policy: 'ask' }]);
    expect(controller.attachedCount).toBe(0);
  });

  it('接了兩份日誌，切換每一份都寫', () => {
    const [a, b] = [new SessionLog('a'), new SessionLog('b')];
    const controller = new ApprovalPolicyController();
    controller.attach(a);
    controller.attach(b);
    controller.switchTo('never');
    expect(policiesOf(a)).toEqual([{ policy: 'ask' }, { policy: 'never' }]);
    expect(policiesOf(b)).toEqual([{ policy: 'ask' }, { policy: 'never' }]);
  });
});

describe('recordedApprovalPolicy', () => {
  it('取最後一顆；沒有就是 undefined（#437 以前的日誌，照 ask 起算）', () => {
    const log = new SessionLog('t');
    expect(recordedApprovalPolicy(log.events)).toBeUndefined();
    log.append('approval/policy', { policy: 'never' });
    log.append('approval/policy', { policy: 'ask' });
    expect(recordedApprovalPolicy(log.events)).toBe('ask');
  });

  it('子代理日誌上的 delegation 那顆不算：它記的是子代理自己的，不是 root 該續接的', () => {
    const log = new SessionLog('t');
    log.append('approval/policy', { policy: 'ask' });
    log.append('approval/policy', { policy: 'never', source: 'delegation' });
    expect(recordedApprovalPolicy(log.events)).toBe('ask');
  });
});

describe('isApprovalPolicy', () => {
  it('只認 ask 與 never（日誌讀回來、命令給的都沒有型別保證）', () => {
    expect(isApprovalPolicy('ask')).toBe(true);
    expect(isApprovalPolicy('never')).toBe(true);
    for (const bad of ['auto', 'ASK', '', undefined, null, 1]) {
      expect(isApprovalPolicy(bad)).toBe(false);
    }
  });
});

describe('approval-gate 那一列把控制器接上每一份日誌', () => {
  /** 只有 `apply` 用得到的兩格：服務與 sessions.join。 */
  function mount(controller: ApprovalPolicyController | undefined) {
    const installers: SessionInstaller[] = [];
    const registry = {
      services: {
        get: (name: string) => (name === APPROVAL_POLICY_SERVICE ? controller : undefined),
      },
      sessions: { join: (installer: SessionInstaller) => void installers.push(installer) },
    } as unknown as PluginRegistry;
    approvalGatePlugin.apply(registry);
    const subjectFor = (log: SessionLog, kind: 'root' | 'subagent' | 'foreground') =>
      ({
        log,
        address:
          kind === 'root'
            ? { kind }
            : // 背景子代理的編號以 `bg-` 開頭；前景的是 LangGraph 的命名空間（#328 第 1 項）。
              { kind: 'subagent', runId: kind === 'subagent' ? 'bg-0123456789ab' : 'tools:abc' },
      }) as unknown as Parameters<SessionInstaller>[0];
    return { installers, subjectFor };
  }

  it('root：接控制器，釘起始值', () => {
    const controller = new ApprovalPolicyController('never');
    const { installers, subjectFor } = mount(controller);
    const log = new SessionLog('root');
    installers[0]?.(subjectFor(log, 'root'));
    expect(policiesOf(log)).toEqual([{ policy: 'never' }]);
    controller.switchTo('ask');
    expect(policiesOf(log)).toEqual([{ policy: 'never' }, { policy: 'ask' }]);
  });

  it('背景子代理：一顆 never、source=delegation，不管 root 現在是哪一格；再開一次不重寫', () => {
    const controller = new ApprovalPolicyController('ask');
    const { installers, subjectFor } = mount(controller);
    const log = new SessionLog('root/child');
    installers[0]?.(subjectFor(log, 'subagent'));
    expect(policiesOf(log)).toEqual([{ policy: 'never', source: 'delegation' }]);
    installers[0]?.(subjectFor(log, 'subagent'));
    expect(policiesOf(log)).toHaveLength(1);
    // root 之後切換，子代理的日誌不動。
    controller.switchTo('never');
    expect(policiesOf(log)).toHaveLength(1);
  });

  it('前景子代理（#328 第 1 項）：什麼都不寫——它用 root 當下的政策，記 never 是假話', () => {
    const controller = new ApprovalPolicyController('ask');
    const { installers, subjectFor } = mount(controller);
    const log = new SessionLog('root/tools:abc');
    installers[0]?.(subjectFor(log, 'foreground'));
    expect(policiesOf(log)).toEqual([]);
    controller.switchTo('never');
    expect(policiesOf(log)).toEqual([]);
  });

  it('沒有人提供控制器（手搭的測試組裝）：什麼都不接', () => {
    const { installers } = mount(undefined);
    expect(installers).toHaveLength(0);
  });
});

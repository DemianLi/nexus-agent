/**
 * 核准閘門：waterfall 的語義，與**四個拒絕理由分不分得開**。
 *
 * 對應 [#111](https://github.com/DemianLi/nexus-agent/issues/111) 的驗收。
 * 這一份只驗純函式那一半（`runApprovalGate`）與 middleware 在**不需要真的問人**時的
 * 行為；「停下來問、恢復之後接得回去」需要真的跑一次 graph，那些在
 * `apps/harness/src/interrupt.test.ts`——那裡才有 checkpointer 與模型。
 *
 * **理由字串是這組測試的主體，不是裝飾。** 拍板 (b) 選了「兩個都要」，而政策與能力
 * 這兩件事唯一的區別就在模型收到的那句話：收斂成同一句，這一格的價值就沒了。
 */

import { describe, expect, it, vi } from 'vitest';
import {
  APPROVAL_GATE_MIDDLEWARE_NAME,
  createApprovalGateMiddleware,
  runApprovalGate,
} from './approval.js';
import type {
  ApprovalChannel,
  PreToolDecision,
  PreToolListener,
  ToolExecution,
} from './approval.js';
import type { NamedEntry } from './entries.js';

const exec: ToolExecution = { name: 'deploy_prod', args: { target: 'prod' }, callId: 'call-1' };

/** 掛一位 listener，附上一個假的來源——錯誤訊息要指得出是誰。 */
function entry(value: PreToolListener, id = 'ops#0'): NamedEntry<PreToolListener> {
  return { value, origin: { id, name: id.split('#')[0] ?? id } };
}

/** middleware 的 `wrapToolCall` 拿出來直接呼叫用的形狀。 */
type Wrapper = (
  request: { toolCall: { name: string; args: Record<string, unknown>; id?: string } },
  handler: (request: unknown) => Promise<unknown>,
) => Promise<{ text?: string; status?: string; content?: unknown }>;

function wrapperOf(
  listeners: readonly NamedEntry<PreToolListener>[],
  channel: ApprovalChannel,
): Wrapper {
  const middleware = createApprovalGateMiddleware(listeners, channel);
  const wrap = (middleware as { wrapToolCall?: Wrapper }).wrapToolCall;
  if (wrap === undefined) throw new Error('這個 middleware 沒有 wrapToolCall');
  return wrap;
}

/** 一次假的呼叫，附一個記錄自己有沒有被叫到的 handler。 */
function call() {
  const ran = vi.fn(async () => ({ text: '跑過了', status: 'success' }));
  const request = { toolCall: { name: exec.name, args: exec.args, id: exec.callId } };
  return { ran, request };
}

describe('waterfall', () => {
  it('沒有人掛 listener → allow', async () => {
    expect(await runApprovalGate([], exec)).toEqual({ kind: 'allow' });
  });

  it('依註冊順序跑，`next()` 委派給下一位', async () => {
    const seen: string[] = [];
    const decision = await runApprovalGate(
      [
        entry((_e, next) => {
          seen.push('a');
          return next();
        }, 'a#0'),
        entry((_e, next) => {
          seen.push('b');
          return next();
        }, 'b#0'),
      ],
      exec,
    );
    expect(seen).toEqual(['a', 'b']);
    expect(decision).toEqual({ kind: 'allow' });
  });

  it('**不呼叫 `next()` 就把後面的人整個短路掉**——那是 waterfall 刻意給的能力', async () => {
    const later = vi.fn(() => ({ kind: 'allow' }) as PreToolDecision);
    const decision = await runApprovalGate(
      [entry(() => ({ kind: 'deny', reason: '不准' })), entry(later, 'b#0')],
      exec,
    );
    expect(decision).toEqual({ kind: 'deny', reason: '不准' });
    expect(later).not.toHaveBeenCalled();
  });

  it('listener 看得到工具名與已解析的參數——那正是免掉字串比對的東西', async () => {
    const seen: ToolExecution[] = [];
    await runApprovalGate(
      [
        entry((e, next) => {
          seen.push(e);
          return next();
        }),
      ],
      exec,
    );
    expect(seen).toEqual([{ name: 'deploy_prod', args: { target: 'prod' }, callId: 'call-1' }]);
  });

  it('listener 拋錯 → 錯誤訊息指得出是清單裡的哪一個', async () => {
    await expect(
      runApprovalGate(
        [
          entry(() => {
            throw new Error('我壞了');
          }, 'ops#0'),
        ],
        exec,
      ),
    ).rejects.toThrow(/ops#0 \(ops\)[\s\S]*deploy_prod[\s\S]*我壞了/);
  });
});

describe('四個拒絕，四句不同的話', () => {
  it('listener 自己 deny → 用它給的理由，工具沒跑', async () => {
    const { ran, request } = call();
    const wrap = wrapperOf([entry(() => ({ kind: 'deny', reason: '線上時段禁止部署' }))], {
      kind: 'human',
    });
    const result = await wrap(request, ran);
    expect(ran).not.toHaveBeenCalled();
    expect(result.text).toBe('線上時段禁止部署');
    expect(result.status).toBe('error');
  });

  it('ask ✕ 政策關掉 → 說的是「沒有人被問到」，不是「有人拒絕」', async () => {
    const { ran, request } = call();
    const wrap = wrapperOf([entry(() => ({ kind: 'ask', reason: '會動到線上' }))], {
      kind: 'policy-never',
    });
    const result = await wrap(request, ran);
    expect(ran).not.toHaveBeenCalled();
    expect(result.status).toBe('error');
    expect(result.text).toContain('會動到線上');
    expect(result.text).toContain('關掉了人工核准');
    expect(result.text).toContain('沒有人被問到');
  });

  it('ask ✕ 沒有 checkpointer → 說的是「沒有可用的核准管道」', async () => {
    const { ran, request } = call();
    const wrap = wrapperOf([entry(() => ({ kind: 'ask' }))], { kind: 'no-channel' });
    const result = await wrap(request, ran);
    expect(ran).not.toHaveBeenCalled();
    expect(result.text).toContain('沒有 checkpointer');
    expect(result.text).toContain('沒有可用的核准管道');
  });

  it('**兩句話真的不一樣**——政策與能力收斂成同一句就等於把這一格丟掉', async () => {
    const wrapPolicy = wrapperOf([entry(() => ({ kind: 'ask' }))], { kind: 'policy-never' });
    const wrapChannel = wrapperOf([entry(() => ({ kind: 'ask' }))], { kind: 'no-channel' });
    const policy = await wrapPolicy(call().request, call().ran);
    const channel = await wrapChannel(call().request, call().ran);
    expect(policy.text).not.toBe(channel.text);
  });
});

describe('allow', () => {
  it('放行 → handler 真的被呼叫，回的是 handler 的東西', async () => {
    const { ran, request } = call();
    const wrap = wrapperOf([entry((_e, next) => next())], { kind: 'human' });
    const result = await wrap(request, ran);
    expect(ran).toHaveBeenCalledOnce();
    expect(result.status).toBe('success');
  });

  it('一個 listener 都沒有時照樣放行——閘門不是預設關著的', async () => {
    const { ran, request } = call();
    const wrap = wrapperOf([], { kind: 'human' });
    await wrap(request, ran);
    expect(ran).toHaveBeenCalledOnce();
  });
});

describe('middleware 本身', () => {
  it('名字固定——排序斷言與錯誤訊息靠它', () => {
    const middleware = createApprovalGateMiddleware([], { kind: 'human' });
    expect((middleware as { name?: string }).name).toBe(APPROVAL_GATE_MIDDLEWARE_NAME);
  });
});

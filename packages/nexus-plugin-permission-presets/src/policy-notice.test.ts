import type { SessionLog } from '@nexus/core';
import type { PreStepInjection } from '@nexus/agent-loop';
import { describe, expect, it } from 'vitest';

import {
  createPolicyNoticeListener,
  POLICY_NOTICE_LISTENER_NAME,
  PolicyNoticeLedger,
  policyNoticeText,
} from './policy-notice.js';

type Event = Parameters<PolicyNoticeLedger['advance']>[0];

const eventAt = (seq: number, type: string, data: unknown): Event =>
  ({ type, seq, time: 0, data }) as unknown as Event;

const SWITCH: readonly [string, unknown][] = [
  ['command/run', { commandId: 'c', name: 'permission', source: { kind: 'user' } }],
  ['approval/policy', { policy: 'never' }],
  ['command/done', { commandId: 'c', kind: 'success' }],
];
const DELIVERED: [string, unknown] = [
  'user/message',
  { source: { kind: 'plugin', plugin: POLICY_NOTICE_LISTENER_NAME } },
];

function ledgerOf(rows: readonly (readonly [string, unknown])[]): PolicyNoticeLedger {
  const ledger = new PolicyNoticeLedger();
  rows.forEach(([type, data], seq) => ledger.advance(eventAt(seq, type, data)));
  return ledger;
}

describe('PolicyNoticeLedger', () => {
  it('起始值與命令外的寫入不發', () => {
    const ledger = ledgerOf([
      ['approval/policy', { policy: 'ask' }],
      ['approval/policy', { policy: 'never' }],
    ]);
    expect(ledger.pending()).toEqual([]);
  });

  it('子代理委派那顆不算', () => {
    const ledger = ledgerOf([
      ['command/run', { name: 'permission' }],
      ['approval/policy', { policy: 'never', source: 'delegation' }],
    ]);
    expect(ledger.pending()).toEqual([]);
  });

  it('別的命令裡寫的不發', () => {
    const ledger = ledgerOf([
      ['command/run', { name: 'other' }],
      ['approval/policy', { policy: 'never' }],
    ]);
    expect(ledger.pending()).toEqual([]);
  });

  it('命令裡變了就排一則，通知落日誌才消掉', () => {
    expect(ledgerOf(SWITCH).pending()).toEqual([policyNoticeText('ask', 'never')]);
    expect(ledgerOf([...SWITCH, DELIVERED]).pending()).toEqual([]);
  });

  it('切換之後已有模型回覆、沒有通知（升級前的日誌）：過期，不補發', () => {
    const ledger = ledgerOf([...SWITCH, ['assistant/message', {}]]);
    expect(ledger.pending()).toEqual([]);
  });

  it('模型回覆之後的切換照發', () => {
    const ledger = ledgerOf([['assistant/message', {}], ...SWITCH]);
    expect(ledger.pending()).toEqual([policyNoticeText('ask', 'never')]);
  });

  it('每個政策值都有名稱', () => {
    expect(policyNoticeText('ask', 'never')).toBe(
      '使用者把核准政策從「詢問使用者核准」改成「不詢問使用者核准」。',
    );
    expect(policyNoticeText('never', 'ask')).toBe(
      '使用者把核准政策從「不詢問使用者核准」改成「詢問使用者核准」。',
    );
  });
});

describe('listener 的成本不隨日誌長度成長', () => {
  it('約 13 萬筆日誌：listener 不讀 log.events，未發的通知照樣拿得到', async () => {
    const ledger = new PolicyNoticeLedger();
    for (let seq = 0; seq < 130_000; seq += 1) {
      ledger.advance(eventAt(seq, 'assistant/message', {}));
    }
    SWITCH.forEach(([type, data], at) => ledger.advance(eventAt(130_000 + at, type, data)));
    const log = new Proxy(
      {},
      {
        get() {
          throw new Error('listener 不該碰日誌');
        },
      },
    ) as SessionLog;
    const listener = createPolicyNoticeListener(
      () => ledger,
      () => ({ kind: 'ok', log }) as never,
    );
    const got = (await listener([], {})) as readonly PreStepInjection[];
    expect(got.map((item) => item.content)).toEqual([policyNoticeText('ask', 'never')]);
  });

  it('沒有帳的日誌（子代理）：不發', async () => {
    const listener = createPolicyNoticeListener(
      () => undefined,
      () => ({ kind: 'ok', log: {} }) as never,
    );
    expect(await listener([], {})).toBeUndefined();
  });
});

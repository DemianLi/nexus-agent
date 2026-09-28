import type { Event, QuestionItem, ThreadFeedFrame, ThreadSummary } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { isPlanReview } from '@/lib/plan-review';
import {
  initialThreadStatus,
  pendingKindOf,
  reduceThreadStatus,
  rowStatus,
} from '@/lib/thread-status';
import type { ThreadStatusAction, ThreadStatusState } from '@/lib/thread-status';

/**
 * 側欄每一列的即時狀態（#632）。規則逐條抄 dsh `UiSession`，見 `thread-status.ts` 的檔頭；這裡一條規則一條測試。
 */

function requested(data: unknown, seq = 1): Event {
  return {
    type: 'event',
    seq,
    event_id: `t:${seq}`,
    method: 'input.requested',
    params: { namespace: ['tools:a'], timestamp: 0, data },
  } as Event;
}

const approval = (interruptId: string) =>
  requested({
    interrupt_id: interruptId,
    payload: {
      actionRequests: [{ name: 'alpha', args: {} }],
      reviewConfigs: [{ actionName: 'alpha', allowedDecisions: ['approve', 'reject'] }],
    },
  });

const PLAN: QuestionItem = {
  id: 'plan-review',
  question: '同意這份計劃嗎？',
  detail: '# 改登入頁',
  options: [{ label: '同意' }, { label: '繼續規劃' }],
  intent: { kind: 'plan-review', approve: '同意' },
};

const question = (interruptId: string, questions: readonly QuestionItem[]) =>
  requested({ interrupt_id: interruptId, payload: { kind: 'question', questions } });

const feed = (frame: ThreadFeedFrame): ThreadStatusAction => ({ type: 'frame', frame });
const status = (threadId: string, running: boolean) => feed({ type: 'status', threadId, running });
const ask = (threadId: string, event: Event) => feed({ type: 'input-requested', threadId, event });
const withdraw = (threadId: string, interruptId: string) =>
  feed({ type: 'input-withdrawn', threadId, interruptId });

function item(threadId: string, running = false): ThreadSummary {
  return { threadId, updatedAt: 0, running, blank: false };
}
const listed = (...items: ThreadSummary[]): ThreadStatusAction => ({ type: 'listed', items });

function run(current: string, ...actions: ThreadStatusAction[]): ThreadStatusState {
  return actions.reduce(reduceThreadStatus, initialThreadStatus(current));
}

describe('哪一種等人回答', () => {
  it('跟面板同一個折疊器：kind 缺席當核准、提問照題目分、認不得的不收', () => {
    expect(pendingKindOf(approval('a'))).toBe('approval');
    expect(pendingKindOf(question('q', [{ id: 'x', question: '要哪個？' }]))).toBe('question');
    expect(pendingKindOf(question('p', [PLAN]))).toBe('plan-review');
    expect(
      pendingKindOf(requested({ interrupt_id: 'z', payload: { kind: 'something-new' } })),
    ).toBeUndefined();
  });

  it('計劃審核照 dsh planReviewOf：一題、帶 detail、不複選、同意的標籤要在選項裡', () => {
    expect(isPlanReview([PLAN])).toBe(true);
    expect(isPlanReview([PLAN, { id: 'y', question: '另一題' }])).toBe(false);
    expect(isPlanReview([{ ...PLAN, detail: undefined }])).toBe(false);
    expect(isPlanReview([{ ...PLAN, multiSelect: true }])).toBe(false);
    expect(isPlanReview([{ ...PLAN, intent: { kind: 'plan-review', approve: '好' } }])).toBe(false);
    expect(
      isPlanReview([{ ...PLAN, options: [{ label: '同意' }, { label: '甲' }, { label: '乙' }] }]),
    ).toBe(false);
  });
});

describe('等人回答', () => {
  it('收到就標、撤回就清；同一條掛好幾顆時計劃審核 ＞ 提問 ＞ 核准', () => {
    let state = run('here', ask('a', approval('i1')));
    expect(rowStatus(state, item('a'))).toBe('approval');
    state = reduceThreadStatus(state, ask('a', question('i2', [{ id: 'x', question: '？' }])));
    expect(rowStatus(state, item('a'))).toBe('question');
    state = reduceThreadStatus(state, ask('a', question('i3', [PLAN])));
    expect(rowStatus(state, item('a'))).toBe('plan-review');
    state = reduceThreadStatus(state, withdraw('a', 'i3'));
    expect(rowStatus(state, item('a'))).toBe('question');
    state = reduceThreadStatus(state, withdraw('a', 'i2'));
    state = reduceThreadStatus(state, withdraw('a', 'i1'));
    expect(rowStatus(state, item('a'))).toBeUndefined();
  });

  it('等人回答蓋過在跑（停著等人也算在跑）', () => {
    const state = run('here', status('a', true), ask('a', approval('i1')));
    expect(rowStatus(state, item('a', true))).toBe('approval');
  });

  it('同一顆再來一次，後到的蓋過先到的', () => {
    const state = run('here', ask('a', approval('i1')), ask('a', question('i1', [PLAN])));
    expect(rowStatus(state, item('a'))).toBe('plan-review');
    expect(rowStatus(reduceThreadStatus(state, withdraw('a', 'i1')), item('a'))).toBeUndefined();
  });

  it('撤回一顆不認得的什麼都不動', () => {
    const state = run('here', ask('a', approval('i1')));
    expect(reduceThreadStatus(state, withdraw('a', 'nope'))).toBe(state);
    expect(reduceThreadStatus(state, withdraw('b', 'i1'))).toBe(state);
  });

  it('每次接上整份清掉，補送回來的才算：斷線期間答掉的不會留著', () => {
    const state = run(
      'here',
      ask('a', approval('i1')),
      ask('b', approval('i2')),
      { type: 'connected' },
      ask('b', approval('i2')),
    );
    expect(rowStatus(state, item('a'))).toBeUndefined();
    expect(rowStatus(state, item('b'))).toBe('approval');
  });
});

describe('在跑', () => {
  it('起點是列表，之後照全域下行翻', () => {
    let state = run('here', listed(item('a', true), item('b')));
    expect(rowStatus(state, item('a'))).toBe('running');
    state = reduceThreadStatus(state, status('b', true));
    expect(rowStatus(state, item('b'))).toBe('running');
  });

  it('列表上寫閒著、下行說在跑，照下行（列表只當起點）', () => {
    const state = run('here', listed(item('a')), status('a', true));
    expect(rowStatus(state, item('a', false))).toBe('running');
  });
});

describe('跑完沒看', () => {
  it('別條從在跑翻成閒著就記一筆；再跑起來就清掉', () => {
    let state = run('here', listed(item('a', true)), status('a', false));
    expect(rowStatus(state, item('a'))).toBe('completed');
    state = reduceThreadStatus(state, status('a', true));
    expect(rowStatus(state, item('a'))).toBe('running');
    state = reduceThreadStatus(state, status('a', false));
    expect(rowStatus(state, item('a'))).toBe('completed');
  });

  it('目前打開的那條停下不記', () => {
    const state = run('here', listed(item('here', true)), status('here', false));
    expect(rowStatus(state, item('here'))).toBeUndefined();
  });

  it('打開那條就清掉', () => {
    let state = run('here', listed(item('a', true)), status('a', false));
    state = reduceThreadStatus(state, { type: 'current', threadId: 'a' });
    expect(rowStatus(state, item('a'))).toBeUndefined();
  });

  it('本來就閒著、又收到一次閒著，不記', () => {
    const state = run('here', listed(item('a')), status('a', false));
    expect(rowStatus(state, item('a'))).toBeUndefined();
  });

  it('列表回來之前就停下：連先前狀態都不知道也算（dsh 的 beforeBaseline）；列表回來之後就不算', () => {
    expect(rowStatus(run('here', status('a', false)), item('a'))).toBe('completed');
    expect(
      rowStatus(run('here', listed(item('x')), status('a', false)), item('a')),
    ).toBeUndefined();
  });

  it('列表回來時跟先前知道的不同，當成一次翻轉：斷線期間跑完的照樣記', () => {
    const state = run('here', listed(item('a', true)), listed(item('a', false)));
    expect(rowStatus(state, item('a'))).toBe('completed');
  });

  it('列表上已經沒有那條就清掉', () => {
    const state = run('here', listed(item('a', true)), status('a', false), listed(item('b')));
    expect(rowStatus(state, item('a'))).toBeUndefined();
  });
});

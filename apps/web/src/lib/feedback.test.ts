import type { ConversationState, Event } from '@nexus/wire';
import {
  appendDecision,
  appendHumanTurn,
  emptyConversation,
  reduceConversation,
} from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { NO_REPLY_TAILS, trackReplyTails } from '@/lib/feedback';
import type { ReplyTails } from '@/lib/feedback';

/**
 * 按鈕放哪幾則（#267 的 Q7）。狀態由**真的折疊器**折出來，這裡只驗 `trackReplyTails` 對著它的轉換
 * 算對了沒有——手寫 `ConversationState` 的話，「折疊器其實不會那樣轉」這種漂移驗不到。
 */

const ROOT = ['model_request:1'];
const SUB = ['tools:t1', 'model_request:2'];

let seq = 0;
function frame(method: string, namespace: readonly string[], data: unknown): Event {
  const current = seq++;
  return {
    type: 'event',
    seq: current,
    event_id: `t:${current}`,
    method,
    params: { namespace, timestamp: 0, data },
  } as Event;
}

const running = () => frame('lifecycle', [], { event: 'running', graph_name: 'root' });
const completed = () => frame('lifecycle', [], { event: 'completed', graph_name: 'root' });
const stopped = () =>
  frame('lifecycle', [], { event: 'failed', graph_name: 'root', aborted: true });

function reply(
  id: string,
  text: string,
  namespace: readonly string[] = ROOT,
  finish = true,
): Event[] {
  return [
    frame('messages', namespace, { event: 'message-start', id: `run-${id}`, run_id: id }),
    frame('messages', namespace, {
      event: 'content-block-delta',
      index: 0,
      delta: { type: 'text-delta', text },
      run_id: id,
    }),
    ...(finish
      ? [frame('messages', namespace, { event: 'message-finish', reason: 'stop', run_id: id })]
      : []),
  ];
}

function approval(): Event {
  return frame('input.requested', ['tools:a'], {
    interrupt_id: 'int-1',
    payload: {
      actionRequests: [{ name: 'danger', args: {} }],
      reviewConfigs: [{ actionName: 'danger', allowedDecisions: ['approve', 'reject'] }],
    },
  });
}

/** 一步一步走，同 `use-conversation` 的 `advance`。 */
function walk(steps: readonly ((state: ConversationState) => ConversationState)[]): {
  state: ConversationState;
  tails: ReplyTails;
} {
  let state = emptyConversation();
  let tails = NO_REPLY_TAILS;
  for (const step of steps) {
    const next = step(state);
    tails = trackReplyTails(state, next, tails);
    state = next;
  }
  return { state, tails };
}

const events = (list: readonly Event[]) =>
  list.map((event) => (state: ConversationState) => reduceConversation(state, event));
const human = (text: string) => (state: ConversationState) => appendHumanTurn(state, text);

/** 長按鈕的那幾則的 id。 */
function tailIds(tails: ReplyTails): string[] {
  return [...tails.ids].map((id) => id);
}

describe('每一次 run 收尾時的最後一則 root 回覆', () => {
  it('一輪兩則：只有最後那則', () => {
    const { tails } = walk([
      human('跑。'),
      ...events([running(), ...reply('a', '先說。'), ...reply('b', '收工。'), completed()]),
    ]);
    expect(tailIds(tails)).toEqual(['b']);
  });

  it('還在跑的不長；收尾之後才長', () => {
    const during = walk([human('跑。'), ...events([running(), ...reply('a', '說。')])]);
    expect(tailIds(during.tails)).toEqual([]);
  });

  it('停在核准點不長；續接之後只長在續接後那則', () => {
    const paused = walk([
      human('做。'),
      ...events([running(), ...reply('a', '要動手了。'), approval(), completed()]),
    ]);
    expect(paused.state.status).toBe('awaiting-input');
    expect(tailIds(paused.tails)).toEqual([]);

    const { tails } = walk([
      human('做。'),
      ...events([running(), ...reply('a', '要動手了。'), approval(), completed()]),
      (state) => appendDecision(state, 'int-1', 'approve'),
      ...events([running(), ...reply('b', '做完了。'), completed()]),
    ]);
    expect(tailIds(tails)).toEqual(['b']);
  });

  it('被停止的那則有；停在核准點時按停止，算的是停下之前那段', () => {
    const cut = walk([
      human('跑。'),
      ...events([running(), ...reply('a', '講到一', ROOT, false), stopped()]),
    ]);
    expect(tailIds(cut.tails)).toEqual(['a']);

    const withdrawn = walk([
      human('做。'),
      ...events([running(), ...reply('a', '要動手了。'), approval(), completed(), stopped()]),
    ]);
    expect(tailIds(withdrawn.tails)).toEqual(['a']);
  });

  it('整段只有工具的不長，也不會拿前一輪那則充數；子代理那幾則不長', () => {
    const { tails } = walk([
      human('一。'),
      ...events([running(), ...reply('a', '第一輪。'), completed()]),
      human('二。'),
      ...events([running(), ...reply('s', '子代理講的。', SUB), completed()]),
    ]);
    expect(tailIds(tails)).toEqual(['a']);
  });

  it('續行連排兩輪（畫面上沒有人的話）：各自一顆', () => {
    const { tails } = walk([
      human('開始。'),
      ...events([
        running(),
        ...reply('a', '第一輪。'),
        completed(),
        running(),
        ...reply('b', '第二輪。'),
        completed(),
      ]),
    ]);
    expect(tailIds(tails)).toEqual(['a', 'b']);
  });
});

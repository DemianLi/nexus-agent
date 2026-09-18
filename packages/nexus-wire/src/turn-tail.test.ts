import { describe, expect, it } from 'vitest';

import {
  appendDecision,
  appendHumanTurn,
  emptyConversation,
  prependEntries,
  reduceAll,
  reduceConversation,
} from './conversation.js';
import type { ConversationState } from './conversation.js';
import type { Event } from './protocol.js';

/**
 * 每一輪收尾那則（`AiEntry.turnTail`，[#382](https://github.com/DemianLi/nexus-agent/issues/382)）。從 web 的
 * `trackReplyTails`（#267 的 Q7）搬進折疊器：即時與歷史走同一條，一次折完的歷史也逐顆過。
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

type Step = (state: ConversationState) => ConversationState;

function walk(steps: readonly Step[], from = emptyConversation()): ConversationState {
  return steps.reduce((state, step) => step(state), from);
}

const events = (list: readonly Event[]): Step[] =>
  list.map((event) => (state: ConversationState) => reduceConversation(state, event));
const human =
  (text: string): Step =>
  (state) =>
    appendHumanTurn(state, text);

/** 標了收尾的那幾則的 key。 */
function tailIds(state: ConversationState): string[] {
  return state.entries.flatMap((entry) =>
    entry.kind === 'ai' && entry.turnTail === true ? [entry.id] : [],
  );
}

describe('每一輪收尾時的最後一則 root 回覆', () => {
  it('一輪兩則：只有最後那則；messageId 取自 message-start 的 id', () => {
    const state = walk([
      human('跑。'),
      ...events([running(), ...reply('a', '先說。'), ...reply('b', '收工。'), completed()]),
    ]);
    expect(tailIds(state)).toEqual(['b']);
    expect(
      state.entries.flatMap((entry) => (entry.kind === 'ai' ? [entry.messageId] : [])),
    ).toEqual(['run-a', 'run-b']);
  });

  it('還在跑的不標；收尾之後才標', () => {
    const during = walk([human('跑。'), ...events([running(), ...reply('a', '說。')])]);
    expect(tailIds(during)).toEqual([]);
  });

  it('停在核准點不標；續接不切輪，收尾那則是整輪最後一則', () => {
    const paused = walk([
      human('做。'),
      ...events([running(), ...reply('a', '要動手了。'), approval(), completed()]),
    ]);
    expect(paused.status).toBe('awaiting-input');
    expect(tailIds(paused)).toEqual([]);

    const resumed = walk(
      [
        (state) => appendDecision(state, 'int-1', 'approve'),
        ...events([running(), ...reply('b', '做完了。'), completed()]),
      ],
      paused,
    );
    expect(tailIds(resumed)).toEqual(['b']);

    // 續接之後只有工具、沒再說話：收尾那則是停下來之前那則（同 dsh 的整輪收尾節點）。
    const silent = walk(
      [(state) => appendDecision(state, 'int-1', 'approve'), ...events([running(), completed()])],
      paused,
    );
    expect(tailIds(silent)).toEqual(['a']);
  });

  it('被停止的那則是收尾（它長不長按鈕由畫面決定）；停在核准點時按停止，算的是停下之前那段', () => {
    const cut = walk([
      human('跑。'),
      ...events([running(), ...reply('a', '講到一', ROOT, false), stopped()]),
    ]);
    expect(tailIds(cut)).toEqual(['a']);

    const withdrawn = walk([
      human('做。'),
      ...events([running(), ...reply('a', '要動手了。'), approval(), completed(), stopped()]),
    ]);
    expect(tailIds(withdrawn)).toEqual(['a']);
  });

  it('整輪只有工具的不標，也不會拿前一輪那則充數；子代理那幾則不標', () => {
    const state = walk([
      human('一。'),
      ...events([running(), ...reply('a', '第一輪。'), completed()]),
      human('二。'),
      ...events([running(), ...reply('s', '子代理講的。', SUB), completed()]),
    ]);
    expect(tailIds(state)).toEqual(['a']);
  });

  it('續行連排兩輪（畫面上沒有人的話）：各自一則', () => {
    const state = walk([
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
    expect(tailIds(state)).toEqual(['a', 'b']);
  });

  it('一次折完（歷史的 reduceAll）跟逐顆走一樣', () => {
    const list = [
      running(),
      ...reply('a', '第一輪。'),
      completed(),
      running(),
      ...reply('b', '第二輪先說。'),
      ...reply('c', '第二輪收工。'),
      completed(),
    ];
    expect(tailIds(reduceAll(emptyConversation(), list))).toEqual(['a', 'c']);
  });
});

describe('往前翻頁（prependEntries）', () => {
  it('一輪跑著時接上更早的一頁：收尾不會往回找進那一頁', () => {
    // 更早那一頁的最後一則沒被標成收尾（這裡用一輪沒收尾的造出來），起點錯了才找得到它。
    const earlier = reduceAll(emptyConversation(), [
      running(),
      ...reply('old', '沒收尾的那一輪。'),
    ]);
    expect(tailIds(earlier)).toEqual([]);
    // 這一輪只有工具、沒有文字回覆。起點沒跟著挪的話，收尾時會往回找進接上來的那一頁、標到 `old`。
    const live = walk([human('跑。'), ...events([running()])]);
    const joined = prependEntries(live, earlier);
    expect(joined.turnStart).toBe(live.turnStart + earlier.entries.length);
    expect(tailIds(walk(events([completed()]), joined))).toEqual([]);
  });

  it('接上來的那一頁自己的收尾照舊在', () => {
    const earlier = reduceAll(emptyConversation(), [
      running(),
      ...reply('old', '更早那一輪。'),
      completed(),
    ]);
    const live = walk([human('跑。'), ...events([running(), ...reply('now', '現在這輪。')])]);
    const done = walk(events([completed()]), prependEntries(live, earlier));
    expect(tailIds(done)).toEqual(['old', 'now']);
  });
});

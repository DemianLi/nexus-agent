import { describe, expect, it } from 'vitest';
import type { ConversationState, Event } from './index.js';
import {
  appendHumanTurn,
  emptyConversation,
  reduceAll,
  reduceConversation,
} from './conversation.js';

/**
 * 折疊器自己那幾個口子。
 *
 * **對著真的線的驗證在 `@nexus/harness` 的 `conversation-wire.test.ts`**——那邊拿真的
 * agent 跑過真的 pump 再折進來，跟 `invoke` 對照。這裡只驗那條路徑製造不出來的幾種
 * 情況：重連之後才接上、重複與亂序的 frame、以及使用者自己那句話。
 */

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

function text(id: string, namespace: readonly string[], body: string): Event[] {
  return [
    frame('messages', namespace, { event: 'message-start', id: `run-${id}`, run_id: id }),
    ...[...body].map((character) =>
      frame('messages', namespace, {
        event: 'content-block-delta',
        index: 0,
        delta: { type: 'text-delta', text: character },
        run_id: id,
      }),
    ),
    frame('messages', namespace, { event: 'message-finish', reason: 'stop', run_id: id }),
  ];
}

function aiEntries(state: ConversationState) {
  return state.entries
    .filter((entry) => entry.kind === 'ai')
    .map((entry) =>
      entry.kind === 'ai' ? { text: entry.text, attribution: entry.attribution } : null,
    );
}

describe('折疊器', () => {
  it('使用者那句話由送出端補，因為線上不會回聲它', () => {
    const state = appendHumanTurn(emptyConversation(), '記一筆。');
    expect(state.entries).toEqual([{ kind: 'human', id: 'human-0', text: '記一筆。' }]);
    // 送出去的那一刻就算 running，不必等第一顆 frame 回來畫面才動。
    expect(state.status).toBe('running');
  });

  it('重連之後接上的巢狀訊息標成未歸屬——鑰匙已經過去了', () => {
    seq = 0;
    // 這條線沒有重播也沒有歷史重抓（決策 6），所以 `task` 那顆 tools frame 收不到了。
    const state = reduceAll(
      emptyConversation(),
      text('sub', ['tools:abc', 'model_request:x'], '半路接上'),
    );
    expect(aiEntries(state)).toEqual([
      {
        text: '半路接上',
        attribution: { kind: 'unattributed', namespace: ['tools:abc', 'model_request:x'] },
      },
    ]);
  });

  it('同一顆 frame 折兩次不會變成兩則', () => {
    seq = 0;
    const frames = text('one', ['model_request:x'], '嗨');
    const once = reduceAll(emptyConversation(), frames);
    const twice = reduceAll(once, frames);
    expect(aiEntries(twice)).toEqual(aiEntries(once));
    expect(twice.entries.length).toBe(1);
  });

  it('seq 退回去的 frame 一律丟掉', () => {
    seq = 0;
    const state = reduceAll(emptyConversation(), text('one', ['model_request:x'], '嗨'));
    const stale = frame('messages', ['model_request:x'], {
      event: 'content-block-delta',
      delta: { type: 'text-delta', text: '不該出現' },
      run_id: 'one',
    });
    const replayed = reduceConversation(state, { ...stale, seq: 0 } as Event);
    expect(aiEntries(replayed)).toEqual(aiEntries(state));
  });

  it('工具的參數原樣留著，不在這一層猜它的形狀', () => {
    seq = 0;
    const state = reduceAll(emptyConversation(), [
      frame('tools', ['tools:a'], {
        event: 'tool-started',
        tool_call_id: 'call_1_0',
        tool_name: 'take_note',
        input: '{"text":"甲"}',
      }),
      frame('tools', ['tools:a'], {
        event: 'tool-error',
        tool_call_id: 'call_1_0',
        message: '工具自己炸了',
      }),
    ]);
    expect(state.entries).toEqual([
      {
        kind: 'tool',
        id: 'tool-call_1_0',
        callId: 'call_1_0',
        name: 'take_note',
        input: '{"text":"甲"}',
        status: 'failed',
        error: '工具自己炸了',
        attribution: { kind: 'root' },
      },
    ]);
  });

  it('task 的參數不是合法 JSON 時歸屬不出來，但不會炸', () => {
    seq = 0;
    const state = reduceAll(emptyConversation(), [
      frame('tools', ['tools:a'], {
        event: 'tool-started',
        tool_call_id: 'call_1_0',
        tool_name: 'task',
        input: '{壞掉的',
      }),
      ...text('sub', ['tools:a', 'model_request:x'], '子代理說話'),
    ]);
    expect(aiEntries(state)).toEqual([
      {
        text: '子代理說話',
        attribution: { kind: 'unattributed', namespace: ['tools:a', 'model_request:x'] },
      },
    ]);
  });
});

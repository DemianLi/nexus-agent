import { describe, expect, it } from 'vitest';

import { appendHumanTurn, emptyConversation, prependEntries, reduceAll } from './conversation.js';
import type { ConversationState } from './conversation.js';
import type { Event } from './protocol.js';
import { changesDiffPath, changesSummaryPath, WORKSPACE_CHANGES } from './workspace-changes.js';

/**
 * 改動紀錄折成獨立的一格（[#443](https://github.com/DemianLi/nexus-agent/issues/443)，照 #441 交付格的做法）。
 * 對著真的線的那一條在 `@nexus/harness` 的 `workspace-changes.test.ts`：即時與歷史各折出同一格。這裡驗那條路徑
 * 製造不出來的：認不得的名字與形狀、同一個 `seq` 重複、輪尾與狀態不受影響、往前翻頁接得上。
 */

const ROOT = ['model_request:1'];

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
const changes = (payload: unknown) => frame('custom', [], { name: WORKSPACE_CHANGES, payload });

function reply(id: string, text: string): Event[] {
  return [
    frame('messages', ROOT, { event: 'message-start', id: `run-${id}`, run_id: id }),
    frame('messages', ROOT, {
      event: 'content-block-delta',
      index: 0,
      delta: { type: 'text-delta', text },
      run_id: id,
    }),
    frame('messages', ROOT, { event: 'message-finish', reason: 'stop', run_id: id }),
  ];
}

function tool(callId: string): Event[] {
  const namespace = [`tools:${callId}`];
  return [
    frame('tools', namespace, {
      event: 'tool-started',
      tool_call_id: callId,
      tool_name: 'write_file',
      input: '{}',
    }),
    frame('tools', namespace, {
      event: 'tool-finished',
      tool_call_id: callId,
      tool_name: 'write_file',
      output: 'ok',
    }),
  ];
}

const kinds = (state: ConversationState) => state.entries.map((entry) => entry.kind);

describe('workspace/changes', () => {
  it('折成獨立的一格，落在它在串流裡的位置', () => {
    const state = reduceAll(emptyConversation(), [
      ...tool('c1'),
      changes({ seq: 7 }),
      ...reply('r1', '改好了。'),
    ]);
    expect(kinds(state)).toEqual(['tool', 'workspace-changes', 'ai']);
    expect(state.entries[1]).toEqual({
      kind: 'workspace-changes',
      id: 'workspace-changes:7',
      seq: 7,
    });
  });

  it('同一個 seq 第二次出現就忽略；不同的 seq 各長一格', () => {
    const state = reduceAll(emptyConversation(), [
      changes({ seq: 7 }),
      changes({ seq: 7 }),
      changes({ seq: 9 }),
    ]);
    expect(state.entries.map((entry) => entry.id)).toEqual([
      'workspace-changes:7',
      'workspace-changes:9',
    ]);
  });

  it('別的名字、壞掉的形狀一律略過，但 seq 照樣往前走', () => {
    const noise = [
      frame('custom', [], { name: 'something/else', payload: { seq: 1 } }),
      frame('custom', [], { payload: { seq: 1 } }),
      changes(undefined),
      changes(null),
      changes({}),
      changes({ seq: '1' }),
      changes({ seq: -1 }),
      changes({ seq: 1.5 }),
      changes({ seq: Number.NaN }),
      frame('custom', [], null),
    ];
    const state = reduceAll(emptyConversation(), noise);
    expect(state.entries).toEqual([]);
    expect(state.lastSeq).toBe(noise.at(-1)!.seq);
  });

  it('不動狀態、不當輪尾：輪尾照樣標在最後一則有文字的回覆上', () => {
    const state = reduceAll(appendHumanTurn(emptyConversation(), '改檔。'), [
      running(),
      ...reply('r1', '先寫。'),
      ...tool('c1'),
      changes({ seq: 3 }),
    ]);
    expect(state.status).toBe('running');
    expect(state.pendings).toEqual([]);
    const done = reduceAll(state, [completed()]);
    expect(done.status).toBe('idle');
    const tails = done.entries.filter((entry) => entry.kind === 'ai' && entry.turnTail === true);
    expect(tails.map((entry) => entry.id)).toEqual(['r1']);
    // 收尾之後才到的（中止或失敗的輪次是在 `turn/end` 之後補記）不改動任何一格的輪尾。
    const late = reduceAll(done, [changes({ seq: 99 })]);
    expect(late.status).toBe('idle');
    expect(late.entries.slice(0, -1)).toEqual(done.entries);
  });

  it('往前翻頁：較早那一頁的這一格原樣接在最前面', () => {
    const earlier = reduceAll(emptyConversation(), [...tool('c1'), changes({ seq: 2 })]);
    const now = reduceAll(emptyConversation(), [...reply('r2', '後來。')]);
    const joined = prependEntries(now, earlier);
    expect(kinds(joined)).toEqual(['tool', 'workspace-changes', 'ai']);
    expect(joined.entries[1]).toBe(earlier.entries[1]);
  });

  it('路徑掛在 thread 底下，id 要編碼', () => {
    expect(changesSummaryPath('a/b')).toBe('/threads/a%2Fb/changes/summary');
    expect(changesDiffPath('t')).toBe('/threads/t/changes/diff');
  });
});

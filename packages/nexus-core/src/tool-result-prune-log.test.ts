/**
 * 工具結果剪刀的決定在日誌裡（[#1302](https://github.com/DemianLi/nexus-agent/issues/1302)）：
 * 純函式（讀、換）與剪刀的「先換記過的、再剪新的、新剪的當場記」。
 *
 * 剪刀接真的註冊表與會話日誌的那一頭在 `apps/harness/src/prune-log.test.ts`。這裡用手造的接口，只問剪刀自己的行為。
 */

import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import type { AgentMiddleware } from './base-types.js';
import { SessionLog } from './session-log.js';
import {
  applyRecordedPrune,
  applyRecordedPrunes,
  measureToolResultContent,
  recordedPrunesOf,
} from './tool-result-prune-log.js';
import { TOOL_RESULT_PRUNE_MARKER, withToolResultPruning } from './tool-result-pruner.js';
import type {
  NewlyPruned,
  PruneRequest,
  ToolResultPruneConfig,
  ToolResultPruneLog,
} from './tool-result-pruner.js';

const SMALL: ToolResultPruneConfig = { thresholdChars: 100, headChars: 20, tailChars: 10 };

const tool = (content: string, id: string): ToolMessage =>
  new ToolMessage({ content, tool_call_id: id, name: 'grep' });

/** 把一顆剪法記進一份日誌，回事件。 */
function recordInto(
  log: SessionLog,
  results: readonly { callId: string; originalChars: number; content: string }[],
): void {
  log.append('compaction/prune', { results });
}

describe('從日誌讀剪法', () => {
  it('沒有 compaction/prune 就是空的', () => {
    const log = new SessionLog('s');
    log.append('turn/start', { kind: 'message', text: '嗨' });
    expect(recordedPrunesOf(log.events).size).toBe(0);
  });

  it('逐顆收，同一顆記了兩次以後記的為準', () => {
    const log = new SessionLog('s');
    recordInto(log, [{ callId: 'a', originalChars: 500, content: '甲' }]);
    recordInto(log, [
      { callId: 'b', originalChars: 600, content: '乙' },
      { callId: 'a', originalChars: 500, content: '甲二' },
    ]);
    const recorded = recordedPrunesOf(log.events);
    expect([...recorded.keys()].sort()).toEqual(['a', 'b']);
    expect(recorded.get('a')?.content).toBe('甲二');
  });
});

describe('把記過的換上去', () => {
  const log = new SessionLog('s');
  recordInto(log, [{ callId: 'big', originalChars: 300, content: '頭…尾' }]);
  const recorded = recordedPrunesOf(log.events);

  it('callId 對得上、文字量也對得上才換，只換 content', () => {
    const original = new ToolMessage({
      content: '字'.repeat(300),
      tool_call_id: 'big',
      name: 'grep',
      status: 'error',
    });
    const replaced = applyRecordedPrune(original, recorded);
    expect(replaced).not.toBe(original);
    expect(ToolMessage.isInstance(replaced) && replaced.content).toBe('頭…尾');
    expect(ToolMessage.isInstance(replaced) && replaced.tool_call_id).toBe('big');
    expect(ToolMessage.isInstance(replaced) && replaced.status).toBe('error');
    expect(replaced.name).toBe('grep');
  });

  it('文字量對不上（供應商重用了 tool_call_id，或訊息被改過）原樣放過', () => {
    const other = tool('字'.repeat(299), 'big');
    expect(applyRecordedPrune(other, recorded)).toBe(other);
  });

  it('沒記過的、不是工具結果的原樣放過', () => {
    const human = new HumanMessage('字'.repeat(300));
    const unknown = tool('字'.repeat(300), 'other');
    expect(applyRecordedPrune(human, recorded)).toBe(human);
    expect(applyRecordedPrune(unknown, recorded)).toBe(unknown);
  });

  it('一則都沒換時 applyRecordedPrunes 回原本那個陣列，換了則長度與順序不變', () => {
    const untouched = [new HumanMessage('嗨'), tool('短', 'x')];
    expect(applyRecordedPrunes(untouched, recorded)).toBe(untouched);

    const messages = [new HumanMessage('嗨'), tool('字'.repeat(300), 'big'), new AIMessage('好')];
    const next = applyRecordedPrunes(messages, recorded);
    expect(next).toHaveLength(3);
    expect(next[0]).toBe(messages[0]);
    expect(next[2]).toBe(messages[2]);
    expect(next[1]?.content).toBe('頭…尾');
  });

  it('複合內容：非文字區塊跟著記下的內容走，量的只有文字', () => {
    const blocks = [
      { type: 'text', text: '字'.repeat(150) },
      { type: 'image', url: 'x' },
      { type: 'text', text: '字'.repeat(150) },
    ];
    expect(measureToolResultContent(blocks as unknown as BaseMessage['content'])).toBe(300);
  });
});

/** 一顆手造的日誌接口：讀寫都在記憶體裡的一份 `SessionLog`。 */
function fakeLog(log: SessionLog | undefined): ToolResultPruneLog & { appended: number } {
  const state = { appended: 0 };
  return {
    get appended() {
      return state.appended;
    },
    recorded: () => (log === undefined ? undefined : recordedPrunesOf(log.events)),
    record: (_request: PruneRequest, results: readonly NewlyPruned[]) => {
      if (log === undefined) return;
      state.appended += 1;
      log.append('compaction/prune', {
        results: results.map((result) => ({
          callId: result.callId,
          originalChars: result.originalChars,
          content: result.content,
        })),
      });
    },
  };
}

/** 一顆什麼都不做、只把收到的訊息交出來的「摘要器」。 */
function spy(): { base: AgentMiddleware; seen: BaseMessage[][] } {
  const seen: BaseMessage[][] = [];
  const base = {
    name: 'spy',
    wrapModelCall: (request: { messages?: BaseMessage[] }) => {
      seen.push([...(request.messages ?? [])]);
      return Promise.resolve('ok');
    },
  } as unknown as AgentMiddleware;
  return { base, seen };
}

async function run(wrapped: AgentMiddleware, messages: BaseMessage[]): Promise<void> {
  await (
    wrapped.wrapModelCall as unknown as (
      request: { messages: BaseMessage[] },
      handler: unknown,
    ) => Promise<unknown>
  )({ messages }, () => undefined);
}

describe('剪刀：先換記過的、再剪新的、新剪的當場記', () => {
  const big = (id: string) => tool('字'.repeat(300), id);

  it('壓力到了：剪、記、往下交的是剪過的', async () => {
    const log = new SessionLog('s');
    const port = fakeLog(log);
    const { base, seen } = spy();
    const wrapped = withToolResultPruning(base, () => true, SMALL, port);
    await run(wrapped, [new HumanMessage('嗨'), big('a')]);

    expect(port.appended).toBe(1);
    const recorded = recordedPrunesOf(log.events);
    expect(recorded.get('a')?.originalChars).toBe(300);
    const sent = seen[0]?.[1];
    expect(measureToolResultContent(sent!.content)).toBeLessThan(300);
    expect(
      typeof sent?.content === 'string' && sent.content.includes(TOOL_RESULT_PRUNE_MARKER),
    ).toBe(true);
    // 日誌上記的就是往下交的那一份。
    expect(recorded.get('a')?.content).toBe(sent?.content);
  });

  it('每顆只記一次：第二次呼叫沿用，不再記', async () => {
    const log = new SessionLog('s');
    const port = fakeLog(log);
    const { base, seen } = spy();
    const wrapped = withToolResultPruning(base, () => true, SMALL, port);
    const messages = [new HumanMessage('嗨'), big('a')];
    await run(wrapped, messages);
    await run(wrapped, messages);

    expect(port.appended).toBe(1);
    expect(seen[1]?.[1]?.content).toBe(seen[0]?.[1]?.content);
  });

  it('壓力退了，記過的仍是剪過的（沿用，不看壓力）；沒記過的不剪', async () => {
    const log = new SessionLog('s');
    const port = fakeLog(log);
    const { base, seen } = spy();
    let pressure = true;
    const wrapped = withToolResultPruning(base, () => pressure, SMALL, port);
    await run(wrapped, [new HumanMessage('嗨'), big('a')]);
    pressure = false;
    const fresh = big('b');
    await run(wrapped, [new HumanMessage('嗨'), big('a'), fresh]);

    expect(measureToolResultContent(seen[1]![1]!.content)).toBeLessThan(300);
    expect(seen[1]![2]).toBe(fresh);
    expect(port.appended).toBe(1);
  });

  it('設定改了（門檻放寬）也不影響記過的：已剪的永遠是當時剪成的樣子', async () => {
    const log = new SessionLog('s');
    const port = fakeLog(log);
    const first = spy();
    await run(
      withToolResultPruning(first.base, () => true, SMALL, port),
      [big('a')],
    );
    const later = spy();
    const relaxed: ToolResultPruneConfig = { thresholdChars: 10_000, headChars: 5, tailChars: 5 };
    await run(
      withToolResultPruning(later.base, () => true, relaxed, port),
      [big('a')],
    );

    expect(later.seen[0]?.[0]?.content).toBe(first.seen[0]?.[0]?.content);
    expect(port.appended).toBe(1);
  });

  it('沒剪到任何東西：不記、請求原樣', async () => {
    const log = new SessionLog('s');
    const port = fakeLog(log);
    const { base, seen } = spy();
    const wrapped = withToolResultPruning(base, () => true, SMALL, port);
    const messages = [new HumanMessage('嗨'), tool('短', 'a')];
    await run(wrapped, messages);

    expect(port.appended).toBe(0);
    expect(log.length).toBe(0);
    expect(seen[0]?.[1]).toBe(messages[1]);
  });

  it('找不到日誌：退回每次重算，不記、不拋', async () => {
    const port = fakeLog(undefined);
    const { base, seen } = spy();
    let pressure = true;
    const wrapped = withToolResultPruning(base, () => pressure, SMALL, port);
    await run(wrapped, [big('a')]);
    expect(measureToolResultContent(seen[0]![0]!.content)).toBeLessThan(300);
    pressure = false;
    await run(wrapped, [big('a')]);
    expect(measureToolResultContent(seen[1]![0]!.content)).toBe(300);
    expect(port.appended).toBe(0);
  });

  it('不給接口：行為同以前（每次重算）', async () => {
    const { base, seen } = spy();
    const wrapped = withToolResultPruning(base, () => true, SMALL);
    await run(wrapped, [big('a')]);
    expect(measureToolResultContent(seen[0]![0]!.content)).toBeLessThan(300);
  });
});

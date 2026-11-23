/**
 * 摘要的切點表（[#2416](https://github.com/DemianLi/nexus-agent/issues/2416)）：查找的四道判斷、鍵、最外層的讀與落表。
 * 經組裝的行為由 `apps/harness/src/summarizer-lifetime.test.ts` 負責；這裡釘住兩個 loop 都走不到的分支（沒有 id 的訊息）。
 */

import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';

import { BACKGROUND_SESSION_CONFIG_KEY } from './session-address.js';
import {
  applySummaryCutoff,
  latestSummaryCutoff,
  noteSummaryCutoff,
  previousSummaryCutoff,
  summaryCutoffIndex,
  SummaryCutoffTable,
  summaryCutoffsOf,
  withSummaryCutoffs,
} from './summary-cutoffs.js';
import type { SummaryCutoff } from './summary-cutoffs.js';

const ROOT = { configurable: { thread_id: 't', checkpoint_ns: 'model_request:x' } };
const summary = new HumanMessage({
  content: '摘要。',
  additional_kwargs: { lc_source: 'summarization' },
});
const cutoffAt = (cutoffIndex: number): SummaryCutoff => ({
  cutoffIndex,
  summaryMessage: summary,
  filePath: '/conversation_history/s.md',
});
const withIds = (count: number): BaseMessage[] =>
  Array.from(
    { length: count },
    (_, i) => new HumanMessage({ content: `第 ${String(i)} 則`, id: `m${String(i)}` }),
  );

describe('查找：條目是不是這份訊息串的', () => {
  it('同一串：查得到', () => {
    const table = new SummaryCutoffTable();
    const messages = withIds(5);
    table.record(ROOT, messages, cutoffAt(3));
    expect(table.lookup(ROOT, messages)).toEqual(cutoffAt(3));
  });

  it('切點超過訊息數：沒有（灌回的串比切點短）', () => {
    const table = new SummaryCutoffTable();
    table.record(ROOT, withIds(5), cutoffAt(4));
    expect(table.lookup(ROOT, withIds(3))).toBeUndefined();
    // 剛好等於訊息數仍在串裡。
    expect(table.lookup(ROOT, withIds(4))).toEqual(cutoffAt(4));
  });

  it('切點小於 1：不驗錨點，直接回', () => {
    const table = new SummaryCutoffTable();
    table.record(ROOT, withIds(2), cutoffAt(0));
    expect(table.lookup(ROOT, [new HumanMessage('別的')])).toEqual(cutoffAt(0));
  });

  it('錨點那格的 id 不同：沒有；同 id 的另一顆物件：有', () => {
    const table = new SummaryCutoffTable();
    table.record(ROOT, withIds(5), cutoffAt(3));
    const other = withIds(5);
    expect(table.lookup(ROOT, other)).toEqual(cutoffAt(3));
    other[2] = new HumanMessage({ content: '第 2 則', id: 'another' });
    expect(table.lookup(ROOT, other)).toBeUndefined();
  });

  it('沒有 id：比物件本身，內容相同的另一顆不算', () => {
    const table = new SummaryCutoffTable();
    const messages = [new HumanMessage('一'), new HumanMessage('二'), new HumanMessage('三')];
    table.record(ROOT, messages, cutoffAt(2));
    expect(table.lookup(ROOT, [...messages, new AIMessage('四')])).toEqual(cutoffAt(2));
    const copy = [new HumanMessage('一'), new HumanMessage('二'), new HumanMessage('三')];
    expect(table.lookup(ROOT, copy)).toBeUndefined();
  });

  it('後寫的蓋掉先寫的', () => {
    const table = new SummaryCutoffTable();
    const messages = withIds(6);
    table.record(ROOT, messages, cutoffAt(2));
    table.record(ROOT, messages, cutoffAt(4));
    expect(table.lookup(ROOT, messages)?.cutoffIndex).toBe(4);
  });
});

describe('鍵：thread 加呼叫的身分', () => {
  const messages = withIds(4);
  const sub = (runId: string) => ({
    configurable: { thread_id: 't', checkpoint_ns: `${runId}|model_request:y` },
  });

  it('root、兩個前景子代理、背景子代理、另一條 thread：各一格，互相讀不到', () => {
    const table = new SummaryCutoffTable();
    const background = { configurable: { thread_id: 't', [BACKGROUND_SESSION_CONFIG_KEY]: 'bg1' } };
    const otherThread = { configurable: { thread_id: 'u', checkpoint_ns: 'model_request:x' } };
    table.record(ROOT, messages, cutoffAt(1));
    table.record(sub('tools:a'), messages, cutoffAt(2));
    table.record(background, messages, cutoffAt(3));
    expect(table.lookup(ROOT, messages)?.cutoffIndex).toBe(1);
    expect(table.lookup(sub('tools:a'), messages)?.cutoffIndex).toBe(2);
    expect(table.lookup(sub('tools:b'), messages)).toBeUndefined();
    expect(table.lookup(background, messages)?.cutoffIndex).toBe(3);
    expect(table.lookup(otherThread, messages)).toBeUndefined();
  });

  it('同一個 runId 的兩次模型呼叫（最後一段不同）：同一格', () => {
    const table = new SummaryCutoffTable();
    table.record(
      { configurable: { thread_id: 't', checkpoint_ns: 'tools:a|model_request:1' } },
      messages,
      cutoffAt(2),
    );
    expect(
      table.lookup(
        { configurable: { thread_id: 't', checkpoint_ns: 'tools:a|model_request:2' } },
        messages,
      )?.cutoffIndex,
    ).toBe(2);
  });

  it('認不出身分（沒有 checkpoint_ns）：不寫也不讀', () => {
    const table = new SummaryCutoffTable();
    table.record({ configurable: { thread_id: 't' } }, messages, cutoffAt(1));
    table.record(undefined, messages, cutoffAt(1));
    expect(table.lookup({ configurable: { thread_id: 't' } }, messages)).toBeUndefined();
    expect(table.lookup(ROOT, messages)).toBeUndefined();
  });
});

describe('組裝與套用', () => {
  it('同一個組裝物件拿到同一張表，不同的拿到不同的', () => {
    const a = {};
    expect(summaryCutoffsOf(a)).toBe(summaryCutoffsOf(a));
    expect(summaryCutoffsOf({})).not.toBe(summaryCutoffsOf(a));
  });

  it('套用：[摘要, ...切點之後]；沒有切點原樣回', () => {
    const messages = withIds(4);
    expect(applySummaryCutoff(messages, undefined)).toBe(messages);
    expect(applySummaryCutoff(messages, cutoffAt(3)).map((m) => m.text)).toEqual([
      '摘要。',
      '第 3 則',
    ]);
  });
});

describe('最外層：這一步開始時讀、結束時落表', () => {
  type Request = { messages: BaseMessage[]; state: Record<string, unknown>; runtime: unknown };
  const request = (messages: BaseMessage[]): Request => ({
    messages,
    state: { messages },
    runtime: ROOT,
  });
  const reply = new AIMessage('好。');

  /** 內層：記下看到的上一次與最新切點，照 `steps` 依序 note、叫 handler、回傳或拋錯。 */
  function innerLayer(steps: { note?: SummaryCutoff[]; throws?: Error }) {
    const seen: unknown[] = [];
    const latest: unknown[] = [];
    const base = {
      name: 'Summarization',
      wrapModelCall: async (req: Request, handler: (r: Request) => Promise<unknown>) => {
        seen.push(previousSummaryCutoff());
        for (const cutoff of steps.note ?? []) {
          noteSummaryCutoff(cutoff);
          seen.push(previousSummaryCutoff());
          latest.push(latestSummaryCutoff()?.cutoffIndex);
        }
        const answer = await handler(req);
        if (steps.throws !== undefined) throw steps.throws;
        return answer;
      },
    };
    return { base, seen, latest };
  }

  it('回內層的回傳值，落表', async () => {
    const table = new SummaryCutoffTable();
    const { base } = innerLayer({ note: [cutoffAt(2)] });
    const outer = withSummaryCutoffs(base as never, table) as unknown as {
      wrapModelCall: (r: Request, h: () => Promise<unknown>) => Promise<unknown>;
    };
    const messages = withIds(4);
    expect(await outer.wrapModelCall(request(messages), async () => reply)).toBe(reply);
    expect(table.lookup(ROOT, messages)?.cutoffIndex).toBe(2);
  });

  it('同一步 note 兩次：落定的是最後一次，內層這一步讀到的上一次一直是開始時的值', async () => {
    const table = new SummaryCutoffTable();
    const messages = withIds(6);
    table.record(ROOT, messages, cutoffAt(1));
    const { base, seen, latest } = innerLayer({ note: [cutoffAt(3), cutoffAt(4)] });
    const outer = withSummaryCutoffs(base as never, table) as unknown as {
      wrapModelCall: (r: Request, h: () => Promise<unknown>) => Promise<unknown>;
    };
    await outer.wrapModelCall(request(messages), async () => reply);
    expect(seen.map((s) => (s as SummaryCutoff | undefined)?.cutoffIndex)).toEqual([1, 1, 1]);
    expect(latest).toEqual([3, 4]);
    expect(table.lookup(ROOT, messages)?.cutoffIndex).toBe(4);
  });

  it('內層拋錯：note 過的切點照樣落表，錯照樣拋', async () => {
    const table = new SummaryCutoffTable();
    const messages = withIds(4);
    const failure = new Error('模型那一輪炸了');
    const { base } = innerLayer({ note: [cutoffAt(2)], throws: failure });
    const outer = withSummaryCutoffs(base as never, table) as unknown as {
      wrapModelCall: (r: Request, h: () => Promise<unknown>) => Promise<unknown>;
    };
    await expect(outer.wrapModelCall(request(messages), async () => reply)).rejects.toBe(failure);
    expect(table.lookup(ROOT, messages)?.cutoffIndex).toBe(2);
  });

  it('只換 wrapModelCall：名字與其他鉤子原樣保留', () => {
    const beforeAgent = async () => undefined;
    const { base } = innerLayer({});
    const outer = withSummaryCutoffs(
      { ...base, beforeAgent } as never,
      new SummaryCutoffTable(),
    ) as unknown as Record<string, unknown>;
    expect(outer.name).toBe('Summarization');
    expect(outer.beforeAgent).toBe(beforeAgent);
    expect(outer.wrapModelCall).not.toBe(base.wrapModelCall);
  });

  it('沒有 note：表不動', async () => {
    const table = new SummaryCutoffTable();
    const messages = withIds(4);
    const { base } = innerLayer({});
    const outer = withSummaryCutoffs(base as never, table) as unknown as {
      wrapModelCall: (r: Request, h: () => Promise<unknown>) => Promise<unknown>;
    };
    expect(await outer.wrapModelCall(request(messages), async () => reply)).toBe(reply);
    expect(table.lookup(ROOT, messages)).toBeUndefined();
  });

  it('不在任何一步裡：note 什麼都不做，讀到的都是沒有', () => {
    expect(() => noteSummaryCutoff(cutoffAt(1))).not.toThrow();
    expect(previousSummaryCutoff()).toBeUndefined();
    expect(latestSummaryCutoff()).toBeUndefined();
  });
});

describe('這次的切點換成整串的座標', () => {
  it('沒有上一次：有效串長度 −（交下去的長度 − 1）', () => {
    // 10 則、留 3 則：交下去 [摘要, 3 則]，切點 7。
    expect(summaryCutoffIndex(undefined, 10, 4)).toBe(7);
  });

  it('有上一次：加上上一次切點、扣掉有效串開頭那則舊摘要', () => {
    // 上一次切在 6，整串 12 則 → 有效串 [舊摘要, 6 則] 共 7；交下去 [新摘要, 2 則]，有效串裡切在 5，整串切在 6 + 5 − 1 = 10。
    expect(summaryCutoffIndex(6, 7, 3)).toBe(10);
  });
});

/**
 * 解譯者那一列在續接前被關掉，日誌上記過的剪法照樣套用（[#1567](https://github.com/DemianLi/nexus-agent/issues/1567) N0780）。
 *
 * 續接灌回 graph state 的是原文（`conversation-restore.ts` 呼叫 `replayConversation` 不帶 `applyPrunes`、`applyArgTruncations`），
 * 記過的 `compaction/prune` 與 `compaction/truncate-args` 由剪刀與摘要器每次呼叫照日誌換上去。管理員在兩台 serve 之間把
 * `tool-result-pruner` 或 `summarization` 那一列關掉（兩列都是 next-thread 類，續接的 thread 組裝時才生效），換上去的那一層
 * 不能跟著不見：模型看到的要是記下時的樣子，而且**不下新的決定**（關掉就是不要再剪、不要再縮）。
 *
 * 摘要的切點不在這套機制裡：續接灌回去的本來就是「摘要＋之後的」（`conversation-restore.ts` 檔頭），最後一條測試釘住這件事。
 *
 * 走出貨的 `runServe --live`，兩段 serve 共用一個日誌目錄，第二段開始前改 patch。
 */

import type { SessionEvent } from '@nexus/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  LOW_SUMMARIZATION,
  mainOnly,
  PRUNE_MARKER,
  runServePhases,
  TRUNCATE_MARKER,
} from './log-derived-history.fixture.js';
import type { Body, Reply, Run } from './log-derived-history.fixture.js';

beforeAll(() => {
  // `--live` 要有金鑰才肯組模型；端點是本機假的，這顆不會送到任何地方。
  vi.stubEnv('NVIDIA_API_KEY', 'nvapi-fake-for-recorded-projection');
});
afterAll(() => {
  vi.unstubAllEnvs();
});

const PAD = '內容'.repeat(100);
const PRUNER_OFF = '- id: tool-result-pruner\n  disabled: true';
const SUMMARIZATION_OFF = '- id: summarization\n  disabled: true';

/** 一顆 10,000 字的工具結果（達剪刀門檻）加一顆長參數的寫檔（達截斷門檻）。 */
const bigThenSmall = (suffix: string): Reply => ({
  tools: [
    { id: `call_mid${suffix}`, name: 'echo', args: { message: '中'.repeat(10_000) } },
    {
      id: `call_w${suffix}`,
      name: 'write_file',
      args: { file_path: `/a${suffix}.txt`, content: 'abc'.repeat(2_000) },
    },
  ],
});

/** 續接點（`session/end-seed`）之後的第一次主呼叫送出去的 body。主呼叫與 root 的 `model/start` 一一對應，這裡先驗數量。 */
function firstBodyAfterResume(run: Run): Body {
  const resumedAt = run.events.find((e) => e.type === 'session/end-seed');
  expect(resumedAt, '應該有一次續接').toBeDefined();
  expect(run.mainBodies).toHaveLength(run.events.filter((e) => e.type === 'model/start').length);
  const before = run.events.filter(
    (e) => e.type === 'model/start' && e.seq < resumedAt!.seq,
  ).length;
  const body = run.mainBodies[before];
  expect(body, '續接之後應該有主呼叫').toBeDefined();
  return body!;
}

/** 續接點之後記下的某一種事件。 */
function afterResume(run: Run, type: SessionEvent['type']): SessionEvent[] {
  const resumedAt = run.events.find((e) => e.type === 'session/end-seed')!;
  return run.events.filter((e) => e.type === type && e.seq > resumedAt.seq);
}

/** body 裡某顆工具結果的文字。 */
function toolResultText(body: Body, callId: string): string | undefined {
  const message = body.messages.find(
    (m) => (m as { tool_call_id?: unknown }).tool_call_id === callId,
  );
  return message === undefined ? undefined : JSON.stringify(message);
}

describe('解譯者那一列在續接前被關掉', () => {
  it('剪刀那一列關掉：記過的剪法照樣套用，續接之後壓力到了也不剪新的', async () => {
    // 主呼叫 0 回兩顆工具呼叫、1 收尾，之後每輪一次；所以第二段的第一次主呼叫是第 4 號，再給一顆大結果。
    const script = mainOnly((k) => (k === 0 ? bigThenSmall('') : k === 4 ? bigThenSmall('2') : {}));
    const texts = ['大結果', '二', '三', '重啟點之後的一句', '再一句'].map((t) => `${t}${PAD}`);
    const run = await runServePhases(
      [texts.slice(0, 3), texts.slice(3)],
      script,
      LOW_SUMMARIZATION,
      {
        patchExtraAt: { 1: `${LOW_SUMMARIZATION}\n${PRUNER_OFF}` },
      },
    );

    // 前提：重啟前剪過 call_mid。
    const resumedAt = run.events.find((e) => e.type === 'session/end-seed')!;
    const recorded = run.events.filter(
      (e) => e.type === 'compaction/prune' && e.seq < resumedAt.seq,
    ) as SessionEvent<'compaction/prune'>[];
    expect(recorded.flatMap((e) => e.data.results.map((r) => r.callId))).toContain('call_mid');

    expect(toolResultText(firstBodyAfterResume(run), 'call_mid')).toContain(PRUNE_MARKER);
    // 關掉就是不再剪新的。
    expect(afterResume(run, 'compaction/prune')).toEqual([]);
    const last = run.mainBodies.at(-1)!;
    const fresh = toolResultText(last, 'call_mid2');
    expect(fresh, '新的大結果應該在最後一次請求裡').toBeDefined();
    expect(fresh).not.toContain(PRUNE_MARKER);
  }, 180_000);

  it('摘要那一列關掉：記過的剪法與參數截斷照樣套用，續接之後不再縮新的', async () => {
    const script = mainOnly((k) => (k === 0 ? bigThenSmall('') : k === 4 ? bigThenSmall('2') : {}));
    const texts = ['大結果', '二', '三', '重啟點之後的一句', '再一句'].map((t) => `${t}${PAD}`);
    const run = await runServePhases(
      [texts.slice(0, 3), texts.slice(3)],
      script,
      LOW_SUMMARIZATION,
      {
        patchExtraAt: { 1: SUMMARIZATION_OFF },
      },
    );

    const resumedAt = run.events.find((e) => e.type === 'session/end-seed')!;
    const before = (type: SessionEvent['type']) =>
      run.events.filter((e) => e.type === type && e.seq < resumedAt.seq);
    expect(before('compaction/prune').length, '重啟前就該剪過').toBeGreaterThan(0);
    expect(before('compaction/truncate-args').length, '重啟前就該縮短過').toBeGreaterThan(0);

    const first = firstBodyAfterResume(run);
    expect(toolResultText(first, 'call_mid')).toContain(PRUNE_MARKER);
    expect(JSON.stringify(first.messages)).toContain(TRUNCATE_MARKER);
    expect(afterResume(run, 'compaction/prune')).toEqual([]);
    expect(afterResume(run, 'compaction/truncate-args')).toEqual([]);
    expect(afterResume(run, 'compaction/summary')).toEqual([]);
  }, 180_000);

  it('摘要那一列關掉：已經摘要過的 thread 續接，送出去的是摘要＋之後的，不是摘要前的原文', async () => {
    const script = mainOnly((k) => (k === 0 ? bigThenSmall('') : {}));
    const texts = ['最早的一句', '二', '三', '四', '五', '重啟點之後的一句'].map(
      (t) => `${t}${PAD}`,
    );
    const run = await runServePhases(
      [texts.slice(0, 5), texts.slice(5)],
      script,
      LOW_SUMMARIZATION,
      {
        patchExtraAt: { 1: SUMMARIZATION_OFF },
      },
    );

    const resumedAt = run.events.find((e) => e.type === 'session/end-seed')!;
    const summaries = run.events.filter(
      (e) => e.type === 'compaction/summary' && e.seq < resumedAt.seq,
    );
    expect(summaries.length, '重啟前就該摘要過').toBeGreaterThan(0);

    const sent = JSON.stringify(firstBodyAfterResume(run).messages);
    // 摘要器的輔助呼叫回「【輔助呼叫】」，那就是摘要的內容。
    expect(sent).toContain('【輔助呼叫】');
    expect(sent).not.toContain('最早的一句');
  }, 180_000);
});

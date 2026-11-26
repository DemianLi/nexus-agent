/**
 * 續接之後讀回續接之前被摘掉的原文（[#2777](https://github.com/DemianLi/nexus-agent/issues/2777)）：走 `runServe --live`，兩台 serve 接同一個日誌目錄。
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { LOW_SUMMARIZATION, mainOnly, runServePhases } from './log-derived-history.fixture.js';
import type { Body, Reply } from './log-derived-history.fixture.js';

const PAD = '內容'.repeat(100);
/** 一句就跨過 {@link LOW_SUMMARIZATION} 的 6000 token 門檻：估算從上一次呼叫回報的用量起算，只有這一句新增的量算數。 */
const HUGE = '內容'.repeat(6_000);
/** 只出現在第一句裡的字面值：摘要之後不在任何一則送出去的訊息裡。 */
const DETAIL = 'retention_days=4417';

beforeAll(() => {
  // runServe 的 `--live` 要有金鑰才肯組模型；端點是本機假的，這顆不會送到任何地方。
  vi.stubEnv('NVIDIA_API_KEY', 'nvapi-fake-for-history-recall');
});
afterAll(() => {
  vi.unstubAllEnvs();
});

const toolTexts = (body: Body): string[] =>
  body.messages.filter((m) => m.role === 'tool').map((m) => JSON.stringify(m.content));

describe('讀回被摘掉的原文', () => {
  it('重啟之後，模型用 history_search 與 history_read 拿到重啟之前被摘掉的那一句', async () => {
    const before = [`設定是 ${DETAIL}`, '二', `三${HUGE}`, '四', '五'].map((t) => `${t}${PAD}`);
    // 前五次主呼叫各回一句；重啟後那一輪先搜尋、再讀第一筆、最後回話。
    const script = mainOnly((k): Reply => {
      if (k === 5)
        return {
          tools: [{ id: 's1', name: 'history_search', args: { query: DETAIL.toUpperCase() } }],
        };
      if (k === 6) return { tools: [{ id: 'r1', name: 'history_read', args: { entry: 1 } }] };
      return {};
    });
    const run = await runServePhases(
      [before, [`剛才的設定是多少？${PAD}`]],
      script,
      LOW_SUMMARIZATION,
    );

    const lastTurn = run.events.findLast((e) => e.type === 'turn/start')!;
    const summaries = run.events.filter((e) => e.type === 'compaction/summary');
    // 重啟之前就摘過，摘要的前言指向讀回的工具。
    expect(summaries[0]!.seq).toBeLessThan(lastTurn.seq);
    for (const event of summaries) {
      expect(JSON.stringify(event.data.summary)).toContain(
        'call history_search with a literal string',
      );
    }

    const search = run.mainBodies[6]!;
    const read = run.mainBodies[7]!;
    // 重啟後第一次主請求裡，那個字面值已經不在任何一則訊息上。
    expect(JSON.stringify(run.mainBodies[5]!.messages)).not.toContain(DETAIL);
    expect(toolTexts(search).at(-1)).toContain('1 match for');
    expect(toolTexts(search).at(-1)).toContain('entry 1, offset');
    expect(toolTexts(read).at(-1)).toContain('[entry #1, characters 0-');
    expect(toolTexts(read).at(-1)).toContain(`User: 設定是 ${DETAIL}`);
  }, 180_000);
});

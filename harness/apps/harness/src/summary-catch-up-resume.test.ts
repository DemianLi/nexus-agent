/**
 * 續接之後，摘要補追不撿上一個生命週期的切點（[#2434](https://github.com/DemianLi/nexus-agent/issues/2434)）。
 *
 * 續接灌回 graph state 的是「摘要＋切點之後」，新的座標從那一串算起（`conversation-restore.ts` 檔頭）；續接的日誌是
 * 「舊事件＋`session/end-seed`」。舊座標的切點套進新座標的話，摘要之後緊接的那幾則會從請求裡消失。切點記在組裝的切點表
 * （`@nexus/core` 的 `summary-cutoffs.ts`），這裡守的是：續接之後不套舊切點。
 *
 * 切點 1 時灌回串剛好不變、測不出誤切（`log-derived-history.test.ts` 的 SR2 是這個形狀）；灌回串短於切點時，
 * 切點表「切點超過訊息數」那一條會先擋下。所以這裡在大結果前先說三句短的，把切點推到 2 以上，
 * 之後再說 14 句，讓灌回串長過切點。
 * 走出貨的 `runServe --live`，兩段 serve 共用一個日誌目錄。
 */

import type { SessionEvent } from '@nexus/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  compareToLog,
  LOW_SUMMARIZATION,
  mainOnly,
  runServePhases,
} from './log-derived-history.fixture.js';
import type { Body, Reply } from './log-derived-history.fixture.js';

beforeAll(() => {
  // `--live` 要有金鑰才肯組模型；端點是本機假的，這顆不會送到任何地方。
  vi.stubEnv('NVIDIA_API_KEY', 'nvapi-fake-for-summary-catch-up-resume');
});
afterAll(() => {
  vi.unstubAllEnvs();
});

const PAD = '內容'.repeat(100);
const BIG: Reply = {
  tools: [{ id: 'call_mid', name: 'echo', args: { message: '中'.repeat(10_000) } }],
};
const TEXTS = [
  '短a',
  '短b',
  '短c',
  '大結果',
  ...Array.from({ length: 14 }, (_, index) => `短句${String(index)}`),
  '重啟點之後的一句',
].map((text) => `${text}${PAD}`);

/** 會話 id 每次不同，其他逐位元組比；第 0 則是系統訊息，不比。 */
const normalized = (body: Body) =>
  body.messages
    .slice(1)
    .map((message) => JSON.stringify(message).replace(/session_[0-9a-f]{8}/g, 'session_X'));

describe('續接之後的摘要補追（#2434）', () => {
  it('上一個生命週期摘要過（切點 ≥ 2、摘要之後那段夠長）：續接後的請求等於沒重啟的，也等於日誌推導', async () => {
    const script = () => mainOnly((k) => (k === 3 ? BIG : {}));
    const control = await runServePhases([TEXTS], script(), LOW_SUMMARIZATION);
    const restart = await runServePhases(
      [TEXTS.slice(0, -1), TEXTS.slice(-1)],
      script(),
      LOW_SUMMARIZATION,
    );

    // 前提成立，不然「相同」什麼都沒證明：重啟前摘要過、切點至少 2。
    const resumedAt = restart.events.find((e) => e.type === 'session/end-seed');
    expect(resumedAt, '應該有一次續接').toBeDefined();
    const summaries = restart.events.filter(
      (e): e is SessionEvent<'compaction/summary'> => e.type === 'compaction/summary',
    );
    expect(summaries.length).toBeGreaterThan(0);
    expect(
      summaries.every((e) => e.seq < resumedAt!.seq),
      '這個場景只在重啟前摘要',
    ).toBe(true);
    expect(summaries.at(-1)!.data.cutoffIndex).toBeGreaterThanOrEqual(2);

    const last = restart.mainBodies.at(-1)!;
    expect(normalized(last)).toEqual(normalized(control.mainBodies.at(-1)!));

    const verdicts = await compareToLog(restart.events, restart.mainBodies);
    expect(verdicts.filter((v) => v.kinds.length > 0 || !v.systemMatches)).toEqual([]);
  }, 180_000);
});

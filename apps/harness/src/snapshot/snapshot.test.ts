/**
 * **重放快照**（[#1556](https://github.com/DemianLi/nexus-agent/issues/1556) C077）：每個場景在真的 serve 上照夾具重放，落盤日誌正規化之後要跟夾具逐筆相同。
 * 做法與沒照抄 dsh 的地方見 `harness.ts`；夾具怎麼錄見 `record.ts`。
 *
 * 紅的時候先分清楚：產品改了行為（例如事件多一顆、欄位改名）是預期的漂移，用 `record.ts` 重錄；重放本身走歪（腳本錯位、
 * 少吃一格）看 `scriptAlignmentProblem` 與「腳本吃完」那一條。
 */

import { describe, expect, it } from 'vitest';

import { serveClient } from '../fixtures.js';
import {
  SNAPSHOT_THREAD_ID,
  driveScenario,
  listScenarios,
  loadScenario,
  normalizeSnapshotLog,
  readSnapshotLog,
  scriptAlignmentProblem,
  startReplayServe,
} from './harness.js';

const scenarios = await listScenarios();

describe('重放快照', () => {
  it('有場景可跑', () => {
    // 目錄讀錯（路徑、副檔名）時 `it.each` 一條都不生，整檔照樣綠。
    expect(scenarios).toEqual(['approval-resume', 'plain-reply', 'tool-round-trip']);
  });

  it.each(scenarios)(
    '%s：重放落盤的跟錄的逐筆相同',
    async (name) => {
      const scenario = await loadScenario(name);
      const fixture = await readSnapshotLog(scenario.dir, SNAPSHOT_THREAD_ID);
      expect(scriptAlignmentProblem(fixture.events)).toBeUndefined();

      const replay = await startReplayServe(scenario);
      try {
        await driveScenario(await serveClient(replay.running), scenario.input);
        await replay.stop();
        const replayed = await readSnapshotLog(replay.sessionDir, SNAPSHOT_THREAD_ID);
        // 腳本剛好吃完（dsh `assertConsumed`）：少叫一次，落盤的回覆就少一則，下面的逐筆比對會紅；這一條讓訊息直接講。
        expect(replayed.events.filter((event) => event.type === 'assistant/message')).toHaveLength(
          fixture.events.filter((event) => event.type === 'assistant/message').length,
        );
        expect(normalizeSnapshotLog(replayed)).toEqual(normalizeSnapshotLog(fixture));
      } finally {
        await replay.close();
      }
    },
    60_000,
  );
});

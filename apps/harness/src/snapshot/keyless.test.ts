/**
 * **重放不讀金鑰、不建真模型**（[#1556](https://github.com/DemianLi/nexus-agent/issues/1556) C077）：每個場景在重放的 serve 上跑完，
 * 讀 `.env` 的 `loadLiveLaunchEnv` 與建真模型的 `createLiveModel` 都是 0 次。兩支都包一層計次、照原樣執行，所以重放的 serve
 * 一旦帶上 `--live`（換回真模型那一列），這裡就紅。真模型沒建，就沒有任何東西連得到上游：CI 那一輪沒有 key 照樣綠。
 *
 * 重放 patch 把真模型那一列的上游指到 {@link UNREACHABLE_UPSTREAM}，所以這一條綠的時候上游本來就連不到；改壞或突變成帶 `--live`，
 * 請求也只會撞上本機沒人聽的埠，送不到外網。
 */

import { describe, expect, it, vi } from 'vitest';

import { serveClient } from '../fixtures.js';
import {
  SNAPSHOT_THREAD_ID,
  UNREACHABLE_UPSTREAM,
  driveScenario,
  listScenarios,
  loadScenario,
  readSnapshotLog,
  replayPatchText,
  startReplayServe,
} from './harness.js';

const live = vi.hoisted(() => ({
  loadLiveLaunchEnv: undefined as unknown as ReturnType<typeof vi.fn>,
  createLiveModel: undefined as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock('../live-model.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../live-model.js')>();
  live.loadLiveLaunchEnv = vi.fn(actual.loadLiveLaunchEnv);
  live.createLiveModel = vi.fn(actual.createLiveModel);
  return {
    ...actual,
    loadLiveLaunchEnv: live.loadLiveLaunchEnv,
    createLiveModel: live.createLiveModel,
  };
});

const scenarios = await listScenarios();

describe('重放不讀金鑰、不建真模型', () => {
  it('重放 patch 把真模型那一列的上游指到本機不可達的埠', () => {
    expect(new URL(UNREACHABLE_UPSTREAM).hostname).toBe('127.0.0.1');
    expect(replayPatchText([], 'm', '')).toContain(
      `- id: live-model\n  config:\n    baseUrl: '${UNREACHABLE_UPSTREAM}'\n`,
    );
  });

  it.each(scenarios)(
    '%s',
    async (name) => {
      const scenario = await loadScenario(name);
      const fixture = await readSnapshotLog(scenario.dir, SNAPSHOT_THREAD_ID);
      live.loadLiveLaunchEnv.mockClear();
      live.createLiveModel.mockClear();

      const replay = await startReplayServe(scenario);
      let replayed: typeof fixture;
      try {
        await driveScenario(await serveClient(replay.running), scenario.input);
        await replay.stop();
        replayed = await readSnapshotLog(replay.sessionDir, SNAPSHOT_THREAD_ID);
      } finally {
        await replay.close();
      }
      expect(live.loadLiveLaunchEnv).not.toHaveBeenCalled();
      expect(live.createLiveModel).not.toHaveBeenCalled();
      // 真的跑完了：回覆數跟夾具一樣，不是半途停下才沒呼叫到。
      const replies = (log: typeof fixture) =>
        log.events.filter((event) => event.type === 'assistant/message').length;
      expect(replies(replayed)).toBe(replies(fixture));
    },
    60_000,
  );
});

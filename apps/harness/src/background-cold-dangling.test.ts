/**
 * 懸空的工具呼叫＋背景子代理冷復活（[#2751](https://github.com/DemianLi/nexus-agent/issues/2751)）。
 *
 * 子日誌上有一次工具呼叫（`tool/call`）、結果卻沒有落盤（`tool/result` 被換成無關事件，模擬「那一刻被殺掉」），其後模型還有回覆。
 * 冷復活之後再對它說一句話：這一輪送給模型的 prompt 在 `state` 與 `log` 下逐字相同，而且懸空的呼叫後面都跟著一則補結
 * （「The tool call was interrupted after it was recorded…」），不是配不到結果的呼叫。
 *
 * `state` 的補結來自冷復活灌回 state 的那一步，`log` 的補結來自推導端；`log` 下請求不讀灌回去的 state，所以拿掉 graph 端
 * `patchToolCallsMiddleware.beforeAgent` 不影響這一輪（那一顆的掛載在 `packages/nexus-core/src/patch-tool-calls-mount.test.ts`）。
 *
 * 全走產品組裝與真的 JSONL 存放處，夾具見 `background-cold.fixture.ts`。**零憑證、零外部連線**。
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HistorySource } from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  boot,
  conversation,
  firstProcess,
  setupWorld,
  teardownWorld,
  until,
  world,
} from './background-cold.fixture.js';

beforeEach(setupWorld);
afterEach(teardownWorld);

/** 把子日誌上的 `tool/result` 換成無關事件：呼叫記下了、結果沒有。 */
async function dropToolResults(runId: string): Promise<void> {
  const directory = world.storeDirectory!;
  const file = (await readdir(directory, { recursive: true })).find(
    (name) => name.includes(runId) && name.endsWith('.jsonl'),
  );
  if (file === undefined) throw new Error(`找不到 ${runId} 的日誌檔`);
  const path = join(directory, file);
  const text = await readFile(path, 'utf8');
  expect(text).toContain('"type":"tool/call"');
  expect(text).toContain('"type":"tool/result"');
  await writeFile(path, text.replaceAll('"type":"tool/result"', '"type":"context/measure"'));
}

describe.each(['langgraph', 'native'] as const)('懸空的工具呼叫＋冷復活：%s', (agentLoop) => {
  async function revive(historySource: HistorySource) {
    world.storeDirectory = undefined;
    const { a } = await firstProcess(agentLoop, historySource);
    await dropToolResults(a.runId);
    const second = await boot({
      rootTurns: [{ content: '根' }],
      turnsFor: (name) => [{ content: `${name} 醒來答覆` }],
      resume: true,
      agentLoop,
      historySource,
    });
    try {
      await second.detach.background!.sendFromUser(a.runId, '重啟後的話');
      await until(
        () =>
          second.pump.sessions
            .get({ kind: 'subagent', runId: a.runId })
            ?.events.filter((event) => event.type === 'turn/end').length === 2,
      );
      return conversation(second.models['worker-a'].lastPrompt);
    } finally {
      await second.shutdown();
    }
  }

  it('log 與 state 的第二輪 prompt 逐字相同，懸空的呼叫後面跟著補結', async () => {
    const viaState = await revive('state');
    const viaLog = await revive('log');

    const types = viaLog.map((message) => message.type);
    const call = types.indexOf('ai');
    // 任務、呼叫、補結、其後那則回覆、新的一句話。
    expect(types).toEqual(['human', 'ai', 'tool', 'ai', 'human']);
    expect(types[call + 1]).toBe('tool');
    expect(String(viaLog[2]?.content)).toContain('interrupted after it was recorded');
    expect(viaLog.at(-1)).toEqual({ type: 'human', content: '重啟後的話' });
    expect(viaLog).toEqual(viaState);
  });
});

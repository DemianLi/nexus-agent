/**
 * 快照 harness 自己的量具（[#1556](https://github.com/DemianLi/nexus-agent/issues/1556) C077），不需要真模型：
 *
 * - **正規化把每一次都會變的值都收掉了**：同一份夾具重放兩次，正規化之後相等。漏收一個隨機值（中斷 id、送出佇列 id、時間），
 *   真夾具的比對就永遠是紅的，而且紅得跟「產品漂移」長得一樣。
 * - **比對抓得到走歪**：腳本少一則，比對要紅。
 *
 * 種子夾具只有兩則手寫的回覆（形狀照 `llm-replay.test.ts`）；第一次重放落盤的那份當夾具，再重放一次比。
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SESSION_LOG_FORMAT_VERSION } from '@nexus/core';
import type { SessionEvent } from '@nexus/core';
import { afterEach, describe, expect, it } from 'vitest';

import { serveClient } from '../fixtures.js';
import { sessionPathsIn } from '../jsonl-session-store.js';
import {
  CWD_TOKEN,
  SNAPSHOT_THREAD_ID,
  driveScenario,
  loadScenario,
  normalizeSnapshotLog,
  readSnapshotLog,
  scriptAlignmentProblem,
  startReplayServe,
} from './harness.js';
import type { RecordedMeta, Scenario, SnapshotLog } from './harness.js';

const MODEL_ID = 'nvidia/nemotron-3-super-120b-a12b';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function reply(id: string, blocks: readonly Record<string, unknown>[], finishReason: string) {
  return {
    type: 'ai',
    data: {
      id,
      content: blocks,
      usage_metadata: { input_tokens: 5000, output_tokens: 50, total_tokens: 5050 },
      response_metadata: {
        output_version: 'v1',
        model_provider: 'openai',
        model_name: MODEL_ID,
        finish_reason: finishReason,
      },
      tool_calls: blocks.filter((block) => block.type === 'tool_call'),
      invalid_tool_calls: [],
      content_blocks: blocks,
      additional_kwargs: {},
    },
  };
}

/** 核准場景要的兩則：叫 echo、收尾。 */
const SEED = [
  reply(
    'chatcmpl-seed-0',
    [
      { type: 'reasoning', reasoning: '要叫 echo。' },
      { type: 'tool_call', id: 'call_seed_0', name: 'echo', args: { message: '核准' } },
    ],
    'tool_use',
  ),
  reply(
    'chatcmpl-seed-1',
    [
      { type: 'reasoning', reasoning: '收尾。' },
      { type: 'text', text: '它回了「回聲：核准」。' },
    ],
    'stop',
  ),
];

/** 寫一份夾具到暫存的場景目錄，沿用某個真場景的輸入與 patch。 */
async function scenarioWith(from: Scenario, log: SnapshotLog | 'seed'): Promise<Scenario> {
  const dir = await mkdtemp(join(tmpdir(), 'nexus-snapshot-self-'));
  dirs.push(dir);
  await mkdir(dir, { recursive: true });
  const paths = sessionPathsIn(dir, SNAPSHOT_THREAD_ID);
  if (log === 'seed') {
    const header = {
      version: SESSION_LOG_FORMAT_VERSION,
      id: SNAPSHOT_THREAD_ID,
      createdAt: 0,
      cwd: CWD_TOKEN,
    };
    await writeFile(paths.header, `${JSON.stringify(header)}\n`, 'utf8');
    const events = SEED.map((message, seq) => ({
      type: 'assistant/message',
      seq,
      time: 0,
      data: { message },
    }));
    await writeFile(
      paths.log,
      events.map((event) => `${JSON.stringify(event)}\n`).join(''),
      'utf8',
    );
  } else {
    await writeFile(paths.header, `${JSON.stringify(log.header)}\n`, 'utf8');
    await writeFile(
      paths.log,
      log.events.map((event) => `${JSON.stringify(event)}\n`).join(''),
      'utf8',
    );
  }
  const meta: RecordedMeta = {
    modelId: MODEL_ID,
    recordedAt: '2026-10-24T00:00:00.000Z',
    forwardedPosts: 2,
  };
  await writeFile(join(dir, 'recorded.json'), JSON.stringify(meta), 'utf8');
  return { ...from, dir };
}

async function replay(scenario: Scenario): Promise<SnapshotLog> {
  const served = await startReplayServe(scenario);
  try {
    await driveScenario(await serveClient(served.running), scenario.input);
    await served.stop();
    return await readSnapshotLog(served.sessionDir, SNAPSHOT_THREAD_ID);
  } finally {
    await served.close();
  }
}

describe('快照 harness', () => {
  it('同一份夾具重放兩次，正規化之後相等（含核准中斷）', async () => {
    const approval = await loadScenario('approval-resume');
    const first = await replay(await scenarioWith(approval, 'seed'));
    expect(scriptAlignmentProblem(first.events)).toBeUndefined();
    expect(first.events.some((event) => event.type === 'interrupt/raised')).toBe(true);

    const second = await replay(await scenarioWith(approval, first));
    expect(normalizeSnapshotLog(second)).toEqual(normalizeSnapshotLog(first));
  }, 60_000);

  it('腳本少一則：比對是紅的', async () => {
    const approval = await loadScenario('approval-resume');
    const first = await replay(await scenarioWith(approval, 'seed'));
    // 拿掉收尾那一則：第二次呼叫就吃不到，落盤的跟夾具不一樣。
    const lastReply = first.events.findLastIndex((event) => event.type === 'assistant/message');
    const truncated: SessionEvent[] = first.events.slice(0, lastReply);
    const fixture = { header: first.header, events: truncated };
    const second = await replay(await scenarioWith(approval, fixture));
    expect(normalizeSnapshotLog(second)).not.toEqual(normalizeSnapshotLog(fixture));
  }, 60_000);
});

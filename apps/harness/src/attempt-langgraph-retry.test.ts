/**
 * **`langgraph` 下 `assistant/attempt` 由 pump 寫在失敗收尾之後**：重試那一輪的 root 日誌逐位元組對夾具，只正規化 `time`、
 * 退避毫秒與隨機 UUID（見 `normalizedJsonl`）。
 *
 * 重錄：`UPDATE_ATTEMPT_FIXTURES=1`，並在 PR 內文逐條說明 diff。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LIVE_API_KEY_ENV } from './live-model.js';
import { normalizedJsonl, runRetryTurn } from './attempt-retry-turn.fixture.js';
import type { RetryAct } from './attempt-retry-turn.fixture.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'attempt-langgraph-retry');

describe('langgraph 下重試的日誌不變', () => {
  const original = process.env[LIVE_API_KEY_ENV];
  beforeEach(() => {
    process.env[LIVE_API_KEY_ENV] = 'nvapi-test-value-not-a-real-key';
  });
  afterEach(() => {
    if (original === undefined) delete process.env[LIVE_API_KEY_ENV];
    else process.env[LIVE_API_KEY_ENV] = original;
  });

  const cases: readonly (readonly [string, RetryAct])[] = [
    ['mid503', 'mid503'],
    ['cut', 'cut'],
    ['stall', 'stall'],
  ];

  it.each(cases)(
    '%s：第一次失敗、重打成功，日誌逐位元組同夾具',
    async (name, act) => {
      const run = await runRetryTurn([act], { loop: 'langgraph' });
      expect(run.thrown).toBeUndefined();
      expect(run.hits).toBe(2);
      const actual = normalizedJsonl(run.events);
      const file = join(DIR, `${name}.jsonl`);
      if (process.env['UPDATE_ATTEMPT_FIXTURES'] === '1') {
        mkdirSync(DIR, { recursive: true });
        writeFileSync(file, actual);
      }
      expect(existsSync(file)).toBe(true);
      expect(actual).toBe(readFileSync(file, 'utf8'));
    },
    30_000,
  );

  it('作廢的那半段被拒：日誌少那一顆、這一輪照常成功（照今天吞錯）', async () => {
    const run = await runRetryTurn(['mid503'], {
      loop: 'langgraph',
      reject: { types: ['assistant/attempt'], error: new Error('磁碟滿了') },
    });
    expect(run.thrown).toBeUndefined();
    expect(run.hits).toBe(2);
    expect(run.events.map((e) => e.type)).not.toContain('assistant/attempt');
    const actual = normalizedJsonl(run.events);
    const file = join(DIR, 'mid503-attempt-rejected.jsonl');
    if (process.env['UPDATE_ATTEMPT_FIXTURES'] === '1') writeFileSync(file, actual);
    expect(actual).toBe(readFileSync(file, 'utf8'));
  }, 30_000);

  it('attempt 只有一顆，seq 落在失敗那顆 model/end 之後（今天的位置）', async () => {
    const run = await runRetryTurn(['mid503'], { loop: 'langgraph' });
    const attempts = run.events.filter((e) => e.type === 'assistant/attempt');
    expect(attempts).toHaveLength(1);
    const failedEnd = run.events.find(
      (e) => e.type === 'model/end' && (e.data as { outcome?: string }).outcome === 'error',
    )!;
    expect(attempts[0]!.seq).toBeGreaterThan(failedEnd.seq);
  }, 30_000);
});

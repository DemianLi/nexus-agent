/**
 * K10（#2360）記憶體量測：serve（single）開 N 條 thread、各跑 T 輪之後，GC 完的 heapUsed。loop 由 `K10_LOOP` 給（省略是 native）。
 *
 * 只在 `K10_MEASURE=1` 時跑：
 *   K10_MEASURE=1 K10_LOOP=langgraph pnpm --filter @nexus/harness exec vitest run src/measure/k10-memory
 */

import { appendFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

import type { Event } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { foldTurn, serveClient } from '../fixtures.js';
import { startScriptedServe } from '../scripted-serve.js';
import type { ScriptedTurn } from '../scripted-model.js';

const N = Number(process.env.K10_N ?? 20);
const T = Number(process.env.K10_T ?? 10);
const REPLY = '回'.repeat(2000);
const LOOP = process.env.K10_LOOP ?? 'native';

function heapAfterGc(): number {
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc') as () => void;
  for (let i = 0; i < 3; i += 1) gc();
  return process.memoryUsage().heapUsed;
}

describe.skipIf(process.env.K10_MEASURE !== '1')('K10 記憶體', () => {
  it(`N=${N} 條 thread × T=${T} 輪之後的 heapUsed`, async () => {
    const logs = await mkdtemp(join(tmpdir(), 'nexus-k10-memory-'));
    const turns: ScriptedTurn[] = Array.from({ length: N * T }, () => ({ content: REPLY }));
    const serve = await startScriptedServe(turns, {
      argv: ['--agent-loop', LOOP, '--session-log', logs],
    });
    try {
      const client = await serveClient(serve.running);
      const before = heapAfterGc();
      const streams: AsyncIterator<Event>[] = [];
      for (let n = 0; n < N; n += 1) streams.push(await client.openEvents(`k10-${n}`));
      for (let t = 0; t < T; t += 1) {
        for (let n = 0; n < N; n += 1) {
          await client.runStart(`k10-${n}`, `第 ${t} 輪`);
          await foldTurn(streams[n]!);
        }
      }
      const after = heapAfterGc();
      for (const stream of streams) await stream.return?.(undefined);
      const line = `K10 memory loop=${LOOP} N=${N} T=${T} heapUsed before=${(before / 2 ** 20).toFixed(1)}MB after=${(after / 2 ** 20).toFixed(1)}MB delta=${((after - before) / 2 ** 20).toFixed(1)}MB`;
      if (process.env.K10_OUT !== undefined) appendFileSync(process.env.K10_OUT, `${line}\n`);
      console.log(line);
      expect(after).toBeGreaterThan(0);
    } finally {
      await serve.close();
      await rm(logs, { recursive: true, force: true });
    }
  }, 600_000);
});

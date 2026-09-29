/**
 * 產品路徑上的 `GET /threads/:id/session-references`——[#713](https://github.com/DemianLi/nexus-agent/issues/713)。
 *
 * 候選排得對不對在 [`session-reference-candidates.test.ts`](./session-reference-candidates.test.ts)；這一檔問的是只有產品路徑上量得到的：
 *
 * 1. **列候選一條 agent 都不建**，連提問的那條 thread 也不建。量具是一顆只記次數的見證 plugin（`assembly-witness.fixture.ts`）。
 * 2. **跨專案**：會話根底下別格的會話列得出來，標同工作區與否。
 * 3. **沒落盤就是「不提供」**，不是空清單。
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SESSION_LOG_FORMAT_VERSION } from '@nexus/core';
import type { SessionReferenceListResult } from '@nexus/wire';
import { parseSessionReferenceText } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';
import { assemblyWitness, resetAssemblyWitness } from './assembly-witness.fixture.js';
import { foldTurn, serveClient } from './fixtures.js';
import { openJsonlSessionStore, projectKey } from './jsonl-session-store.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';

let running: RunningServe | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

const WITNESS = fileURLToPath(new URL('./assembly-witness.patch.yml', import.meta.url));
const PERSISTENCE_OFF_PATCH = fileURLToPath(
  new URL('./settings/persistence-off.patch.yml', import.meta.url),
);

async function start(root: string, extra: readonly string[] = []): Promise<RunningServe> {
  resetAssemblyWitness();
  running = (await runServe({
    argv: ['--port', '0', '--patch', WITNESS, '--session-log', root, ...extra],
    log: () => undefined,
    env: {},
  })) as RunningServe;
  return running;
}

async function driveTurn(server: RunningServe, threadId: string, prompt: string): Promise<void> {
  const client = await serveClient(server);
  const events = await client.openEvents(threadId);
  await client.runStart(threadId, prompt);
  await foldTurn(events);
  await events.return?.(undefined);
}

async function references(server: RunningServe, threadId: string, query: string) {
  const outcome = await (await serveClient(server)).sessionReferences(threadId, query);
  if (outcome.kind !== 'ok') throw new Error(`列會話被拒：${outcome.message}`);
  return outcome.result;
}

function available(result: SessionReferenceListResult) {
  if (!result.available) throw new Error('這台 server 說它不提供列會話');
  return result.candidates;
}

describe('GET /threads/:id/session-references', () => {
  it('重開之後列得出以前的會話與別的專案的，排除提問的那條；一條 agent 都不建', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-serve-refs-'));
    const first = await start(root);
    await driveTurn(first, 'alpha', '先開的那條');
    await driveTurn(first, 'beta', '後開的那條');
    await first.close();
    running = undefined;

    // 別的專案那一格：手寫一份，header 的 cwd 是別的目錄。
    const other = openJsonlSessionStore({ directory: join(root, projectKey('/別的專案')) }).create({
      version: SESSION_LOG_FORMAT_VERSION,
      id: 'elsewhere',
      createdAt: 5,
      cwd: '/別的專案',
    });
    await other.append([
      {
        type: 'turn/start',
        seq: 0,
        time: 9_999_999_999_999,
        data: { kind: 'message', text: '別處的事' },
      } as never,
    ]);
    await other.close();

    const second = await start(root);
    const built = assemblyWitness.applied;
    // 提問的是一條從沒開過的 thread：不該為它建 agent。
    const candidates = available(await references(second, 'brand-new', ''));
    expect(
      candidates.map(({ sessionId, label, sameWorkspace }) => [sessionId, label, sameWorkspace]),
    ).toEqual([
      ['beta', '後開的那條', true],
      ['alpha', '先開的那條', true],
      ['elsewhere', '別處的事', false],
    ]);
    expect(assemblyWitness.applied).toBe(built);

    // 提問的那條自己不在裡面；mention 解得回它指的會話。
    const filtered = available(await references(second, 'beta', '先開'));
    expect(filtered.map(({ sessionId }) => sessionId)).toEqual(['alpha']);
    expect(parseSessionReferenceText(filtered[0]!.mention).references).toEqual([
      { sessionId: 'alpha', label: '先開的那條' },
    ]);
    expect(
      available(await references(second, 'beta', '')).map(({ sessionId }) => sessionId),
    ).not.toContain('beta');
    expect(assemblyWitness.applied).toBe(built);
  });

  it('清單把落盤關掉：不提供，不是空清單', async () => {
    resetAssemblyWitness();
    running = (await runServe({
      argv: ['--port', '0', '--patch', PERSISTENCE_OFF_PATCH],
      log: () => undefined,
      env: {},
    })) as RunningServe;
    expect(await references(running, 'any', '')).toEqual({ available: false });
  });
});

/**
 * 子代理選模型的政策走過產品路徑（[#875](https://github.com/DemianLi/nexus-agent/issues/875)）：真的 `runServe`、真的落盤，
 * 看 root 日誌上有沒有 `subagent/model-selection-policy`。
 *
 * 要釘的：新會話在設定打開時取樣一次、而且在第一輪開始之前；續接只讀日誌，不重寫也不看現在的設定（關掉了仍在、
 * 本來沒有的打開了仍然沒有）；允許清單裡有型錄沒有的 id，server 起不來。
 *
 * 允許清單那顆模型是出廠型錄的預設那一顆，三份 patch 固定字面。
 */

import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionEvent } from '@nexus/core';
import { afterEach, describe, expect, it } from 'vitest';
import { foldTurn, serveClient } from './fixtures.js';
import { projectKey } from './jsonl-session-store.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';

const ON = 'src/settings/model-selection-on.patch.yml';
const UNKNOWN = 'src/settings/model-selection-unknown.patch.yml';
const POLICY = 'subagent/model-selection-policy';

let running: RunningServe | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function start(root: string, patches: readonly string[]): Promise<RunningServe> {
  const server = await runServe({
    argv: ['--port', '0', '--session-log', root, ...patches.flatMap((patch) => ['--patch', patch])],
    log: () => undefined,
    env: {},
  });
  running = server;
  return server as RunningServe;
}

async function stop(server: RunningServe): Promise<void> {
  await server.close();
  running = undefined;
}

async function driveTurn(server: RunningServe, threadId: string, prompt: string): Promise<void> {
  const client = await serveClient(server);
  const events = await client.openEvents(threadId);
  await client.runStart(threadId, prompt);
  await foldTurn(events);
  await events.return?.(undefined);
}

async function logOf(root: string, threadId: string): Promise<readonly SessionEvent[]> {
  const body = await readFile(join(root, projectKey(process.cwd()), `${threadId}.jsonl`), 'utf8');
  return body
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as SessionEvent);
}

const policies = (events: readonly SessionEvent[]) =>
  events.filter((event) => event.type === POLICY);

describe('子代理選模型的政策在 serve 上', () => {
  it('新會話、設定打開：日誌在第一輪開始之前有一顆，內容是允許清單；設定關掉再續接，仍只有那一顆', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-model-policy-'));
    const first = await start(root, [ON]);
    await driveTurn(first, 'alpha', '第一句');
    await stop(first);

    const events = await logOf(root, 'alpha');
    expect(policies(events)).toEqual([
      expect.objectContaining({ data: { allowedModels: ['nvidia/nemotron-3-super-120b-a12b'] } }),
    ]);
    expect(events.findIndex((event) => event.type === POLICY)).toBeLessThan(
      events.findIndex((event) => event.type === 'turn/start'),
    );

    // 設定關掉（不給 patch）再續接：日誌那顆還在、沒有第二顆。
    const second = await start(root, []);
    await driveTurn(second, 'alpha', '第二句');
    await stop(second);
    expect(policies(await logOf(root, 'alpha'))).toHaveLength(1);

    // 設定仍開著再續接一次：一樣只有一顆（不因為「有設定」重寫）。
    const third = await start(root, [ON]);
    await driveTurn(third, 'alpha', '第三句');
    await stop(third);
    expect(policies(await logOf(root, 'alpha'))).toHaveLength(1);
  }, 30000);

  it('舊會話（沒有那顆）把設定打開再續接：仍然沒有；同一台 server 上新開的會話才有', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-model-policy-'));
    const first = await start(root, []);
    await driveTurn(first, 'legacy', '舊的');
    await stop(first);
    expect(policies(await logOf(root, 'legacy'))).toEqual([]);

    const second = await start(root, [ON]);
    await driveTurn(second, 'legacy', '接著講');
    await driveTurn(second, 'fresh', '新的');
    await stop(second);
    expect(policies(await logOf(root, 'legacy'))).toEqual([]);
    expect(policies(await logOf(root, 'fresh'))).toHaveLength(1);
  }, 30000);

  it('預設（不給 patch）：日誌沒有那顆', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-model-policy-'));
    const server = await start(root, []);
    await driveTurn(server, 'plain', '嗨');
    await stop(server);
    expect(policies(await logOf(root, 'plain'))).toEqual([]);
  }, 30000);

  it('允許清單裡有型錄沒有的 id：server 起不來，訊息指名它', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-model-policy-'));
    await expect(start(root, [UNKNOWN])).rejects.toThrow(/nowhere\/ghost-model/);
  });
});

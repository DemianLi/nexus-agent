/**
 * 續接時日誌記的可寫根這台 serve 接不上，回專用碼 `thread_root_mismatch`，訊息不帶主機路徑
 * （[#2222](https://github.com/DemianLi/nexus-agent/issues/2222)）。
 *
 * 從 `runServe` 起：兩台真的 serve、真的 JSONL 存放處、真的 wire client，共用 `--session-log`，home 或 `--workspace` 不同。
 *
 * **零憑證、零外部連線**：模型是腳本。
 */

import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { THREAD_ROOT_MISMATCH, WireRejectedError } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';

import { foldTurn, serveClient } from './fixtures.js';
import { startScriptedServe } from './scripted-serve.js';
import type { ScriptedServe } from './scripted-serve.js';

const TURNS = [{ content: '好。' }] as const;

let serve: ScriptedServe | undefined;
let root = '';

afterEach(async () => {
  await serve?.close();
  serve = undefined;
  await rm(root, { recursive: true, force: true });
});

type Options = Parameters<typeof startScriptedServe>[1];

async function start(options: Options, log?: (line: string) => void): Promise<ScriptedServe> {
  serve = await startScriptedServe(TURNS as never, {
    ...options,
    argv: ['--session-log', join(root, 'sessions')],
    ...(log === undefined ? {} : { log }),
  });
  return serve;
}

/** 第一台寫下 `alpha` 關掉；第二台續接被拒，回拒絕與第二台的日誌。 */
async function refusedAfterHandover(
  first: (dir: string) => Options,
  second: (dir: string) => Options,
): Promise<{ readonly refused: WireRejectedError; readonly logged: string }> {
  root = await realpath(await mkdtemp(join(tmpdir(), 'nexus-serve-root-mismatch-')));
  await mkdir(join(root, 'work'));
  const writer = await start(first(root));
  const writerClient = await serveClient(writer.running);
  const events = await writerClient.openEvents('alpha');
  await writerClient.runStart('alpha', '第一句');
  await foldTurn(events);
  await events.return?.(undefined);
  await writer.close();
  serve = undefined;

  const lines: string[] = [];
  const reader = await start(second(root), (line) => lines.push(line));
  const client = await serveClient(reader.running);
  const refused = await client.openEvents('alpha').then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(refused).toBeInstanceOf(WireRejectedError);
  expect(await client.runStart('alpha', '第二句')).toMatchObject({
    type: 'error',
    error: THREAD_ROOT_MISMATCH,
  });
  return { refused: refused as WireRejectedError, logged: lines.join('\n') };
}

describe('日誌記的可寫根這台 serve 接不上（#2222）', () => {
  it('不同 home 接手：專用碼，訊息講回原本的 home、不帶路徑；兩個根進 serve 的日誌', async () => {
    const homed =
      (home: string) =>
      (dir: string): Options => ({
        workspace: join(dir, 'work'),
        env: { NEXUS_AGENT_HOME: join(dir, home) },
      });

    const { refused, logged } = await refusedAfterHandover(homed('home-a'), homed('home-b'));
    expect(refused.code).toBe(THREAD_ROOT_MISMATCH);
    expect(refused.serverMessage).toContain('alpha');
    expect(refused.serverMessage).toContain('要回原本的 home');
    expect(refused.serverMessage).not.toContain(root);
    expect(refused.serverMessage).not.toContain('建不起來');
    expect(logged).toContain(join(root, 'home-a', 'thread-roots'));
    expect(logged).toContain(join(root, 'work'));
  });

  it('換了工作區：同一個專用碼，出路是原本的 --workspace，不叫人回 home', async () => {
    const rooted =
      (name: string) =>
      (dir: string): Options => ({
        workspace: join(dir, 'work'),
        workspaceRootOf: () => join(dir, name),
      });

    const { refused, logged } = await refusedAfterHandover(rooted('old'), rooted('new'));
    expect(refused.code).toBe(THREAD_ROOT_MISMATCH);
    expect(refused.serverMessage).toContain('--workspace');
    expect(refused.serverMessage).not.toContain('home');
    expect(refused.serverMessage).not.toContain(root);
    expect(logged).toContain(join(root, 'old'));
    expect(logged).toContain(join(root, 'new'));
  });
});

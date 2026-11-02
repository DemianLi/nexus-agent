/**
 * 寫租約被別的寫入者握著時，續接那條 thread 回專用碼 `thread_writer_held`，不是 `unknown_error`
 * （[#2031](https://github.com/DemianLi/nexus-agent/issues/2031)）。
 *
 * 從 `runServe` 起：真的 serve、真的 JSONL 存放處、真的 wire client。握著租約的是測試行程自己開的另一個寫入把手
 * （`openJsonlSessionStore(...).resume`），`flock` 以開檔為單位，同一個行程第二次開也搶不到，等於另一個行程握著。
 *
 * **零憑證、零外部連線**：模型是腳本。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { THREAD_WRITER_HELD, WireRejectedError } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';

import { foldTurn, serveClient } from './fixtures.js';
import { openJsonlSessionStore } from './jsonl-session-store.js';
import { startScriptedServe } from './scripted-serve.js';
import type { ScriptedServe } from './scripted-serve.js';
import { sessionOf } from './session-files.fixture.js';

const TURNS = [{ content: '好。' }, { content: '好。' }, { content: '好。' }] as const;

let serve: ScriptedServe | undefined;
const temporary: string[] = [];

afterEach(async () => {
  await serve?.close();
  serve = undefined;
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function start(root: string): Promise<ScriptedServe> {
  serve = await startScriptedServe(TURNS as never, { argv: ['--session-log', root] });
  return serve;
}

describe('寫租約被別的寫入者握著（#2031）', () => {
  it('續接回 thread_writer_held、訊息不帶「建不起來」；放掉之後同一個請求成功', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-serve-writer-held-'));
    temporary.push(root);

    // 第一台 serve 寫下 `alpha`，關掉：磁碟上留一條要續接的 thread。
    const first = await start(root);
    const firstClient = await serveClient(first.running);
    const events = await firstClient.openEvents('alpha');
    await firstClient.runStart('alpha', '第一句');
    await foldTurn(events);
    await events.return?.(undefined);
    await first.close();
    serve = undefined;

    const alpha = await sessionOf(root, 'alpha');
    const holder = await openJsonlSessionStore({ directory: alpha.directory }).resume('alpha');
    let released = false;
    try {
      const second = await start(root);
      const client = await serveClient(second.running);

      const caught = await client.openEvents('alpha').then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(caught).toBeInstanceOf(WireRejectedError);
      expect((caught as WireRejectedError).code).toBe(THREAD_WRITER_HELD);
      expect((caught as WireRejectedError).serverMessage).toContain('alpha');
      expect((caught as WireRejectedError).serverMessage).not.toContain('建不起來');

      expect(await client.runStart('alpha', '第二句')).toMatchObject({
        type: 'error',
        error: THREAD_WRITER_HELD,
      });

      // 暫時的：放掉之後同一條 thread 照常開得起來。
      await holder.stored.close();
      released = true;
      const reopened = await client.openEvents('alpha');
      expect(await client.runStart('alpha', '第三句')).toMatchObject({ type: 'success' });
      await foldTurn(reopened);
      await reopened.return?.(undefined);
    } finally {
      if (!released) await holder.stored.close();
    }
  });
});

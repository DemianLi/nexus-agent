/**
 * 子代理的會話不是 thread：拒絕把它當成一條 thread 打開或驅動（[#1544](https://github.com/DemianLi/nexus-agent/issues/1544)）。
 *
 * 從 `runServe` 起——真的 serve、真的 JSONL 存放處、真的 wire client；子代理的日誌手寫成 `<thread>/<編號>` 加 header 的
 * `parentSession`（真的由背景子代理產出的那一份在 `subagent-history-wire.test.ts` 量過，形狀一樣）。
 *
 * 探針（卡上情境 B）是 serve 重啟後，把子代理 id 當 thread_id 送一句話：以前整條通、子代理日誌被續寫（改核准政策、補結、派孫代理）。
 * 這一檔釘的是：**碰日誌之前就拒絕、日誌一個位元組都不動**。日誌特地留成「當掉的一輪」（`turn/start` 沒有收尾）——
 * 續接會先把補結寫回檔上（#721），所以「先 resume 再拒」會讓 sha1 變掉，這一檔會紅。
 *
 * **零憑證、零外部連線**：模型是腳本。
 */

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SESSION_LOG_FORMAT_VERSION } from '@nexus/core';
import { THREAD_IS_SUBAGENT, WireRejectedError } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';

import { foldTurn, serveClient } from './fixtures.js';
import { openJsonlSessionStore, projectKey } from './jsonl-session-store.js';
import { startScriptedServe } from './scripted-serve.js';
import type { ScriptedServe } from './scripted-serve.js';

const TURNS = [{ content: '好' }] as const;
const RUN_ID = 'bg-0123456789ab';
const SUBAGENT = `alpha/${RUN_ID}`;

let serve: ScriptedServe | undefined;
const temporary: string[] = [];

afterEach(async () => {
  await serve?.close();
  serve = undefined;
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});

const sha1 = (text: string | Buffer): string => createHash('sha1').update(text).digest('hex');

/** 在 `root` 底下起一台 serve（`--session-log`）。 */
async function start(root: string): Promise<ScriptedServe> {
  serve = await startScriptedServe(TURNS, { argv: ['--session-log', root] });
  return serve;
}

/** 起一台、讓 `alpha` 跑完一輪、收掉。回這個會話根。 */
async function seedRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'nexus-serve-subagent-'));
  temporary.push(root);
  const first = await start(root);
  const client = await serveClient(first.running);
  const events = await client.openEvents('alpha');
  await client.runStart('alpha', '主對話');
  await foldTurn(events);
  await events.return?.(undefined);
  await first.close();
  serve = undefined;
  return root;
}

/** 手寫子代理的日誌：header 指回 `alpha`，本文停在「當掉的一輪」。回兩個檔的路徑。 */
async function writeSubagentLog(root: string, parent: string | undefined = 'alpha') {
  const directory = join(root, projectKey(process.cwd()));
  const header = join(directory, `alpha%2f${RUN_ID}.header.json`);
  const body = join(directory, `alpha%2f${RUN_ID}.jsonl`);
  await writeFile(
    header,
    JSON.stringify({
      version: SESSION_LOG_FORMAT_VERSION,
      id: SUBAGENT,
      createdAt: 1,
      ...(parent === undefined ? {} : { parentSession: parent }),
    }),
  );
  const line = (type: string, seq: number, data: unknown) =>
    `${JSON.stringify({ type, seq, time: seq + 1, data })}\n`;
  await writeFile(
    body,
    line('approval/policy', 0, { policy: 'never', source: 'delegation' }) +
      line('turn/start', 1, { kind: 'message', text: '派給子代理的話' }),
  );
  return { directory, header, body };
}

const digest = async (files: { header: string; body: string }) => ({
  header: sha1(await readFile(files.header)),
  body: sha1(await readFile(files.body)),
  entries: (await readdir(join(files.header, '..'))).sort(),
});

/** 一次嘗試的結果：丟出來的錯（沒丟就是 `undefined`）。 */
async function rejection(attempt: () => Promise<unknown>): Promise<unknown> {
  return attempt().then(
    () => undefined,
    (caught: unknown) => caught,
  );
}

describe('子代理的會話不是 thread（#1544 驗收 1、2）', () => {
  it('重啟之後：下行與 run.start 都回 thread_is_subagent，子代理的日誌一個位元組都不動，之後 subagent 的路照常', async () => {
    const root = await seedRoot();
    const files = await writeSubagentLog(root);
    const before = await digest(files);

    const second = await start(root);
    const client = await serveClient(second.running);

    const opened = await rejection(() => client.openEvents(SUBAGENT));
    expect(opened).toBeInstanceOf(WireRejectedError);
    expect((opened as WireRejectedError).code).toBe(THREAD_IS_SUBAGENT);
    expect((opened as WireRejectedError).serverMessage).toContain('subagent.send');
    expect((opened as WireRejectedError).serverMessage).not.toContain('建不起來');

    const started = await client.runStart(SUBAGENT, '冒名');
    expect(started).toMatchObject({ type: 'error', error: THREAD_IS_SUBAGENT });

    // 一個位元組都不動：補結沒寫（本文 sha1 不變）、header 沒被取代、沒有多出檔（暫存檔、孫代理）。
    expect(await digest(files)).toEqual(before);

    // 冒名的請求沒有留下租約：這個會話還拿得到寫把手（之後父對話叫醒它才不會撞上）。
    const probe = await openJsonlSessionStore({ directory: files.directory }).resume(SUBAGENT);
    await probe.stored.close();
  });

  it('父 thread 還在記憶體、子代理的租約被握著：回的是專屬碼，不是 unknown_error（拿掉冷讀、只留續接後的核對就紅）', async () => {
    const root = await seedRoot();
    const files = await writeSubagentLog(root);
    // 租約被握著：以前先撞上租約，回「多半是另一個行程還開著它」。
    const holder = await openJsonlSessionStore({ directory: files.directory }).resume(SUBAGENT);
    try {
      const second = await start(root);
      const client = await serveClient(second.running);
      const opened = await rejection(() => client.openEvents(SUBAGENT));
      expect(opened).toBeInstanceOf(WireRejectedError);
      expect((opened as WireRejectedError).code).toBe(THREAD_IS_SUBAGENT);
    } finally {
      await holder.stored.close();
    }
  });

  it('反例：沒有 parentSession 的 `alpha/…` 是一條普通的新 thread，照常開', async () => {
    const root = await seedRoot();
    const second = await start(root);
    const client = await serveClient(second.running);

    const events = await client.openEvents('alpha/not-a-subagent');
    await events.return?.(undefined);
    expect(await client.runStart('alpha/not-a-subagent', '照常')).toMatchObject({
      type: 'success',
    });
  });

  it('反例：以前寫過的普通 thread 照常接回來（閘不誤擋）', async () => {
    const root = await seedRoot();
    const second = await start(root);
    const client = await serveClient(second.running);

    const events = await client.openEvents('alpha');
    await client.runStart('alpha', '第二句');
    await foldTurn(events);
    await events.return?.(undefined);
  });

  it('子代理自己那條路（subagent.history）不受影響：照樣讀得到', async () => {
    const root = await seedRoot();
    await writeSubagentLog(root);
    const second = await start(root);
    const client = await serveClient(second.running);

    const found = await client.subagentHistory('alpha', RUN_ID);
    expect(JSON.stringify(found)).toContain('派給子代理的話');
  });
});

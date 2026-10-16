/**
 * thread 數上限走完**serve 的組裝**（[#1476](https://github.com/DemianLi/nexus-agent/issues/1476)，驗收 F）。
 *
 * `thread-capacity.test.ts` 直接把 `maxThreads` 傳給 wire handler，量的是計數語意；那種測法拿掉 `serve.ts` 把設定交給
 * handler 的那一行也照樣綠。這一檔從 `runServe` 起——出貨清單加一份把 `thread-capacity` 設成 1 的 patch——
 * 量「設定列 → `startupSetting` → `createWireHandler` → `threadFor`」整條線，並看起動日誌印出上限。
 *
 * **零憑證、零外部連線**：模型是腳本。
 */

import { THREAD_AT_CAPACITY, WireRejectedError } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';

import { foldTurn, serveClient } from './fixtures.js';
import { startScriptedServe } from './scripted-serve.js';
import type { ScriptedServe } from './scripted-serve.js';

let serve: ScriptedServe | undefined;

afterEach(async () => {
  await serve?.close();
  serve = undefined;
});

const TURNS = [{ content: '好' }] as const;

describe('thread 數上限，從 serve 組裝起（#1476 驗收 F）', () => {
  it('設成 1：第一條照常跑一輪，第二條新 thread 被拒，回專用碼；起動日誌印出上限', async () => {
    const lines: string[] = [];
    serve = await startScriptedServe(TURNS, {
      extraRows: '- id: thread-capacity\n  config:\n    maxThreads: 1\n',
      log: (line) => lines.push(line),
    });
    expect(lines.filter((line) => line.startsWith('thread 上限：'))).toEqual([
      expect.stringContaining('thread 上限：1（'),
    ]);

    const client = await serveClient(serve.running);
    const events = await client.openEvents('t1');
    expect((await client.runStart('t1', '說一句')).type).toBe('success');
    expect(JSON.stringify(await foldTurn(events))).toContain('好');
    await events.return?.(undefined);

    // 第二條：直接送 run.start（會為它新建），回專用碼而不是「建不起來」。
    const refused = await client.runStart('t2', '說一句');
    expect(refused).toMatchObject({ type: 'error', error: 'thread_at_capacity' });
    expect(refused.type === 'error' ? refused.message : '').toContain('1／1');
    // 拒收那一行到了 serve 日誌（不是只有單元測試裡的 `warn` 回呼）：含 thread、目前數量與上限。
    expect(lines.filter((line) => line.startsWith('[thread 上限]'))).toEqual([
      expect.stringMatching(/"t2".*已有 1 條.*上限 1/u),
    ]);
    // 下行也一樣開不起來。
    await expect(client.openEvents('t2')).rejects.toThrow(/上限/u);
    // 已在行程裡的那條照常。
    const again = await client.openEvents('t1');
    await again.return?.(undefined);
  });

  it('下行被拒帶得上碼：真生產者（#1481 驗收 A、B）', async () => {
    serve = await startScriptedServe(TURNS, {
      extraRows: '- id: thread-capacity\n  config:\n    maxThreads: 1\n',
    });
    const client = await serveClient(serve.running);
    const first = await client.openEvents('t1');
    await first.return?.(undefined);

    // A：滿了。server 回 200 ＋ error 封包，client 丟型別錯誤，碼進得來；message 同 #1476 的斷言（`/上限/u`）。
    const refused: unknown = await client.openEvents('t2').then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(refused).toBeInstanceOf(WireRejectedError);
    const full = refused as WireRejectedError;
    expect(full.code).toBe(THREAD_AT_CAPACITY);
    expect(full.serverMessage).toContain('1／1');
    // `serverMessage` 是封包裡的 `message` 欄位，不是整包 body。
    expect(full.serverMessage).not.toContain(THREAD_AT_CAPACITY);
    expect(full.message).toMatch(/^下行被拒：\{.*thread_at_capacity.*\}$/u);
    expect(full.message).toContain(full.serverMessage);

    // B：別的碼也帶得上來。`channels` 空陣列是 server 真的會拒的請求（`invalid_argument`），而且在 thread 檢查之前，
    // 所以對已在行程裡的 t1 也是這個碼，不是 `thread_at_capacity`。
    const invalid: unknown = await client.openEvents('t1', { channels: [] }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(invalid).toBeInstanceOf(WireRejectedError);
    expect((invalid as WireRejectedError).code).toBe('invalid_argument');
  });

  it('沒有這一列的設定（出廠）：不限，起動日誌講「不限」', async () => {
    const lines: string[] = [];
    serve = await startScriptedServe(TURNS, { log: (line) => lines.push(line) });
    expect(lines).toContain('thread 上限：不限');
    const client = await serveClient(serve.running);
    for (const thread of ['a', 'b', 'c']) {
      const events = await client.openEvents(thread);
      await events.return?.(undefined);
    }
  });
});

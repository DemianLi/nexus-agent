/**
 * thread 數上限走完**serve 的組裝**（[#1476](https://github.com/DemianLi/nexus-agent/issues/1476)，驗收 F）。
 *
 * `thread-capacity.test.ts` 直接把 `maxThreads` 傳給 wire handler，量的是計數語意；那種測法拿掉 `serve.ts` 把設定交給
 * handler 的那一行也照樣綠。這一檔從 `runServe` 起——出貨清單加一份把 `thread-capacity` 設成 1 的 patch——
 * 量「設定列 → `startupSetting` → `createWireHandler` → `threadFor`」整條線，並看起動日誌印出上限。
 *
 * 後半是出廠打開（[#1619](https://github.com/DemianLi/nexus-agent/issues/1619)）的驗收 A、B、C、D：出廠值、只寫一格不丟另一格、
 * `idleEvictAfterMs: 0` 不逐出、這一列關不掉。E（沒落盤）在 `serve-idle-eviction.test.ts`。
 *
 * **零憑證、零外部連線**：模型是腳本。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { THREAD_AT_CAPACITY, WireRejectedError } from '@nexus/wire';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { foldTurn, serveClient } from './fixtures.js';
import { scriptedPatchText, startScriptedServe } from './scripted-serve.js';
import type { ScriptedServe } from './scripted-serve.js';
import { runServe } from './serve.js';

let serve: ScriptedServe | undefined;
const temporary: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await serve?.close();
  serve = undefined;
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
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
});

/** 起動日誌裡講上限與逐出的那兩行。 */
function capacityLines(lines: readonly string[]): string[] {
  return lines.filter(
    (line) => line.startsWith('thread 上限：') || line.startsWith('thread 閒置逐出：'),
  );
}

const SHIPPED_EVICT_LINE = expect.stringMatching(
  /^thread 閒置逐出：閒置 7200000 毫秒後撤出記憶體/u,
);

describe('出廠打開（#1619）', () => {
  it('A 出廠值：不帶 patch 改這一列，起動日誌印上限 500 與閒置 7200000 毫秒後撤出', async () => {
    const lines: string[] = [];
    serve = await startScriptedServe(TURNS, { log: (line) => lines.push(line) });
    // 前提：這台有落盤（逐出只在落盤時生效），不然下面那行是「沒有落盤」那一支。
    expect(lines.some((line) => line.startsWith('會話日誌：'))).toBe(true);
    expect(capacityLines(lines)).toEqual([
      'thread 上限：500（到了拒收新 thread，閒置的 thread 被撤掉才釋放名額）',
      SHIPPED_EVICT_LINE,
    ]);
  });

  it('B 只寫 maxThreads：逐出仍是出廠的 2 小時', async () => {
    const lines: string[] = [];
    serve = await startScriptedServe(TURNS, {
      extraRows: '- id: thread-capacity\n  config:\n    maxThreads: 1000\n',
      log: (line) => lines.push(line),
    });
    expect(capacityLines(lines)).toEqual([
      expect.stringMatching(/^thread 上限：1000（/u),
      SHIPPED_EVICT_LINE,
    ]);
  });

  it('B 只寫 idleEvictAfterMs：上限仍是出廠的 500', async () => {
    const lines: string[] = [];
    serve = await startScriptedServe(TURNS, {
      extraRows: '- id: thread-capacity\n  config:\n    idleEvictAfterMs: 600000\n',
      log: (line) => lines.push(line),
    });
    expect(capacityLines(lines)).toEqual([
      expect.stringMatching(/^thread 上限：500（/u),
      expect.stringMatching(/^thread 閒置逐出：閒置 600000 毫秒後撤出記憶體/u),
    ]);
  });

  /**
   * **0 不能原樣傳給 handler**：handler 收到 `idleEvictMs: 0` 會以 1 秒輪詢、把每條閒著的 thread 在下一次掃描就撤掉。
   * 所以這條真的放掉一條 thread 再等兩次以上的輪詢：拿掉 `serve.ts` 對 0 的處理，它就被撤、這條紅。
   * `setInterval` 只當輔助證據（`wire-server.ts` 的心跳也用它，間隔 2000）：出廠那台建了 30000 的那一顆，設 0 的這台沒有。
   */
  it('C idleEvictAfterMs: 0：起動日誌說不逐出、沒建掃描計時器，閒著的 thread 真的留著', async () => {
    const intervals = vi.spyOn(globalThis, 'setInterval');
    const lines: string[] = [];
    serve = await startScriptedServe(TURNS, {
      extraRows: '- id: thread-capacity\n  config:\n    idleEvictAfterMs: 0\n',
      log: (line) => lines.push(line),
    });
    // 前提：有落盤，否則「不逐出」是沒落盤那一支給的，這條就是空的。
    expect(lines.some((line) => line.startsWith('會話日誌：'))).toBe(true);
    expect(capacityLines(lines)).toEqual([
      'thread 上限：500（到了拒收新 thread，要重啟 serve 才釋放）',
      'thread 閒置逐出：idleEvictAfterMs 是 0，不逐出',
    ]);
    const delays = intervals.mock.calls.map((call) => call[1]);
    expect(delays).not.toContain(1000);
    expect(delays).not.toContain(30_000);

    const client = await serveClient(serve.running);
    // 下行要真的斷：`events.return()` 只放掉 reader、不關連線，訂閱者還掛著的話這條 thread 本來就不會被撤，測試就是空的。
    const controller = new AbortController();
    const events = await client.openEvents('t1', { signal: controller.signal });
    expect((await client.runStart('t1', '說一句')).type).toBe('success');
    await foldTurn(events);
    controller.abort();
    await events.return?.(undefined).catch(() => undefined);
    // 0 原樣傳下去的話輪詢是 1 秒：等兩次以上，真的有在掃的話早就撤了。
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(lines.some((line) => line.startsWith('[閒置逐出]'))).toBe(false);
  });

  it('C 的對照：出廠那台建了 30000 毫秒的掃描計時器', async () => {
    const intervals = vi.spyOn(globalThis, 'setInterval');
    serve = await startScriptedServe(TURNS);
    expect(intervals.mock.calls.map((call) => call[1])).toContain(30_000);
  });

  /** 起動失敗的那幾條：不經 `startScriptedServe`，自己收暫存目錄（它在 `runServe` 拋了之後不會收）。 */
  async function startFails(extraRows: string): Promise<unknown> {
    const dir = await mkdtemp(join(tmpdir(), 'nexus-thread-capacity-'));
    temporary.push(dir);
    const patch = join(dir, 'scripted.patch.yml');
    await writeFile(patch, scriptedPatchText(TURNS, extraRows), 'utf8');
    return runServe({
      argv: ['--port', '0', '--patch', patch],
      log: () => undefined,
      env: {},
    }).then(
      async (running) => {
        await (running as { close(): Promise<void> }).close();
        return undefined;
      },
      (error: unknown) => error,
    );
  }

  it('D 關不掉：disabled: true 起動當場拋，訊息說要放寬就調大', async () => {
    const error = await startFails('- id: thread-capacity\n  disabled: true\n');
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('關不掉');
    expect((error as Error).message).toContain('要放寬，把數值調大');
  });

  /**
   * **壞設定照既有的規則掉列**（#751）：設定驗不過的列標成沒掛、啟動警告指名它，其餘照樣起來。這一列不在必掛名單上，
   * 掉了之後 `startupSetting` 回到 schema 預設——所以 0 換不到「不限」，保險絲照樣是出廠那一組。
   */
  /**
   * 壞設定回到預設、不拒絕啟動（PM 2026-10-18 定案）。三件事都要斷言：警告有印、生效的上限是 500、`thread_at_capacity` 真的在第 501 條觸發
   * ——只看日誌那一行的話，「印的是 500、handler 拿到的卻不是」照樣綠。
   */
  it('D maxThreads: 0 被 schema 擋下（沒有「不限」）：這一列掉了、警告指名它，第 501 條照樣被拒', async () => {
    const lines: string[] = [];
    serve = await startScriptedServe(TURNS, {
      extraRows: '- id: thread-capacity\n  config:\n    maxThreads: 0\n',
      log: (line) => lines.push(line),
    });
    expect(lines).toContainEqual(expect.stringMatching(/thread-capacity.*設定驗不過.*maxThreads/u));
    expect(capacityLines(lines)).toEqual([
      expect.stringMatching(/^thread 上限：500（/u),
      SHIPPED_EVICT_LINE,
    ]);

    const client = await serveClient(serve.running);
    const open = async (thread: string): Promise<void> => {
      const events = await client.openEvents(thread);
      await events.return?.(undefined);
    };
    // 一批 25 條並行開，500 條佔滿名額。
    for (let batch = 0; batch < 20; batch += 1) {
      await Promise.all(
        Array.from({ length: 25 }, (_, index) => open(`t${String(batch * 25 + index)}`)),
      );
    }
    const refused = await client.runStart('t500', '說一句');
    expect(refused).toMatchObject({ type: 'error', error: 'thread_at_capacity' });
    expect(refused.type === 'error' ? refused.message : '').toContain('500／500');
  }, 120_000);
});

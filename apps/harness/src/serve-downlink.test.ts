/**
 * 下行串流的心跳間隔與位元組上限走完**serve 的組裝**（[#1504](https://github.com/DemianLi/nexus-agent/issues/1504)，驗收 6）。
 *
 * `wire-server-downlink.test.ts`、`thread-pump-bounds.test.ts` 直接把選項傳給 `startWireServer`／`ThreadPump`，量的是機制本身；
 * 那種測法拿掉 `serve.ts` 把設定交出去的那幾行也照樣綠，而這一張卡有**兩個**消費點、在 serve 裡是兩行不同的接線：
 * 心跳間隔交給 `startWireServer`、位元組上限交給 `createWireHandler`。這一檔從 `runServe` 起——出貨清單加一份調過 `downlink` 的 patch——
 * 各量一條：
 *
 * - **心跳間隔**：調短的間隔真的是那條線上 `: ping` 的節奏（拿掉 `heartbeatIntervalMs` 那一行，預設 2 秒，這個窗口裡一個都收不到）。
 * - **位元組上限**：調到比任何一顆 frame 都小，下行第一顆就超限、被斷，serve 日誌有那一行（拿掉 `downlinkMaxBytes` 那一行，預設 2 MiB，下行好好跑完）。
 * - **斷線 warn 走 serverLog、不借 400 的那條**：檢 `serve.ts` 的接線文字（斷線要真的卡住才看得到，造不出來）。
 *
 * **零憑證、零外部連線**：模型是腳本。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createWireClient } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';

import { exchangeServeToken, fetchWithCookie, foldTurn } from './fixtures.js';
import { startScriptedServe } from './scripted-serve.js';
import type { ScriptedServe } from './scripted-serve.js';

let serve: ScriptedServe | undefined;

afterEach(async () => {
  await serve?.close();
  serve = undefined;
});

const TURNS = [{ content: '好' }] as const;

describe('下行串流設定，從 serve 組裝起（#1504 驗收 6）', () => {
  it('心跳間隔：調到 30 毫秒，閒著的下行線在 600 毫秒內收到至少 8 個 `: ping`', async () => {
    serve = await startScriptedServe(TURNS, {
      extraRows: '- id: downlink\n  config:\n    heartbeatIntervalMs: 30\n',
    });
    const cookie = await exchangeServeToken(serve.running.authenticatedUrl);
    let raw = '';
    const reading: Promise<void>[] = [];
    const client = createWireClient({
      baseUrl: serve.running.url,
      fetch: async (input, init) => {
        const response = await fetchWithCookie(cookie)(input, init);
        const [copy, rest] = (response.body as ReadableStream<Uint8Array>).tee();
        reading.push(
          (async () => {
            const reader = copy.getReader();
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) return;
                raw += new TextDecoder().decode(value);
              }
            } catch {
              // 測試結束時中止。
            }
          })(),
        );
        return new Response(rest, response);
      },
    });
    const line = new AbortController();
    const events = await client.openEvents('t1', { signal: line.signal });
    const draining = (async () => {
      try {
        for await (const _event of events) void _event;
      } catch {
        // 同上。
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 600));
    line.abort();
    await Promise.all([draining, ...reading]);
    expect(raw.match(/: ping/gu)?.length ?? 0).toBeGreaterThanOrEqual(8);
  });

  it('位元組上限：調到 150，下行第一顆就超限被斷，serve 日誌有那一行；一顆事件都不缺的前提不成立', async () => {
    const lines: string[] = [];
    serve = await startScriptedServe(TURNS, {
      extraRows: '- id: downlink\n  config:\n    maxQueuedBytes: 150\n',
      log: (line) => lines.push(line),
    });
    const cookie = await exchangeServeToken(serve.running.authenticatedUrl);
    const client = createWireClient({
      baseUrl: serve.running.url,
      fetch: fetchWithCookie(cookie),
    });
    const events = await client.openEvents('t1');
    expect((await client.runStart('t1', '說一句')).type).toBe('success');
    // 下行在這一輪收尾之前就被斷了：折不到收尾那顆。
    await expect(foldTurn(events)).rejects.toThrow();
    expect(lines.filter((line) => line.includes('積壓超過 150 位元組'))).toEqual([
      expect.stringContaining('thread t1'),
    ]);
  });

  it('serve.ts 把兩個值交到各自的消費點，斷線的 warn 走 serverLog、不借「處理失敗，回 400」那一條', () => {
    const source = readFileSync(join(import.meta.dirname, 'serve.ts'), 'utf8');
    expect(source).toContain('downlinkMaxBytes: downlink.maxQueuedBytes');
    expect(source).toContain('heartbeatIntervalMs: downlink.heartbeatIntervalMs');
    expect(source).toContain('warnDisconnect: serverLog');
  });
});

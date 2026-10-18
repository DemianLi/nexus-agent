/**
 * 記憶體量具走完**serve 的組裝**（[#1490](https://github.com/DemianLi/nexus-agent/issues/1490) 驗收 B、C）。
 *
 * `memory-gauge.test.ts` 直接呼叫 `startMemoryGauge`，量的是量具本身；那種測法拿掉 `serve.ts` 把設定交給量具的那一行也照樣綠。
 * 這一檔從 `runServe` 起——出貨清單加一份把 `memory-gauge` 打開的 patch——量「設定列 → `startupSetting` → `startMemoryGauge` → serve 日誌」
 * 整條線，並看 `close()` 真的把計時器收掉。
 *
 * **零憑證、零外部連線**：模型是腳本。
 */

import { afterEach, describe, expect, it } from 'vitest';

import { startScriptedServe } from './scripted-serve.js';
import type { ScriptedServe } from './scripted-serve.js';

let serve: ScriptedServe | undefined;

afterEach(async () => {
  await serve?.close();
  serve = undefined;
});

const TURNS = [{ content: '好' }] as const;
const GAUGE_LINE = /^記憶體：行程 RSS /u;

/** 等到 `predicate` 成立，最多等 `ms`。 */
async function until(predicate: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('記憶體量具，從 serve 組裝起（#1490 驗收 B、C）', () => {
  it('出廠（預設關閉）：日誌裡一行記憶體都沒有，過了一段時間也沒有', async () => {
    const lines: string[] = [];
    serve = await startScriptedServe(TURNS, { log: (line) => lines.push(line) });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(lines.filter((line) => GAUGE_LINE.test(line))).toEqual([]);
  });

  it('打開：起動就有一行，之後每個間隔一行，三個來源都寫在行上', async () => {
    const lines: string[] = [];
    serve = await startScriptedServe(TURNS, {
      extraRows: '- id: memory-gauge\n  config:\n    reportIntervalMs: 1000\n',
      log: (line) => lines.push(line),
    });
    await until(() => lines.filter((line) => GAUGE_LINE.test(line)).length >= 2, 4000);
    const gauge = lines.filter((line) => GAUGE_LINE.test(line));
    expect(gauge.length).toBeGreaterThanOrEqual(2);
    for (const line of gauge) {
      expect(line).toMatch(/heap .*MiB.*cgroup .*主機/u);
    }
    // 起動那一行排在其他起動披露之後，不夾在中間。
    const index = lines.findIndex((line) => GAUGE_LINE.test(line));
    expect(lines.slice(0, index).some((line) => line.startsWith('thread 上限：'))).toBe(true);
  });

  it('close() 之後計時器收掉：不再有新的一行', async () => {
    const lines: string[] = [];
    serve = await startScriptedServe(TURNS, {
      extraRows: '- id: memory-gauge\n  config:\n    reportIntervalMs: 1000\n',
      log: (line) => lines.push(line),
    });
    await until(() => lines.some((line) => GAUGE_LINE.test(line)));
    await serve.close();
    serve = undefined;
    const countAtClose = lines.filter((line) => GAUGE_LINE.test(line)).length;
    await new Promise((resolve) => setTimeout(resolve, 2300));
    expect(lines.filter((line) => GAUGE_LINE.test(line))).toHaveLength(countAtClose);
  });

  it('間隔寫 500（低於下限）：那一列在載入期被丟掉（#751），量具不啟動，日誌講出來是哪一列', async () => {
    const lines: string[] = [];
    serve = await startScriptedServe(TURNS, {
      extraRows: '- id: memory-gauge\n  config:\n    reportIntervalMs: 500\n',
      log: (line) => lines.push(line),
    });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(lines.filter((line) => GAUGE_LINE.test(line))).toEqual([]);
    expect(lines.some((line) => line.includes('memory-gauge') && line.includes('設定驗不過'))).toBe(
      true,
    );
  });
});

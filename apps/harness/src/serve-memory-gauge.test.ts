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

import { bodyLog, foldTurn, serveClient } from './fixtures.js';
import type { MemoryGaugeDeps } from './memory-gauge.js';
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
    serve = await startScriptedServe(TURNS, { log: bodyLog(lines) });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(lines.filter((line) => GAUGE_LINE.test(line))).toEqual([]);
  });

  it('打開：起動就有一行，之後每個間隔一行，三個來源都寫在行上', async () => {
    const lines: string[] = [];
    serve = await startScriptedServe(TURNS, {
      extraRows: '- id: memory-gauge\n  config:\n    reportIntervalMs: 1000\n',
      log: bodyLog(lines),
    });
    await until(() => lines.filter((line) => GAUGE_LINE.test(line)).length >= 2, 4000);
    const gauge = lines.filter((line) => GAUGE_LINE.test(line));
    expect(gauge.length).toBeGreaterThanOrEqual(2);
    for (const line of gauge) {
      expect(line).toMatch(/heap .*MiB.*cgroup .*主機/u);
    }
    // 起動那一行排在**所有**起動披露之後、不夾在中間：緊接在最後一條披露（已儲存 vs 執行中的對照，`serve.ts` 披露段的最後一行）後面。
    const index = lines.findIndex((line) => GAUGE_LINE.test(line));
    const lastDisclosure = lines.findIndex((line) => line.startsWith('[對照快照]'));
    expect(lastDisclosure).toBeGreaterThanOrEqual(0);
    expect(index).toBe(lastDisclosure + 1);
  });

  it('close() 之後計時器收掉：不再有新的一行', async () => {
    const lines: string[] = [];
    serve = await startScriptedServe(TURNS, {
      extraRows: '- id: memory-gauge\n  config:\n    reportIntervalMs: 1000\n',
      log: bodyLog(lines),
    });
    await until(() => lines.some((line) => GAUGE_LINE.test(line)));
    await serve.close();
    serve = undefined;
    const countAtClose = lines.filter((line) => GAUGE_LINE.test(line)).length;
    // 量具真的起過：沒起的話下面的「不再增加」是空話（拿掉起量具那段時，會紅在這一行而不是逾時）。
    expect(countAtClose).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 2300));
    expect(lines.filter((line) => GAUGE_LINE.test(line))).toHaveLength(countAtClose);
  });

  it('間隔寫 500（低於下限）：那一列在載入期被丟掉（#751），量具不啟動，日誌講出來是哪一列', async () => {
    const lines: string[] = [];
    serve = await startScriptedServe(TURNS, {
      extraRows: '- id: memory-gauge\n  config:\n    reportIntervalMs: 500\n',
      log: bodyLog(lines),
    });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(lines.filter((line) => GAUGE_LINE.test(line))).toEqual([]);
    expect(lines.some((line) => line.includes('memory-gauge') && line.includes('設定驗不過'))).toBe(
      true,
    );
  });
});

const MIB = 1024 * 1024;

/**
 * 假的 cgroup v2（私有 cgroupns，路徑 `/`）：上限 1000 MiB，用量由 `usedPercent()` 決定，每次讀取當下才取值。
 * 行程的 V8 heap 上限也是 1000 MiB，已用由 `heapPercent()` 決定（預設 4%，不影響 cgroup 的測試）。
 */
function fakeCgroup(
  usedPercent: () => number,
  heapPercent: () => number = () => 4,
): MemoryGaugeDeps {
  const files: Record<string, () => string> = {
    '/proc/self/cgroup': () => '0::/\n',
    '/sys/fs/cgroup/memory.current': () => String(Math.round(usedPercent() * 10 * MIB)),
    '/sys/fs/cgroup/memory.max': () => String(1000 * MIB),
  };
  return {
    readText: (path) => {
      const content = files[path];
      return content === undefined
        ? Promise.reject(Object.assign(new Error(`no ${path}`), { code: 'ENOENT' }))
        : Promise.resolve(content());
    },
    processMemory: () => ({
      rssBytes: 100 * MIB,
      heapUsedBytes: Math.round(heapPercent() * 10 * MIB),
      heapTotalBytes: 60 * MIB,
      heapLimitBytes: 1000 * MIB,
    }),
    freemem: () => 8192 * MIB,
    totalmem: () => 16384 * MIB,
    constrainedMemory: () => 0,
  };
}

const WARNING = /^\[記憶體\] 警告：/u;
const RECOVERED = /^\[記憶體\] 已恢復：/u;

describe('記憶體用量警告，從 serve 組裝起（#1493 驗收 C、F）', () => {
  it('取樣關著（出廠）：就算讀數是 99%，日誌裡沒有任何 [記憶體] 行（驗收 C）', async () => {
    const lines: string[] = [];
    serve = await startScriptedServe(TURNS, {
      memoryGaugeDeps: fakeCgroup(() => 99),
      log: bodyLog(lines),
    });
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(lines.filter((line) => line.startsWith('[記憶體]') || GAUGE_LINE.test(line))).toEqual(
      [],
    );
  });

  it('取樣開著、門檻預設 75：70% → 80% → 69% → 80%，警告、已恢復、再警告；警告帶現在的 thread 數與上限（驗收 F）', async () => {
    let used = 70;
    const lines: string[] = [];
    serve = await startScriptedServe(TURNS, {
      extraRows: '- id: memory-gauge\n  config:\n    reportIntervalMs: 1000\n',
      memoryGaugeDeps: fakeCgroup(() => used),
      log: bodyLog(lines),
    });
    const count = (pattern: RegExp): number => lines.filter((line) => pattern.test(line)).length;
    // 真的開一條 thread：警告裡的「現在幾條」要是 handler 的數，不是寫死的。
    const client = await serveClient(serve.running);
    const events = await client.openEvents('t1');
    expect((await client.runStart('t1', '說一句')).type).toBe('success');
    await foldTurn(events);
    await events.return?.(undefined);

    await until(() => count(GAUGE_LINE) >= 1);
    expect(count(WARNING)).toBe(0);
    used = 80;
    await until(() => count(WARNING) >= 1);
    const warning = lines.find((line) => WARNING.test(line)) ?? '';
    expect(warning).toContain('cgroup v2 /');
    expect(warning).toContain('80.0%');
    expect(warning).toContain('門檻 75%');
    expect(warning).toContain('1 條 thread（上限 500）');
    // 保持 80%：再過兩個取樣也不重複。
    const seen = count(GAUGE_LINE);
    await until(() => count(GAUGE_LINE) >= seen + 2, 4000);
    expect(count(WARNING)).toBe(1);
    used = 69;
    await until(() => count(RECOVERED) >= 1);
    used = 80;
    await until(() => count(WARNING) >= 2);
    expect(count(WARNING)).toBe(2);
    expect(count(RECOVERED)).toBe(1);
  }, 20_000);

  it('cgroup 60%、heap 90%：serve 真的把 heap 來源掛上，警告寫明是 V8 heap；恢復也是 heap（#1718）', async () => {
    let heap = 90;
    const lines: string[] = [];
    serve = await startScriptedServe(TURNS, {
      extraRows: '- id: memory-gauge\n  config:\n    reportIntervalMs: 1000\n',
      memoryGaugeDeps: fakeCgroup(
        () => 60,
        () => heap,
      ),
      log: bodyLog(lines),
    });
    await until(() => lines.some((line) => WARNING.test(line)));
    const warnings = lines.filter((line) => WARNING.test(line));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('V8 heap 用量（V8 heap_size_limit）90.0%');
    expect(warnings[0]).toContain('門檻 75%');
    expect(warnings[0]).not.toContain('cgroup');
    heap = 50;
    await until(() => lines.some((line) => RECOVERED.test(line)));
    const recovered = lines.filter((line) => RECOVERED.test(line));
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toContain('V8 heap 用量');
    expect(lines.filter((line) => WARNING.test(line))).toHaveLength(1);
  }, 20_000);

  it('用量警告是 warn 等級、讀數那一行是 info（#1534）：門檻調到 warn 的主機不會丟掉警告', async () => {
    const raw: string[] = [];
    serve = await startScriptedServe(TURNS, {
      extraRows:
        '- id: memory-gauge\n  config:\n    reportIntervalMs: 1000\n- id: logger-console\n  config:\n    levels:\n      default: warn\n',
      memoryGaugeDeps: fakeCgroup(() => 80),
      log: (line) => raw.push(line),
    });
    await until(() => raw.some((line) => line.includes('[記憶體] 警告：')));
    const warning = raw.find((line) => line.includes('[記憶體] 警告：')) ?? '';
    expect(warning).toMatch(/\[W\] serve \[記憶體\] 警告：/u);
    // 讀數那一行是 info：門檻 warn 時一行都不會出現。
    expect(raw.filter((line) => /記憶體：/u.test(line) && !line.includes('警告'))).toEqual([]);
  }, 20_000);

  it('warnAtPercent 真的是 serve 傳進去的那個值：門檻 50，60% 就警告（拿掉傳門檻那行會紅）', async () => {
    const lines: string[] = [];
    serve = await startScriptedServe(TURNS, {
      extraRows:
        '- id: memory-gauge\n  config:\n    reportIntervalMs: 1000\n    warnAtPercent: 50\n',
      memoryGaugeDeps: fakeCgroup(() => 60),
      log: bodyLog(lines),
    });
    await until(() => lines.some((line) => WARNING.test(line)));
    expect(lines.find((line) => WARNING.test(line))).toContain('門檻 50%');
  });

  it('門檻寫 100（超出範圍）：那一列在載入期被丟掉，量具不啟動，日誌講出來是哪一列', async () => {
    const lines: string[] = [];
    serve = await startScriptedServe(TURNS, {
      extraRows:
        '- id: memory-gauge\n  config:\n    reportIntervalMs: 1000\n    warnAtPercent: 100\n',
      memoryGaugeDeps: fakeCgroup(() => 99),
      log: bodyLog(lines),
    });
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(lines.filter((line) => GAUGE_LINE.test(line) || WARNING.test(line))).toEqual([]);
    expect(lines.some((line) => line.includes('memory-gauge') && line.includes('設定驗不過'))).toBe(
      true,
    );
  });

  it('macOS 形狀（沒有 cgroup、沒有 /proc/meminfo，只有 os.freemem 且顯示 99% 用掉）：不警告，只講一次讀不到', async () => {
    const lines: string[] = [];
    serve = await startScriptedServe(TURNS, {
      extraRows: '- id: memory-gauge\n  config:\n    reportIntervalMs: 1000\n',
      memoryGaugeDeps: {
        ...fakeCgroup(() => 50),
        readText: () => Promise.reject(Object.assign(new Error('nope'), { code: 'ENOENT' })),
        freemem: () => 100 * MIB,
        totalmem: () => 16384 * MIB,
      },
      log: bodyLog(lines),
    });
    await until(() => lines.filter((line) => GAUGE_LINE.test(line)).length >= 3, 5000);
    expect(lines.filter((line) => WARNING.test(line))).toEqual([]);
    const unreadable = lines.filter((line) => /^\[記憶體\] 記憶體用量讀不到/u.test(line));
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0]).toContain('os.freemem');
  }, 15_000);

  it('讀不到（沒有 cgroup、主機也讀不到）：只講一次讀不到，沒有警告（驗收 D）', async () => {
    const lines: string[] = [];
    const base = fakeCgroup(() => 99);
    serve = await startScriptedServe(TURNS, {
      extraRows: '- id: memory-gauge\n  config:\n    reportIntervalMs: 1000\n',
      memoryGaugeDeps: {
        ...base,
        readText: () => Promise.reject(Object.assign(new Error('nope'), { code: 'ENOENT' })),
        freemem: () => {
          throw new Error('freemem 壞了');
        },
      },
      log: bodyLog(lines),
    });
    await until(() => lines.filter((line) => GAUGE_LINE.test(line)).length >= 3, 5000);
    expect(lines.filter((line) => WARNING.test(line))).toEqual([]);
    expect(lines.filter((line) => /^\[記憶體\] 記憶體用量讀不到/u.test(line))).toHaveLength(1);
  }, 15_000);
});

/**
 * 記憶體量具（[#1490](https://github.com/DemianLi/nexus-agent/issues/1490)）的單元測試：三個來源各自讀、讀不到明說、
 * 一行日誌的形狀、計時器的行為。接線（serve 真的起量具）在 `serve-memory-gauge.test.ts`。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { formatMemoryLine, readMemory, startMemoryGauge } from './memory-gauge.js';
import type { MemoryGaugeDeps } from './memory-gauge.js';

const MIB = 1024 * 1024;

/** 假檔案系統：缺的路徑丟 ENOENT。 */
function files(table: Record<string, string>): MemoryGaugeDeps['readText'] {
  return (path) => {
    const content = table[path];
    if (content === undefined) {
      return Promise.reject(Object.assign(new Error(`no ${path}`), { code: 'ENOENT' }));
    }
    return Promise.resolve(content);
  };
}

function deps(
  table: Record<string, string>,
  overrides: Partial<MemoryGaugeDeps> = {},
): MemoryGaugeDeps {
  return {
    readText: files(table),
    processMemory: () => ({
      rssBytes: 100 * MIB,
      heapUsedBytes: 40 * MIB,
      heapTotalBytes: 60 * MIB,
    }),
    freemem: () => 2048 * MIB,
    totalmem: () => 8192 * MIB,
    ...overrides,
  };
}

const MEMINFO =
  'MemTotal:       16384000 kB\nMemFree:         1000000 kB\nMemAvailable:    8192000 kB\n';

afterEach(() => {
  vi.useRealTimers();
});

describe('cgroup', () => {
  it('v2：讀 memory.current 與 memory.max', async () => {
    const reading = await readMemory(
      deps({
        '/sys/fs/cgroup/memory.current': `${String(512 * MIB)}\n`,
        '/sys/fs/cgroup/memory.max': `${String(4096 * MIB)}\n`,
      }),
    );
    expect(reading.cgroup).toEqual({
      ok: true,
      version: 2,
      currentBytes: 512 * MIB,
      limitBytes: 4096 * MIB,
    });
  });

  it('v2 的 max＝沒設上限：讀到了，limitBytes 是 null，不是 0 也不是讀不到', async () => {
    const reading = await readMemory(
      deps({
        '/sys/fs/cgroup/memory.current': '1048576\n',
        '/sys/fs/cgroup/memory.max': 'max\n',
      }),
    );
    expect(reading.cgroup).toEqual({
      ok: true,
      version: 2,
      currentBytes: 1048576,
      limitBytes: null,
    });
  });

  it('v1：讀 usage／limit；大到不合理的 limit 是沒設上限', async () => {
    const limited = await readMemory(
      deps({
        '/sys/fs/cgroup/memory/memory.usage_in_bytes': String(256 * MIB),
        '/sys/fs/cgroup/memory/memory.limit_in_bytes': String(1024 * MIB),
      }),
    );
    expect(limited.cgroup).toEqual({
      ok: true,
      version: 1,
      currentBytes: 256 * MIB,
      limitBytes: 1024 * MIB,
    });
    const unlimited = await readMemory(
      deps({
        '/sys/fs/cgroup/memory/memory.usage_in_bytes': '1000',
        '/sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712',
      }),
    );
    expect(unlimited.cgroup).toEqual({
      ok: true,
      version: 1,
      currentBytes: 1000,
      limitBytes: null,
    });
  });

  it('兩種都沒有（macOS）：讀不到，原因寫出兩邊都試過，不回 0', async () => {
    const reading = await readMemory(deps({}));
    expect(reading.cgroup.ok).toBe(false);
    if (!reading.cgroup.ok) {
      expect(reading.cgroup.reason).toContain('v2');
      expect(reading.cgroup.reason).toContain('v1');
      expect(reading.cgroup.reason).toContain('ENOENT');
    }
  });

  it('內容不是整數：讀不到，不是 NaN 也不是 0', async () => {
    const reading = await readMemory(
      deps({
        '/sys/fs/cgroup/memory.current': 'abc',
        '/sys/fs/cgroup/memory.max': 'max',
      }),
    );
    expect(reading.cgroup.ok).toBe(false);
  });

  it('memory.current 讀到了但 memory.max 讀不到：整個 v2 算讀不到，原因點名 memory.max', async () => {
    const reading = await readMemory(deps({ '/sys/fs/cgroup/memory.current': '1000' }));
    expect(reading.cgroup.ok).toBe(false);
    if (!reading.cgroup.ok) expect(reading.cgroup.reason).toContain('memory.max');
  });
});

describe('主機', () => {
  it('有 /proc/meminfo：讀 MemAvailable 與 MemTotal，kB 換成位元組', async () => {
    const reading = await readMemory(deps({ '/proc/meminfo': MEMINFO }));
    expect(reading.host).toEqual({
      ok: true,
      source: 'MemAvailable',
      availableBytes: 8192000 * 1024,
      totalBytes: 16384000 * 1024,
    });
  });

  it('沒有 /proc/meminfo：退到 os.freemem()，並標出來源', async () => {
    const reading = await readMemory(deps({}));
    expect(reading.host).toEqual({
      ok: true,
      source: 'os.freemem',
      availableBytes: 2048 * MIB,
      totalBytes: 8192 * MIB,
    });
  });

  it('/proc/meminfo 在但沒有 MemAvailable（舊核心）：也退到 os.freemem()', async () => {
    const reading = await readMemory(
      deps({ '/proc/meminfo': 'MemTotal: 100 kB\nMemFree: 50 kB\n' }),
    );
    expect(reading.host.ok && reading.host.source).toBe('os.freemem');
  });

  it('os.freemem() 也丟：主機讀不到，附原因', async () => {
    const reading = await readMemory(
      deps(
        {},
        {
          freemem: () => {
            throw new Error('boom');
          },
        },
      ),
    );
    expect(reading.host).toEqual({ ok: false, reason: 'boom' });
  });
});

describe('一行日誌', () => {
  it('三個來源都讀到：全寫出來，單位 MiB', async () => {
    const line = formatMemoryLine(
      await readMemory(
        deps({
          '/sys/fs/cgroup/memory.current': String(512 * MIB),
          '/sys/fs/cgroup/memory.max': String(4096 * MIB),
          '/proc/meminfo': MEMINFO,
        }),
      ),
    );
    expect(line).toBe(
      '記憶體：行程 RSS 100.0 MiB、heap 40.0 MiB／60.0 MiB；cgroup v2 512.0 MiB／4096.0 MiB；主機可用 8000.0 MiB／16000.0 MiB（MemAvailable）',
    );
  });

  it('讀不到的來源寫「讀不到（原因）」，沒設上限寫「沒設上限」', async () => {
    const unreadable = formatMemoryLine(await readMemory(deps({})));
    expect(unreadable).toContain('cgroup 讀不到（');
    expect(unreadable).toContain('（os.freemem）');
    const unlimited = formatMemoryLine(
      await readMemory(
        deps({ '/sys/fs/cgroup/memory.current': String(MIB), '/sys/fs/cgroup/memory.max': 'max' }),
      ),
    );
    expect(unlimited).toContain('cgroup v2 1.0 MiB／沒設上限');
  });
});

describe('計時器', () => {
  it('起動立刻寫一行，之後每個間隔一行，stop 之後不再寫', async () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const gauge = startMemoryGauge({ intervalMs: 1000, log: (l) => lines.push(l), deps: deps({}) });
    await vi.advanceTimersByTimeAsync(0);
    expect(lines).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2500);
    expect(lines).toHaveLength(3);
    gauge.stop();
    gauge.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(lines).toHaveLength(3);
    expect(lines.every((line) => line.startsWith('記憶體：'))).toBe(true);
  });

  it('前一次還沒讀完不疊下一次', async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    let reads = 0;
    const slow: MemoryGaugeDeps = {
      ...deps({}),
      readText: () => {
        reads += 1;
        return new Promise<string>((_resolve, reject) => {
          release = () => reject(Object.assign(new Error('x'), { code: 'ENOENT' }));
        });
      },
    };
    const lines: string[] = [];
    const gauge = startMemoryGauge({ intervalMs: 1000, log: (l) => lines.push(l), deps: slow });
    await vi.advanceTimersByTimeAsync(3500);
    // 每次 readMemory 讀 cgroup（v2、v1 依序）與 /proc/meminfo；卡在第一個讀上，三個間隔過去也沒有第二輪。
    const readsWhileStuck = reads;
    expect(readsWhileStuck).toBeLessThanOrEqual(2);
    expect(lines).toHaveLength(0);
    gauge.stop();
    release?.();
  });

  it('log 拋了不連累 serve：下一個間隔照樣再試', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const gauge = startMemoryGauge({
      intervalMs: 1000,
      log: () => {
        calls += 1;
        throw new Error('disk full');
      },
      deps: deps({}),
    });
    await vi.advanceTimersByTimeAsync(2500);
    expect(calls).toBe(3);
    gauge.stop();
  });
});

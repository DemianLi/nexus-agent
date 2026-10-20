/**
 * 記憶體量具（[#1490](https://github.com/DemianLi/nexus-agent/issues/1490)）的單元測試：三個來源各自讀、讀不到明說、
 * 一行日誌的形狀、計時器的行為。接線（serve 真的起量具）在 `serve-memory-gauge.test.ts`。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { formatMemoryLine, readMemory, startMemoryGauge } from './memory-gauge.js';
import type { MemoryGaugeDeps } from './memory-gauge.js';

const MIB = 1024 * 1024;

/** 假檔案系統：缺的路徑丟 ENOENT；值是 `Error` 的路徑丟那個錯（模擬權限之類）。 */
function files(table: Record<string, string | Error>): MemoryGaugeDeps['readText'] {
  return (path) => {
    const content = table[path];
    if (content === undefined) {
      return Promise.reject(Object.assign(new Error(`no ${path}`), { code: 'ENOENT' }));
    }
    return content instanceof Error ? Promise.reject(content) : Promise.resolve(content);
  };
}

function deps(
  table: Record<string, string | Error>,
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
    constrainedMemory: () => 0,
    ...overrides,
  };
}

const MEMINFO =
  'MemTotal:       16384000 kB\nMemFree:         1000000 kB\nMemAvailable:    8192000 kB\n';

afterEach(() => {
  vi.useRealTimers();
});

/** v2 單一階層（docker 預設的私有 cgroupns）：路徑是 `/`。 */
const V2_ROOT = '0::/\n';
/** systemd 底下的 v2：行程在 `/system.slice/…`。 */
const V2_SYSTEMD = '0::/system.slice/nexus-agent.service\n';
/** v1：memory controller 在它自己那一行。 */
const V1_LINES =
  '12:cpu,cpuacct:/user.slice\n11:memory:/system.slice/nexus-agent.service\n1:name=systemd:/system.slice/nexus-agent.service\n';
/** hybrid：v1 的各行加上 v2 的 `0::`（v2 沒有掛 memory controller）。 */
const HYBRID = `${V1_LINES}0::/system.slice/nexus-agent.service\n`;

describe('cgroup（先解 /proc/self/cgroup，讀行程自己所在的那個）', () => {
  it('v2、根路徑（docker 私有 cgroupns）：讀 /sys/fs/cgroup/memory.current 與 memory.max', async () => {
    const reading = await readMemory(
      deps({
        '/proc/self/cgroup': V2_ROOT,
        '/sys/fs/cgroup/memory.current': `${String(512 * MIB)}\n`,
        '/sys/fs/cgroup/memory.max': `${String(4096 * MIB)}\n`,
      }),
    );
    expect(reading.cgroup).toEqual({
      ok: true,
      version: 2,
      path: '/',
      currentBytes: 512 * MIB,
      limitBytes: 4096 * MIB,
    });
  });

  it('v2、非根路徑（systemd 的 /system.slice/…）：讀那個路徑底下的檔，不是掛載根；根目錄的檔不會被讀', async () => {
    const reading = await readMemory(
      deps({
        '/proc/self/cgroup': V2_SYSTEMD,
        // 根目錄那份是整台機器：如果讀它，下面的斷言會抓到數字不對。
        '/sys/fs/cgroup/memory.current': String(99999 * MIB),
        '/sys/fs/cgroup/memory.max': 'max',
        '/sys/fs/cgroup/system.slice/nexus-agent.service/memory.current': `${String(300 * MIB)}\n`,
        '/sys/fs/cgroup/system.slice/nexus-agent.service/memory.max': `${String(2048 * MIB)}\n`,
      }),
    );
    expect(reading.cgroup).toEqual({
      ok: true,
      version: 2,
      path: '/system.slice/nexus-agent.service',
      currentBytes: 300 * MIB,
      limitBytes: 2048 * MIB,
    });
  });

  it('v2 的 max＝這個 cgroup 沒設上限：讀到了，limitBytes 是 null，不是 0 也不是讀不到', async () => {
    const reading = await readMemory(
      deps({
        '/proc/self/cgroup': V2_ROOT,
        '/sys/fs/cgroup/memory.current': '1048576\n',
        '/sys/fs/cgroup/memory.max': 'max\n',
      }),
    );
    expect(reading.cgroup).toEqual({
      ok: true,
      version: 2,
      path: '/',
      currentBytes: 1048576,
      limitBytes: null,
    });
  });

  it('沒設上限、但 process.constrainedMemory() 報了比主機小的限制（上限在祖先 cgroup）：多帶 constrainedBytes', async () => {
    const reading = await readMemory(
      deps(
        {
          '/proc/self/cgroup': V2_SYSTEMD,
          '/sys/fs/cgroup/system.slice/nexus-agent.service/memory.current': '1000',
          '/sys/fs/cgroup/system.slice/nexus-agent.service/memory.max': 'max',
        },
        { constrainedMemory: () => 1024 * MIB },
      ),
    );
    expect(reading.cgroup).toMatchObject({
      ok: true,
      limitBytes: null,
      constrainedBytes: 1024 * MIB,
    });
    expect(formatMemoryLine(reading)).toContain(
      '沒設上限（行程受限 1024.0 MiB，上限可能在上層 cgroup）',
    );
  });

  it('constrainedMemory 回 0（macOS）、undefined（舊 Node）、不小於主機、或丟錯：都不帶，也不印 0', async () => {
    for (const constrainedMemory of [
      () => 0,
      () => undefined,
      () => 8192 * MIB,
      () => Number.MAX_SAFE_INTEGER,
      () => {
        throw new Error('boom');
      },
    ]) {
      const reading = await readMemory(
        deps(
          {
            '/proc/self/cgroup': V2_ROOT,
            '/sys/fs/cgroup/memory.current': '1000',
            '/sys/fs/cgroup/memory.max': 'max',
          },
          { constrainedMemory },
        ),
      );
      expect(reading.cgroup).toEqual({
        ok: true,
        version: 2,
        path: '/',
        currentBytes: 1000,
        limitBytes: null,
      });
    }
  });

  it('這個 cgroup 自己設了上限：不看 constrainedMemory', async () => {
    const reading = await readMemory(
      deps(
        {
          '/proc/self/cgroup': V2_ROOT,
          '/sys/fs/cgroup/memory.current': '1000',
          '/sys/fs/cgroup/memory.max': String(2048 * MIB),
        },
        { constrainedMemory: () => 1024 * MIB },
      ),
    );
    expect(reading.cgroup).toMatchObject({ limitBytes: 2048 * MIB });
    expect(reading.cgroup.ok && reading.cgroup.constrainedBytes).toBeUndefined();
  });

  it('v1：取 memory controller 那一行的路徑；大到不合理的 limit 是沒設上限', async () => {
    const limited = await readMemory(
      deps({
        '/proc/self/cgroup': V1_LINES,
        '/sys/fs/cgroup/memory/system.slice/nexus-agent.service/memory.usage_in_bytes': String(
          256 * MIB,
        ),
        '/sys/fs/cgroup/memory/system.slice/nexus-agent.service/memory.limit_in_bytes': String(
          1024 * MIB,
        ),
        // 掛載根那份是整台機器：讀它的話數字會不對。
        '/sys/fs/cgroup/memory/memory.usage_in_bytes': String(99999 * MIB),
        '/sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712',
      }),
    );
    expect(limited.cgroup).toEqual({
      ok: true,
      version: 1,
      path: '/system.slice/nexus-agent.service',
      currentBytes: 256 * MIB,
      limitBytes: 1024 * MIB,
    });
    const unlimited = await readMemory(
      deps({
        '/proc/self/cgroup': '4:memory:/\n',
        '/sys/fs/cgroup/memory/memory.usage_in_bytes': '1000',
        '/sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712',
      }),
    );
    expect(unlimited.cgroup).toEqual({
      ok: true,
      version: 1,
      path: '/',
      currentBytes: 1000,
      limitBytes: null,
    });
  });

  it('hybrid：v2 那條沒有 memory controller（檔案不在）就換 v1', async () => {
    const reading = await readMemory(
      deps({
        '/proc/self/cgroup': HYBRID,
        '/sys/fs/cgroup/memory/system.slice/nexus-agent.service/memory.usage_in_bytes': '5000',
        '/sys/fs/cgroup/memory/system.slice/nexus-agent.service/memory.limit_in_bytes': '10000',
      }),
    );
    expect(reading.cgroup).toMatchObject({
      ok: true,
      version: 1,
      currentBytes: 5000,
      limitBytes: 10000,
    });
  });

  it('/proc/self/cgroup 不在（macOS）：才說「沒有 cgroup」，不回 0', async () => {
    const reading = await readMemory(deps({}));
    expect(reading.cgroup.ok).toBe(false);
    if (!reading.cgroup.ok) {
      expect(reading.cgroup.reason).toContain('/proc/self/cgroup ENOENT');
      expect(reading.cgroup.reason).toContain('沒有 cgroup');
    }
  });

  it('兩條路都是檔案不在：講「沒有 cgroup」並列出兩個路徑', async () => {
    const reading = await readMemory(deps({ '/proc/self/cgroup': HYBRID }));
    expect(reading.cgroup.ok).toBe(false);
    if (!reading.cgroup.ok) {
      expect(reading.cgroup.reason).toContain('沒有 cgroup');
      expect(reading.cgroup.reason).toContain(
        '/sys/fs/cgroup/system.slice/nexus-agent.service/memory.current',
      );
      expect(reading.cgroup.reason).toContain(
        '/sys/fs/cgroup/memory/system.slice/nexus-agent.service/memory.usage_in_bytes',
      );
    }
  });

  it('cgroup 在、但檔案讀不了（EACCES）：不說「沒有 cgroup」，點名哪個檔怎麼了', async () => {
    const reading = await readMemory(
      deps({
        '/proc/self/cgroup': V2_SYSTEMD,
        '/sys/fs/cgroup/system.slice/nexus-agent.service/memory.current': Object.assign(
          new Error('denied'),
          { code: 'EACCES' },
        ),
      }),
    );
    expect(reading.cgroup.ok).toBe(false);
    if (!reading.cgroup.ok) {
      expect(reading.cgroup.reason).toContain('memory.current EACCES');
      expect(reading.cgroup.reason).not.toContain('沒有 cgroup');
    }
  });

  it('/proc/self/cgroup 沒有 v2 行也沒有 memory controller：讀不到，原因說明', async () => {
    const reading = await readMemory(deps({ '/proc/self/cgroup': '3:cpu:/foo\n' }));
    expect(reading.cgroup.ok).toBe(false);
    if (!reading.cgroup.ok) expect(reading.cgroup.reason).toContain('/proc/self/cgroup');
  });

  it('路徑含 .. 或不是絕對路徑：不接到 /sys/fs/cgroup 底下，讀不到', async () => {
    for (const line of ['0::/../../etc\n', '0::relative\n']) {
      const reading = await readMemory(deps({ '/proc/self/cgroup': line }));
      expect(reading.cgroup.ok).toBe(false);
      if (!reading.cgroup.ok) expect(reading.cgroup.reason).toContain('cgroup 路徑不合法');
    }
  });

  it('內容不是整數：讀不到，不是 NaN 也不是 0', async () => {
    const reading = await readMemory(
      deps({
        '/proc/self/cgroup': V2_ROOT,
        '/sys/fs/cgroup/memory.current': 'abc',
        '/sys/fs/cgroup/memory.max': 'max',
      }),
    );
    expect(reading.cgroup.ok).toBe(false);
  });

  it('memory.current 讀到了但 memory.max 讀不到：整個 v2 算讀不到，原因點名 memory.max', async () => {
    const reading = await readMemory(
      deps({ '/proc/self/cgroup': V2_ROOT, '/sys/fs/cgroup/memory.current': '1000' }),
    );
    expect(reading.cgroup.ok).toBe(false);
    if (!reading.cgroup.ok) expect(reading.cgroup.reason).toContain('memory.max');
  });
});

describe('行程自己', () => {
  it('process.memoryUsage() 拋了：行程讀不到，附原因，其他兩個來源照讀，整行不被吞掉', async () => {
    const reading = await readMemory(
      deps(
        { '/proc/meminfo': MEMINFO },
        {
          processMemory: () => {
            throw new Error('no memoryUsage');
          },
        },
      ),
    );
    expect(reading.process).toEqual({ ok: false, reason: 'no memoryUsage' });
    expect(reading.host.ok).toBe(true);
    const line = formatMemoryLine(reading);
    expect(line).toContain('行程讀不到（no memoryUsage）');
    expect(line).toContain('主機可用');
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

  it('沒有 /proc/meminfo：退到 os.freemem()，標出來源與為什麼退', async () => {
    const reading = await readMemory(deps({}));
    expect(reading.host).toEqual({
      ok: true,
      source: 'os.freemem',
      availableBytes: 2048 * MIB,
      totalBytes: 8192 * MIB,
      fallbackReason: '/proc/meminfo ENOENT',
    });
  });

  it('/proc/meminfo 在但讀不了（EACCES）：退到 os.freemem()，原因是 EACCES，不是 ENOENT', async () => {
    const reading = await readMemory(
      deps({ '/proc/meminfo': Object.assign(new Error('denied'), { code: 'EACCES' }) }),
    );
    expect(reading.host).toMatchObject({
      source: 'os.freemem',
      fallbackReason: '/proc/meminfo EACCES',
    });
  });

  it('/proc/meminfo 在但沒有 MemAvailable（舊核心）：也退到 os.freemem()，原因寫出來', async () => {
    const reading = await readMemory(
      deps({ '/proc/meminfo': 'MemTotal: 100 kB\nMemFree: 50 kB\n' }),
    );
    expect(reading.host).toMatchObject({
      source: 'os.freemem',
      fallbackReason: '/proc/meminfo 沒有 MemAvailable 或 MemTotal',
    });
  });

  it('os.freemem() 也丟：主機讀不到，原因帶上前一步為什麼退', async () => {
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
    expect(reading.host).toEqual({
      ok: false,
      reason: '/proc/meminfo ENOENT；os.freemem boom',
    });
  });
});

describe('一行日誌', () => {
  it('三個來源都讀到：全寫出來（含 cgroup 路徑），單位 MiB', async () => {
    const line = formatMemoryLine(
      await readMemory(
        deps({
          '/proc/self/cgroup': V2_ROOT,
          '/sys/fs/cgroup/memory.current': String(512 * MIB),
          '/sys/fs/cgroup/memory.max': String(4096 * MIB),
          '/proc/meminfo': MEMINFO,
        }),
      ),
    );
    expect(line).toBe(
      '記憶體：行程 RSS 100.0 MiB、heap 已用 40.0 MiB／已提交 60.0 MiB；cgroup v2 / 512.0 MiB／4096.0 MiB；主機可用 8000.0 MiB／16000.0 MiB（MemAvailable）',
    );
  });

  it('讀不到的來源寫「讀不到（原因）」，退到 os.freemem 的寫出為什麼，沒設上限寫「沒設上限」', async () => {
    const unreadable = formatMemoryLine(await readMemory(deps({})));
    expect(unreadable).toContain('cgroup 讀不到（');
    expect(unreadable).toContain('（os.freemem；/proc/meminfo ENOENT）');
    const unlimited = formatMemoryLine(
      await readMemory(
        deps({
          '/proc/self/cgroup': V2_ROOT,
          '/sys/fs/cgroup/memory.current': String(MIB),
          '/sys/fs/cgroup/memory.max': 'max',
        }),
      ),
    );
    expect(unlimited).toContain('cgroup v2 / 1.0 MiB／沒設上限');
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
    // 每次 readMemory 同時讀 /proc/self/cgroup 與 /proc/meminfo，各卡在第一個讀上：三個間隔過去也只有那一輪的兩次讀，沒有第二輪。
    expect(reads).toBe(2);
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

  /** `onReading` 回的警告：有給 `warn` 就走 `warn`（讀數行仍走 `log`）；沒給就退回 `log`，行不變（#1534）。 */
  it('onReading 的警告：給了 warn 走 warn、讀數走 log；沒給就一起走 log', async () => {
    vi.useFakeTimers();
    const split = { info: [] as string[], warn: [] as string[] };
    const withWarn = startMemoryGauge({
      intervalMs: 1000,
      log: (l) => split.info.push(l),
      warn: (l) => split.warn.push(l),
      onReading: () => ['警告：用量高'],
      deps: deps({}),
    });
    await vi.advanceTimersByTimeAsync(0);
    withWarn.stop();
    expect(split.warn).toEqual(['警告：用量高']);
    expect(split.info).toHaveLength(1);
    expect(split.info[0]).toMatch(/^記憶體：/u);

    const merged: string[] = [];
    const withoutWarn = startMemoryGauge({
      intervalMs: 1000,
      log: (l) => merged.push(l),
      onReading: () => ['警告：用量高'],
      deps: deps({}),
    });
    await vi.advanceTimersByTimeAsync(0);
    withoutWarn.stop();
    expect(merged).toHaveLength(2);
    expect(merged[1]).toBe('警告：用量高');
  });
});

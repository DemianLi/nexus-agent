/**
 * 記憶體用量警告（[#1493](https://github.com/DemianLi/nexus-agent/issues/1493)）的單元測試：來源怎麼把讀數換成百分比、
 * 狀態機怎麼講（越過一次、遲滯、恢復、讀不到）。接線（serve 真的把門檻與 thread 數交進來）在 `serve-memory-gauge.test.ts`。
 *
 * 讀數全是注入的假值，不靠真的把記憶體吃到 75%。
 */

import { describe, expect, it } from 'vitest';

import type { MemoryReading, Reading, CgroupMemory, HostMemory } from './memory-gauge.js';
import {
  createMemoryPressureWatch,
  memoryUsageSource,
  PRESSURE_HYSTERESIS_POINTS,
} from './memory-pressure.js';
import type { PressureContext, PressureSource } from './memory-pressure.js';

const MIB = 1024 * 1024;
const PROCESS_OK = { ok: true, rssBytes: 1, heapUsedBytes: 1, heapTotalBytes: 1 } as const;

/** cgroup 讀得到、自己設了 1000 MiB 上限，用了 `percent`%。 */
function cgroupAt(percent: number, extra: Partial<CgroupMemory> = {}): Reading<CgroupMemory> {
  return {
    ok: true,
    version: 2,
    path: '/',
    currentBytes: percent * 10 * MIB,
    limitBytes: 1000 * MIB,
    ...extra,
  };
}

const HOST_OK: Reading<HostMemory> = {
  ok: true,
  source: 'MemAvailable',
  availableBytes: 8000 * MIB,
  totalBytes: 16000 * MIB,
};
const CGROUP_GONE: Reading<CgroupMemory> = { ok: false, reason: 'ENOENT' };
const HOST_GONE: Reading<HostMemory> = { ok: false, reason: 'EACCES' };

function reading(
  cgroup: Reading<CgroupMemory>,
  host: Reading<HostMemory> = HOST_OK,
): MemoryReading {
  return { process: PROCESS_OK, cgroup, host };
}

const CONTEXT: PressureContext = { threadCount: 37, maxThreads: 500 };

function watch(threshold = 75, sources: readonly PressureSource[] = [memoryUsageSource]) {
  return createMemoryPressureWatch({
    thresholdPercent: threshold,
    sources,
    context: () => CONTEXT,
  });
}

describe('來源：把讀數換成用量百分比（Q1）', () => {
  it('cgroup 自己設了上限：memory.current ÷ memory.max，依據寫 cgroup 版本與路徑', () => {
    expect(memoryUsageSource.measure(reading(cgroupAt(80)))).toEqual({
      kind: 'level',
      basis: 'cgroup v2 /',
      percent: 80,
      detail: '800.0 MiB／1000.0 MiB',
    });
  });

  it('cgroup 讀到、自己沒設上限、但行程受限（上限在祖先）：用受限的值，依據標出來', () => {
    const m = memoryUsageSource.measure(
      reading(
        cgroupAt(0, { currentBytes: 300 * MIB, limitBytes: null, constrainedBytes: 400 * MIB }),
      ),
    );
    expect(m).toMatchObject({ kind: 'level', basis: 'cgroup v2 /（行程受限）', percent: 75 });
  });

  it('cgroup 讀到但哪裡都沒設上限：退到主機 (總量 − 可用) ÷ 總量', () => {
    const m = memoryUsageSource.measure(reading(cgroupAt(0, { limitBytes: null })));
    expect(m).toMatchObject({ kind: 'level', basis: '主機 MemAvailable', percent: 50 });
  });

  it('沒有 cgroup（例如 macOS）：用主機', () => {
    const m = memoryUsageSource.measure(reading(CGROUP_GONE));
    expect(m).toMatchObject({ kind: 'level', basis: '主機 MemAvailable', percent: 50 });
  });

  it('有 cgroup 上限時**不看主機**：主機吃緊但容器沒滿，百分比是容器的', () => {
    const tight: Reading<HostMemory> = { ...HOST_OK, availableBytes: 100 * MIB };
    const m = memoryUsageSource.measure(reading(cgroupAt(10), tight));
    expect(m).toMatchObject({ kind: 'level', basis: 'cgroup v2 /', percent: 10 });
  });

  it('主機退到 os.freemem（沒有 MemAvailable）：當成讀不到，原因講出來，不拿它算百分比（PM 採納 B）', () => {
    const freemem: Reading<HostMemory> = {
      ok: true,
      source: 'os.freemem',
      availableBytes: 100 * MIB,
      totalBytes: 16000 * MIB,
      fallbackReason: 'ENOENT',
    };
    // 這個數字如果被拿來算，是 99.4% 的「用量」——正是 macOS 上會天天誤報的那一種。
    expect(memoryUsageSource.measure(reading(CGROUP_GONE, freemem))).toEqual({
      kind: 'unreadable',
      reason:
        'cgroup 讀不到（ENOENT）；主機沒有 MemAvailable（ENOENT），退到 os.freemem 不含可回收快取、不能當分母',
    });
    // cgroup 沒設上限、主機又只有 freemem：同樣讀不到。
    expect(
      memoryUsageSource.measure(reading(cgroupAt(0, { limitBytes: null }), freemem)).kind,
    ).toBe('unreadable');
  });

  it('有 cgroup 上限時，主機只剩 os.freemem 不影響：照樣用 cgroup', () => {
    const freemem: Reading<HostMemory> = {
      ...HOST_OK,
      source: 'os.freemem',
      fallbackReason: 'ENOENT',
    };
    expect(memoryUsageSource.measure(reading(cgroupAt(80), freemem))).toMatchObject({
      kind: 'level',
      basis: 'cgroup v2 /',
      percent: 80,
    });
  });

  it('macOS 形狀（沒有 cgroup、主機是 os.freemem）：整個不警告，起動只講一次原因', () => {
    const freemem: Reading<HostMemory> = {
      ok: true,
      source: 'os.freemem',
      availableBytes: 100 * MIB,
      totalBytes: 16000 * MIB,
      fallbackReason: 'ENOENT',
    };
    const w = watch();
    const first = w.observe(reading(CGROUP_GONE, freemem));
    expect(first).toHaveLength(1);
    expect(first[0]).toContain('os.freemem');
    expect(first[0]).not.toMatch(/警告：/u);
    for (let i = 0; i < 3; i += 1) expect(w.observe(reading(CGROUP_GONE, freemem))).toEqual([]);
  });

  it('兩邊都讀不到：讀不到，原因把兩邊都寫出來，不是 0%', () => {
    expect(memoryUsageSource.measure(reading(CGROUP_GONE, HOST_GONE))).toEqual({
      kind: 'unreadable',
      reason: 'cgroup 讀不到（ENOENT）；主機讀不到（EACCES）',
    });
    expect(
      memoryUsageSource.measure(reading(cgroupAt(0, { limitBytes: null }), HOST_GONE)),
    ).toEqual({
      kind: 'unreadable',
      reason: 'cgroup 沒設上限；主機讀不到（EACCES）',
    });
  });

  it('主機總量是 0：讀不到（不除以 0）', () => {
    const zero: Reading<HostMemory> = { ...HOST_OK, totalBytes: 0, availableBytes: 0 };
    expect(memoryUsageSource.measure(reading(CGROUP_GONE, zero)).kind).toBe('unreadable');
  });
});

describe('狀態機：越過一次、降回來一次（驗收 A）', () => {
  it('70% → 80% 警告一次；留在 80% 不再講；降到 69% 講已恢復；再升到 80% 再警告一次', () => {
    const w = watch();
    expect(w.observe(reading(cgroupAt(70)))).toEqual([]);
    const up = w.observe(reading(cgroupAt(80)));
    expect(up).toHaveLength(1);
    expect(up[0]).toMatch(/^\[記憶體\] 警告：/u);
    expect(w.observe(reading(cgroupAt(80)))).toEqual([]);
    expect(w.observe(reading(cgroupAt(82)))).toEqual([]);
    const down = w.observe(reading(cgroupAt(69)));
    expect(down).toHaveLength(1);
    expect(down[0]).toMatch(/^\[記憶體\] 已恢復：/u);
    expect(w.observe(reading(cgroupAt(69)))).toEqual([]);
    const again = w.observe(reading(cgroupAt(80)));
    expect(again).toHaveLength(1);
    expect(again[0]).toMatch(/警告：/u);
  });

  it('一開始就在門檻之上：第一次讀數就警告', () => {
    expect(watch().observe(reading(cgroupAt(90)))).toHaveLength(1);
  });

  it('門檻是嚴格大於：剛好 75.0% 不算越過，75.1% 才算', () => {
    const w = watch();
    expect(w.observe(reading(cgroupAt(75)))).toEqual([]);
    expect(w.observe(reading(cgroupAt(75.1)))).toHaveLength(1);
  });

  it('恢復是嚴格低於 門檻 − 5：剛好 70.0% 還沒恢復，69.9% 才恢復', () => {
    const w = watch();
    w.observe(reading(cgroupAt(80)));
    expect(w.observe(reading(cgroupAt(70)))).toEqual([]);
    expect(w.observe(reading(cgroupAt(69.9)))).toHaveLength(1);
    expect(PRESSURE_HYSTERESIS_POINTS).toBe(5);
  });
});

describe('遲滯：門檻附近來回不洗版（驗收 B）', () => {
  it('還沒越過時，在 71% 到 75% 之間來回：一行都沒有', () => {
    const w = watch();
    const lines: string[] = [];
    for (const percent of [71, 75, 72, 75, 71, 74, 75, 73])
      lines.push(...w.observe(reading(cgroupAt(percent))));
    expect(lines).toEqual([]);
  });

  it('越過之後，在 71% 到 79% 之間來回：沒有「已恢復」也沒有第二次警告，只有最初那一行', () => {
    const w = watch();
    const lines: string[] = [];
    for (const percent of [76, 71, 79, 72, 76, 71, 78])
      lines.push(...w.observe(reading(cgroupAt(percent))));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/警告：/u);
  });
});

describe('警告的內容（驗收 E）', () => {
  it('依據、百分比、門檻、分子分母、現在幾條 thread、下一步（maxThreads 與 idleEvictAfterMs）、門檻在哪設', () => {
    const [line] = watch().observe(reading(cgroupAt(80)));
    expect(line).toContain('cgroup v2 /');
    expect(line).toContain('80.0%');
    expect(line).toContain('門檻 75%');
    expect(line).toContain('800.0 MiB／1000.0 MiB');
    expect(line).toContain('37 條 thread（上限 500）');
    expect(line).toContain('maxThreads');
    expect(line).toContain('idleEvictAfterMs');
    expect(line).toContain('warnAtPercent');
  });

  it('依據是主機時寫主機，不寫成 cgroup', () => {
    const [line] = watch(40).observe(reading(CGROUP_GONE));
    expect(line).toContain('主機 MemAvailable');
    expect(line).not.toContain('cgroup v');
  });

  it('沒有 thread 上限（maxThreads 沒給）：只寫現在幾條，不寫「上限」', () => {
    const w = createMemoryPressureWatch({
      thresholdPercent: 75,
      sources: [memoryUsageSource],
      context: () => ({ threadCount: 3 }),
    });
    const [line] = w.observe(reading(cgroupAt(80)));
    expect(line).toContain('3 條 thread。');
    expect(line).not.toContain('上限');
  });

  it('讀 serve 現況拋了：警告本身照寫，只少那一句', () => {
    const w = createMemoryPressureWatch({
      thresholdPercent: 75,
      sources: [memoryUsageSource],
      context: () => {
        throw new Error('壞了');
      },
    });
    const [line] = w.observe(reading(cgroupAt(80)));
    expect(line).toMatch(/警告：.*80\.0%/u);
    expect(line).not.toContain('條 thread');
  });

  it('門檻跟著設定：50% 的門檻，60% 就警告、寫 50%', () => {
    const [line] = watch(50).observe(reading(cgroupAt(60)));
    expect(line).toContain('門檻 50%');
  });

  it('恢復那一行寫降到哪個門檻以下', () => {
    const w = watch();
    w.observe(reading(cgroupAt(80)));
    const [line] = w.observe(reading(cgroupAt(60)));
    expect(line).toMatch(/已恢復：.*60\.0%，低於 70%/u);
  });
});

describe('讀不到就不判斷、不警告，也不當成 0%（驗收 D）', () => {
  it('起動就讀不到：講一次原因；之後一直讀不到不重複，也沒有警告', () => {
    const w = watch();
    const first = w.observe(reading(CGROUP_GONE, HOST_GONE));
    expect(first).toHaveLength(1);
    expect(first[0]).toContain('讀不到');
    expect(first[0]).toContain('ENOENT');
    expect(first[0]).toContain('EACCES');
    expect(w.observe(reading(CGROUP_GONE, HOST_GONE))).toEqual([]);
    expect(w.observe(reading(CGROUP_GONE, HOST_GONE))).toEqual([]);
  });

  it('讀不到不是 0%：越過之後讀不到，不講「已恢復」；回來時仍高，不再警告；降下去才恢復', () => {
    const w = watch();
    expect(w.observe(reading(cgroupAt(80)))).toHaveLength(1);
    const gone = w.observe(reading(CGROUP_GONE, HOST_GONE));
    expect(gone).toHaveLength(1);
    expect(gone[0]).not.toMatch(/已恢復/u);
    expect(w.observe(reading(cgroupAt(80)))).toEqual([]);
    expect(w.observe(reading(cgroupAt(60)))[0]).toMatch(/已恢復/u);
  });

  it('讀不到之後回來是低的：不補一行「已恢復」（它本來就沒警告過）', () => {
    const w = watch();
    w.observe(reading(CGROUP_GONE, HOST_GONE));
    expect(w.observe(reading(cgroupAt(10)))).toEqual([]);
  });

  it('只在「從可讀變成不可讀」時講：可讀 → 不可讀 → 可讀 → 不可讀 講兩次', () => {
    const w = watch();
    const lines: string[] = [];
    lines.push(...w.observe(reading(cgroupAt(10))));
    lines.push(...w.observe(reading(CGROUP_GONE, HOST_GONE)));
    lines.push(...w.observe(reading(CGROUP_GONE, HOST_GONE)));
    lines.push(...w.observe(reading(cgroupAt(10))));
    lines.push(...w.observe(reading(CGROUP_GONE, HOST_GONE)));
    expect(lines).toHaveLength(2);
  });

  it('來源自己拋了：當成讀不到（講一次），不往外拋', () => {
    const broken: PressureSource = {
      id: 'broken',
      label: '壞掉的來源',
      measure: () => {
        throw new Error('炸了');
      },
    };
    const w = watch(75, [broken]);
    const lines = w.observe(reading(cgroupAt(10)));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('炸了');
    expect(w.observe(reading(cgroupAt(10)))).toEqual([]);
  });

  it('算出來不是數字：當成讀不到，不是警告也不是 0%', () => {
    const nan: PressureSource = {
      id: 'nan',
      label: 'NaN 來源',
      measure: () => ({ kind: 'level', basis: 'x', percent: Number.NaN, detail: '1／0' }),
    };
    const lines = watch(75, [nan]).observe(reading(cgroupAt(10)));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('不是數字');
  });
});

describe('來源可擴充：每個來源各一份狀態', () => {
  const heap = (percent: number): PressureSource => ({
    id: 'heap',
    label: 'heap 用量',
    measure: () => ({ kind: 'level', basis: 'v8 heap', percent, detail: 'x／y' }),
  });

  it('兩個來源各自越過、各自講，互不影響', () => {
    let heapPercent = 10;
    const dynamicHeap: PressureSource = {
      ...heap(0),
      measure: () => heap(heapPercent).measure({} as MemoryReading),
    };
    const w = watch(75, [memoryUsageSource, dynamicHeap]);
    expect(w.observe(reading(cgroupAt(10)))).toEqual([]);
    heapPercent = 90;
    const first = w.observe(reading(cgroupAt(10)));
    expect(first).toHaveLength(1);
    expect(first[0]).toContain('heap 用量');
    const second = w.observe(reading(cgroupAt(80)));
    expect(second).toHaveLength(1);
    expect(second[0]).toContain('記憶體用量');
    expect(w.observe(reading(cgroupAt(80)))).toEqual([]);
  });

  it('一個來源讀不到不影響另一個', () => {
    const lost: PressureSource = {
      id: 'lost',
      label: '遺失的',
      measure: () => ({ kind: 'unreadable', reason: 'x' }),
    };
    const w = watch(75, [lost, memoryUsageSource]);
    const lines = w.observe(reading(cgroupAt(80)));
    expect(lines).toHaveLength(2);
    expect(lines.some((line) => /警告：記憶體用量/u.test(line))).toBe(true);
  });

  it('同一個來源的依據換了（cgroup 消失、改看主機）：狀態重來，已越過的不會被當成同一個數字', () => {
    const w = watch(40);
    expect(w.observe(reading(cgroupAt(90)))).toHaveLength(1);
    // 改看主機（50%）：依據換了、百分比的意思變了，重新判斷——50 > 40，再警告一次。
    const switched = w.observe(reading(CGROUP_GONE));
    expect(switched).toHaveLength(1);
    expect(switched[0]).toContain('主機 MemAvailable');
  });

  it('來源 id 重複、門檻不是 1 到 99 的整數：建不起來', () => {
    expect(() => watch(75, [memoryUsageSource, memoryUsageSource])).toThrow(/不可重複/u);
    for (const bad of [0, 100, 50.5, -1, Number.NaN]) expect(() => watch(bad)).toThrow(RangeError);
  });
});

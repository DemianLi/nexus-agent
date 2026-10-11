/**
 * [#1386](https://github.com/DemianLi/nexus-agent/issues/1386) 驗收 ③：同一顆插件兩個版本各在一個 isolate realm、各被不同 thread 使用，
 * 舊版的最後一個 thread 結束後由引用計數撤掉，活資源回到載入前。做法與各層是什麼見 `coexist.ts`。
 *
 * 在 tsx 子行程裡跑，不在 vitest 裡跑（理由同 `plugin-coexist.test.ts`）。子行程結束不了（有東西漏了、事件迴圈被拖住）
 * 時這條會逾時——那本身就是紅。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { CoexistReport } from './coexist.js';

const run = promisify(execFile);

type Line =
  | ({ kind: 'coexist' } & CoexistReport)
  | {
      kind: 'without-isolate';
      v2State: number | undefined;
      errors: string[];
      leak: Record<string, number>;
    };

async function underTsx(): Promise<Line[]> {
  const { stdout } = await run(
    process.execPath,
    ['--import', 'tsx', `${import.meta.dirname}/coexist-cli.ts`],
    { maxBuffer: 8 * 1024 * 1024, timeout: 90_000 },
  );
  return stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Line);
}

describe('新舊版並存加排水（#1386 ③，tsx 子行程）', () => {
  it('兩版各被各的 thread 使用；v1 有 thread 時不撤，最後一個結束後撤掉、資源收回，全部收掉後回到載入前', async () => {
    const lines = await underTsx();
    const report = lines.find((line) => line.kind === 'coexist');
    const negative = lines.find((line) => line.kind === 'without-isolate');

    expect(report).toMatchObject({
      distinctModules: true,
      served: [
        { thread: 'thread-a', label: 'mcp@1' },
        { thread: 'thread-b', label: 'mcp@2' },
        { thread: 'thread-c', label: 'mcp@2' },
      ],
      v1KeptWhileInUse: true,
      v1EntryGone: true,
      // 正常卸載的 ACTIVE fiber 會收斂到 DISPOSED；#127 只影響非 ACTIVE 的（見負對照）。
      v1FiberState: 4,
      v2StillServes: true,
      finalLeak: {},
      table: [{ label: 'mcp@2', threads: 1 }],
    });
    // 這顆插件真的開了東西（不是空的通過），而 v1 排水收回的正是它開的那些。
    const opened = (report as CoexistReport).v1Opened;
    expect(opened['ProcessWrap']).toBeGreaterThan(0);
    expect((report as CoexistReport).v1Drain).toEqual(
      Object.fromEntries(Object.entries(opened).map(([type, count]) => [type, -count])),
    );

    // 負對照：不開 isolate，第二版 provide 同名服務撞名、起不來；它開的子行程照樣收掉。
    // 失敗的 fiber 停在 UNLOADING（3）收斂不到 DISPOSED——上游 #127，在 c261dd2c 上仍然重現。
    expect(negative).toMatchObject({
      v2State: 3,
      errors: ['service "mcp" has been registered at <mcp-version>'],
      leak: {},
    });
  }, 120_000);
});

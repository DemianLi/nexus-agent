/**
 * 目標續行的操作者上限（[#1623](https://github.com/DemianLi/nexus-agent/issues/1623)），**走產品路徑**：serve 用真的 pump 與 wire，
 * CLI 用 `runCli`，上限都從 `cordis.yml` 的 `goal-round-cap` 那一列來（patch 改它）。決定函式本身在 `goal-driver.test.ts`；這一份量的是
 * 接線——拿掉 pump 交上限的那一個參數、或 serve 不讀那一列，這裡要紅，那邊不會（#1427 的教訓）。
 *
 * 模型是腳本：先由模型建目標（`create_goal`），之後每個續行輪只回一句話、不完成目標。**零憑證、零外部連線**。
 * 模型調高自己的上限（驗收 4）在 `goal-driver-pump.test.ts`：產品路徑上目標 id 是隨機的，腳本寫不出 `update_goal` 要的 ref，
 * 那一份的 goal 夾具把 id 固定成 `goal-1`。寫壞那一列起不來（驗收 8）在 `startup-audit.test.ts`。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import type { WireClient } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';

import { runCli } from './cli.js';
import { foldTurn, serveClient } from './fixtures.js';
import type { ScriptedTurn } from './scripted-model.js';
import { scriptedPatchText, startScriptedServe } from './scripted-serve.js';
import type { ScriptedServe } from './scripted-serve.js';

let served: ScriptedServe | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await served?.close();
  served = undefined;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** `goal-round-cap` 那一列設成 `limit`。 */
const capRow = (limit: number): string =>
  `- id: goal-round-cap\n  config:\n    limit: ${String(limit)}\n`;
const CAP_DISABLED = '- id: goal-round-cap\n  disabled: true\n';

/**
 * 跑滿 21 輪的兩條：單跑時 serve 約 1.3 秒、CLI 約 0.8 秒（2026-10-22 本機量），平行負載下離預設的 5 秒不夠遠。
 * 21 是分得出「關掉的列被讀成出廠 20」的最小輪數。
 */
const LONG_TIMEOUT_MS = 20_000;

/** 人說一句 → 模型建目標（自己填 `maxGoalRounds`）→ 收尾。之後每個續行輪一句話，備得比會跑的多。 */
function script(maxGoalRounds: number): ScriptedTurn[] {
  return [
    {
      content: '',
      toolCalls: [
        {
          name: 'create_goal',
          args: { objective: '把藍鯨計畫做完', max_goal_rounds: maxGoalRounds },
        },
      ],
    },
    { content: '建好了。' },
    ...Array.from({ length: maxGoalRounds + 2 }, (_, at) => ({
      content: `續行第 ${String(at + 1)} 句。`,
    })),
  ];
}

async function until(predicate: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`等不到：${what}`);
}

/** 用 `goal.pause` 拿目前目標的相位：帶一個必定過期的 ref，回應的 `current` 就是現在的樣子（同 `goal-pause-wire.test.ts`）。
 * 擋住的理由不在這裡（wire 的 `GoalPauseState` 只有 ref 與相位），讀 `/goal` 那一行。 */
async function currentGoal(client: WireClient, thread: string) {
  const stale = await client.goalPause(thread, { goalId: 'goal-nope', revision: 1 });
  if (stale.kind !== 'ok' || stale.result.ok || stale.result.error.code !== 'goal-stale') {
    throw new Error(`拿不到目前的目標：${JSON.stringify(stale)}`);
  }
  return stale.result.error.current;
}

/** `/goal` 的文字，裡面有「擋住它的：code：message」與「輪次：N/M」。 */
async function goalText(client: WireClient, thread: string): Promise<string> {
  const shown = await client.slashRun(thread, '/goal');
  if (shown.kind !== 'success') throw new Error(`/goal 讀不到：${JSON.stringify(shown)}`);
  return shown.text ?? '';
}

/** 同上，但有一輪跑著（斜線命令被擋）就回空字串，給輪詢用。 */
async function goalTextIfIdle(client: WireClient, thread: string): Promise<string> {
  const shown = await client.slashRun(thread, '/goal');
  return shown.kind === 'success' ? (shown.text ?? '') : '';
}

/** 起一台 serve、說第一句，等目標被擋住，回 client。 */
async function untilBlocked(
  thread: string,
  turns: readonly ScriptedTurn[],
  extraRows: string,
  log?: (line: string) => void,
): Promise<WireClient> {
  served = await startScriptedServe(turns, { extraRows, ...(log === undefined ? {} : { log }) });
  const client = await serveClient(served.running);
  const events = await client.openEvents(thread);
  expect((await client.runStart(thread, '開個頭')).type).toBe('success');
  await foldTurn(events);
  await until(async () => (await currentGoal(client, thread)).phase === 'blocked', '目標被擋住');
  return client;
}

describe('serve：goal-round-cap 那一列夾住續行', () => {
  /**
   * 驗收 1；拿掉 `thread-pump.ts` 交上限的那一個參數（驗收 2），這一條要紅：會跑滿目標自己的 5 輪、記 round-limit。
   * 啟動那一行講的是這一次實際的上限：serve 沒把那一列交給揭露那一行的話，這裡要紅。
   */
  it('上限 2：跑完第 2 輪續行就不再排，目標記 round-cap，訊息指名那一列；啟動那一行寫 2 輪', async () => {
    const lines: string[] = [];
    const client = await untilBlocked(
      'cap-serve',
      script(5),
      capRow(2),
      (line) => void lines.push(line),
    );
    const shown = await goalText(client, 'cap-serve');
    expect(shown).toMatch(/^擋住它的：round-cap：.*goal-round-cap/mu);
    expect(shown).toContain('輪次：2/5');
    expect(lines.join('\n')).toContain('給的 2 輪');
  });

  /** 驗收 5：`round-cap` 之後人恢復目標，重新起算，再跑滿 2 輪才又擋。比累計的話恢復之後馬上又擋，一輪都不跑。 */
  it('round-cap 之後人恢復，重新起算再跑 2 輪', async () => {
    const client = await untilBlocked('cap-resume', script(5), capRow(2));
    expect(await goalText(client, 'cap-resume')).toContain('輪次：2/5');

    const resumed = await client.slashRun('cap-resume', '/goal resume');
    expect(resumed.kind).toBe('success');
    await until(
      async () => (await goalTextIfIdle(client, 'cap-resume')).includes('輪次：4/5'),
      '恢復之後再跑 2 輪',
    );
    await until(
      async () => (await currentGoal(client, 'cap-resume')).phase === 'blocked',
      '又被擋住',
    );
    const shown = await goalText(client, 'cap-resume');
    expect(shown).toContain('擋住它的：round-cap：');
    expect(shown).toContain('輪次：4/5');
  });

  /**
   * 驗收 7：那一列關掉就只剩目標自己那條，跟沒有這一列一樣；啟動那一行講明操作者那條關著。目標自己給 21，比出廠的 20 大——
   * 讀那一列時沒先問掛沒掛，關掉的列會被讀成 schema 預設 20，這裡就在 20 輪記 round-cap。
   */
  it(
    '那一列關掉：跑滿目標自己的 21 輪、記 round-limit，不是被讀成出廠的 20',
    async () => {
      const lines: string[] = [];
      const client = await untilBlocked(
        'cap-off',
        script(21),
        CAP_DISABLED,
        (line) => void lines.push(line),
      );
      const shown = await goalText(client, 'cap-off');
      expect(shown).toContain('擋住它的：round-limit：');
      expect(shown).toContain('輪次：21/21');
      expect(lines.join('\n')).toContain('goal-round-cap 那一列關著');
    },
    LONG_TIMEOUT_MS,
  );
});

/** CLI 跑一次（`--patch` 換腳本與那一列），回印出來的每一行。 */
async function cli(argv: readonly string[], turns: readonly ScriptedTurn[], rows: string) {
  const dir = await mkdtemp(join(tmpdir(), 'nexus-goal-round-cap-'));
  dirs.push(dir);
  const patch = join(dir, 'scripted.patch.yml');
  await writeFile(patch, scriptedPatchText(turns, rows), 'utf8');
  const out: string[] = [];
  const record = (...parts: unknown[]): void => void out.push(parts.join(' '));
  await runCli({
    argv: ['--patch', patch, ...argv, '開個頭'],
    input: new PassThrough(),
    output: new PassThrough(),
    printer: { log: record, error: record },
    env: {},
  });
  return { said: out.join('\n'), rounds: out.filter((line) => line.includes('[續行] 第')).length };
}

describe('CLI：--max-goal-rounds 贏過那一列，那一列贏過不設', () => {
  it('沒給旗標：照那一列的 2', async () => {
    const { rounds, said } = await cli(['--goal-driver'], script(5), capRow(2));
    expect(rounds).toBe(2);
    expect(said).toContain('goal-round-cap 那一列）給的 2 輪');
  });

  it('旗標 3、那一列 2：照旗標的 3', async () => {
    const { rounds, said } = await cli(
      ['--goal-driver', '--max-goal-rounds', '3'],
      script(5),
      capRow(2),
    );
    expect(rounds).toBe(3);
    expect(said).toContain('--max-goal-rounds 旗標給的 3 輪');
  });

  /**
   * 目標自己給 21，比出廠的 20 大：讀那一列時沒先問掛沒掛，關掉的列會被讀成 schema 預設 20，這裡就只跑 20 輪。
   * 目標自己的數比 20 小的話兩條都先撞到它，量不出這件事。
   */
  it(
    '那一列關掉、也沒給旗標：只剩目標自己的 21，不是被讀成出廠的 20',
    async () => {
      const { rounds, said } = await cli(['--goal-driver'], script(21), CAP_DISABLED);
      expect(rounds).toBe(21);
      expect(said).toContain('goal-round-cap 那一列關著，也沒有給 --max-goal-rounds');
    },
    LONG_TIMEOUT_MS,
  );

  /** Q-A4 (a)：那一列出廠就有值，CLI 預設不開續行；不帶 `--goal-driver` 照常啟動、不報錯，也一輪都不排。 */
  it('沒帶 --goal-driver：照常啟動、不報錯，一輪都不排', async () => {
    const { rounds, said } = await cli([], script(5), capRow(2));
    expect(rounds).toBe(0);
    expect(said).toContain('續行：關閉');
  });
});

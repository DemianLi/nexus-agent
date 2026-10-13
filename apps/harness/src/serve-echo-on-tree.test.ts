/**
 * echo 在 Cordis 樹上，走 serve 的真路徑（[#1416](https://github.com/DemianLi/nexus-agent/issues/1416) PR 2 review ①）：
 * `runServe` 加真的 wire client，驗收 E、F、C 各一組。`echo-on-tree.test.ts` 量的是組裝那一層；這裡量的是「從啟動試組、
 * 每條 thread 重讀清單到模型實際叫得到工具」整條線。
 *
 * 「這一條 thread 有沒有 echo」看的是線上那一輪：出貨清單的腳本假模型第一輪就呼叫 `echo`
 * （`message: 'CLI 接線測試'`），所以工具卡的結果文字就是 `<前綴>：CLI 接線測試`；沒有 echo 時那張卡是失敗的。
 */

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ToolEntry } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';

import { foldTurn, serveClient } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { changePlugin } from './plugin-change.js';
import { shippedConfigPath } from './plugin-config.js';
import { installTreeListing } from './install-tree.fixture.js';
import { appendRaw, readJournalText, seedHomePatch } from './plugin-journal.fixture.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';

const temporary: string[] = [];
let running: RunningServe | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function home(): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-serve-echo-tree-'));
  chmodSync(dir, 0o700);
  temporary.push(dir);
  return { dir, env: { [HARNESS_HOME_ENV]: dir } };
}

async function start(
  env: NodeJS.ProcessEnv,
  lines: string[] = [],
  extra: readonly string[] = [],
): Promise<RunningServe> {
  const server = (await runServe({
    argv: ['--port', '0', ...extra],
    log: (line) => lines.push(line),
    env,
  })) as RunningServe;
  running = server;
  return server;
}

interface EchoOutcome {
  /** 建不起來的錯誤訊息。 */
  readonly error?: string;
  /** 那一輪裡 `echo` 的工具卡；這條 thread 沒有 echo 時是失敗的那一張，或根本沒有。 */
  readonly card?: ToolEntry;
}

/** 開一條 thread、說一句（讓它組裝並跑第一輪）、回 echo 那張卡。 */
async function openAndSay(server: RunningServe, thread: string): Promise<EchoOutcome> {
  const client = await serveClient(server);
  const events = await client.openEvents(thread).catch((error: unknown) => error as Error);
  if (events instanceof Error) return { error: events.message };
  try {
    const started = await client.runStart(thread, '說點什麼');
    if (started.type === 'error') return { error: started.message };
    const state = await foldTurn(events);
    const card = state.entries.find(
      (entry): entry is ToolEntry => entry.kind === 'tool' && entry.name === 'echo',
    );
    return card === undefined ? {} : { card };
  } finally {
    await events.return?.(undefined);
  }
}

/** echo 在這條 thread 上叫得到：卡成功、文字是 `<前綴>：CLI 接線測試`。 */
const echoed = (outcome: EchoOutcome): string | undefined =>
  outcome.card?.status === 'done' ? outcome.card.text : undefined;

const journalLines = (dir: string): number =>
  readJournalText(dir).split('\n').filter(Boolean).length;

describe('E：寫入口停用 echo，serve 的下一條 thread 沒有它，啟用就回來', () => {
  it('紀錄 +1 行、出貨檔位元組不變；寫入之後立刻開的 thread 就看到新狀態', async () => {
    const { dir, env } = home();
    const shipped = readFileSync(shippedConfigPath(), 'utf8');
    const installBefore = installTreeListing();
    const server = await start(env);
    expect(echoed(await openAndSay(server, 'a'))).toBe('回聲：CLI 接線測試');
    const before = journalLines(dir);

    expect(await changePlugin({ op: 'disable', id: 'echo' }, { env })).toMatchObject({
      outcome: 'recorded',
      effect: 'next-thread',
    });
    expect(journalLines(dir)).toBe(before + 1);
    const off = await openAndSay(server, 'b');
    expect(off.error).toBeUndefined();
    expect(echoed(off)).toBeUndefined();

    expect(await changePlugin({ op: 'enable', id: 'echo' }, { env })).toMatchObject({
      outcome: 'recorded',
    });
    expect(echoed(await openAndSay(server, 'c'))).toBe('回聲：CLI 接線測試');
    expect(readFileSync(shippedConfigPath(), 'utf8')).toBe(shipped);
    // 安裝樹沒有多出任何檔：serve 起來、跑了三條 thread，Loader 也沒有在裡面建 `.cordis/`。
    expect(installTreeListing()).toEqual(installBefore);
  }, 90000);
});

describe('F：改前綴，serve 的下一條 thread 是新值', () => {
  it('改了就是新值、還原就回舊值；寫入之後立刻開的 thread 就看到', async () => {
    const { env } = home();
    const server = await start(env);
    expect(echoed(await openAndSay(server, 'a'))).toBe('回聲：CLI 接線測試');
    await changePlugin({ op: 'config-set', id: 'echo', config: { prefix: '聽到了' } }, { env });
    expect(echoed(await openAndSay(server, 'b'))).toBe('聽到了：CLI 接線測試');
    await changePlugin({ op: 'config-reset', id: 'echo' }, { env });
    expect(echoed(await openAndSay(server, 'c'))).toBe('回聲：CLI 接線測試');
  }, 90000);
});

describe('C：echo 在啟動試組就掉了', () => {
  it('設定驗不過：不重試的那一列，用寫入口改回合法值後下一條 thread 重試、echo 回來，樹上那一列不會回不來', async () => {
    const { dir, env } = home();
    // 寫入口不會放行這個值；驗證之後才壞掉的設定（手動改了紀錄、或下一版收緊了格式）用 raw 造。
    await appendRaw(dir, {
      op: 'config-set',
      id: 'echo',
      name: '@nexus/plugin-echo',
      before: null,
      after: { prefix: 123 },
    });
    const lines: string[] = [];
    const server = await start(env, lines);
    // 啟動時就掉了：可少掛，所以 serve 照常起來，警告指名那一列與原因。
    expect(lines.join('\n')).toMatch(/echo/u);
    const dropped = await openAndSay(server, 'a');
    expect(dropped.error).toBeUndefined();
    expect(echoed(dropped)).toBeUndefined();
    // 同一個宣告第二條 thread 也不重試（#1405 Q2）：還是沒有。
    expect(echoed(await openAndSay(server, 'a2'))).toBeUndefined();

    const fixed = await changePlugin(
      { op: 'config-set', id: 'echo', config: { prefix: '好了' } },
      { env },
    );
    expect(fixed).toMatchObject({ outcome: 'recorded' });
    // 宣告變了，下一條 thread 重試，echo 回來。
    expect(echoed(await openAndSay(server, 'b'))).toBe('好了：CLI 接線測試');

    // 樹上那一列沒有卡在「被 patch 停用」的狀態：之後的停用、啟用、改設定照常來回。
    await changePlugin({ op: 'config-set', id: 'echo', config: { prefix: '再改' } }, { env });
    expect(echoed(await openAndSay(server, 'c'))).toBe('再改：CLI 接線測試');
    await changePlugin({ op: 'disable', id: 'echo' }, { env });
    expect(echoed(await openAndSay(server, 'd'))).toBeUndefined();
    await changePlugin({ op: 'enable', id: 'echo' }, { env });
    expect(echoed(await openAndSay(server, 'e'))).toBe('再改：CLI 接線測試');
  }, 120000);

  it('設定改回「原來的」宣告（還原成繼承值）也能重試：紀錄裡的覆蓋拿掉後 echo 回來', async () => {
    const { dir, env } = home();
    await appendRaw(dir, {
      op: 'config-set',
      id: 'echo',
      name: '@nexus/plugin-echo',
      before: null,
      after: { prefix: 123 },
    });
    const server = await start(env);
    expect(echoed(await openAndSay(server, 'a'))).toBeUndefined();
    await changePlugin({ op: 'config-reset', id: 'echo' }, { env });
    expect(echoed(await openAndSay(server, 'b'))).toBe('回聲：CLI 接線測試');
  }, 90000);

  it('試組在 apply 掉了（設定驗得過）：不重試，寫入口改了宣告後下一條 thread 重試、echo 回來', async () => {
    const { dir, env } = home();
    // 一顆沿用真 echo 的 name／inject／Config／manifest、只在 `prefix` 是「壞」時於 apply 裡拋的 echo。
    // 設定過得了 schema，所以是「組裝時才掉」（試組的 apply 階段）那一類，走的是 `knownAssembly` 不重試那條。
    const witness = join(dir, 'applied.txt');
    const module = join(dir, 'flaky-echo.mjs');
    writeFileSync(
      module,
      `import { appendFileSync } from 'node:fs';
import * as real from ${JSON.stringify(import.meta.resolve('@nexus/plugin-echo'))};
export const { name, inject, Config, manifest } = real;
export function apply(ctx, config) {
  appendFileSync(${JSON.stringify(witness)}, config.prefix + '\\n');
  if (config.prefix === '壞') throw new Error('故意在 apply 裡壞掉');
  return real.apply(ctx, config);
}
`,
      { mode: 0o600 },
    );
    chmodSync(module, 0o600);
    // patch 改不了一列的 `name`（對不上就跳過），所以停用出貨的 echo、插一列同形的 `echo-flaky` 頂替。
    // 走家目錄的 patch（寫入口認得的那一份），不用 `--patch`：寫入口看不到命令列的 overlay。
    seedHomePatch(
      dir,
      `- id: echo\n  disabled: true\n- insert:\n    - id: echo-flaky\n      name: 'file://${module}'\n      config:\n        prefix: 壞\n`,
    );
    const applied = (): string[] =>
      existsSync(witness) ? readFileSync(witness, 'utf8').split('\n').filter(Boolean) : [];

    const server = await start(env);
    expect(applied()).toEqual(['壞']);
    expect(echoed(await openAndSay(server, 'a'))).toBeUndefined();
    expect(echoed(await openAndSay(server, 'a2'))).toBeUndefined();
    // 兩條 thread 都沒有重新 apply 那一列：不重試（#1405 Q2）。
    expect(applied()).toEqual(['壞']);

    expect(
      await changePlugin(
        { op: 'config-set', id: 'echo-flaky', config: { prefix: '好了' } },
        { env },
      ),
    ).toMatchObject({ outcome: 'recorded' });
    expect(echoed(await openAndSay(server, 'b'))).toBe('好了：CLI 接線測試');
    expect(applied().at(-1)).toBe('好了');

    // 樹上那一列沒有卡在停用：之後改設定與停用、啟用照常來回。
    await changePlugin({ op: 'config-set', id: 'echo-flaky', config: { prefix: '再改' } }, { env });
    expect(echoed(await openAndSay(server, 'c'))).toBe('再改：CLI 接線測試');
    await changePlugin({ op: 'disable', id: 'echo-flaky' }, { env });
    expect(echoed(await openAndSay(server, 'd'))).toBeUndefined();
    await changePlugin({ op: 'enable', id: 'echo-flaky' }, { env });
    expect(echoed(await openAndSay(server, 'e'))).toBe('再改：CLI 接線測試');
  }, 120000);

  it('契約不相容：那一列在啟動就掉在 requires，日誌指名原因，echo 與 serve 其餘照常', async () => {
    const { dir, env } = home();
    // 一列要 `tools ^2.0.0` 的函式插件，插在出貨的 cordis.yml 旁（`--patch` 的 insert）。Include 讀的是出貨檔，
    // 所以這一列走的是「上不了樹」那條路（`cordis.yml` 沒有它）；契約不相容的那一條由 `echo-on-tree-edges.test.ts`
    // 用暫存的出貨檔量，這裡量的是 serve 把這一類的掉列講出來、不拖累其餘的列。
    const module = join(dir, 'needs-v2.mjs');
    writeFileSync(
      module,
      `import { z } from 'zod';
export const name = 'needs-v2';
export const inject = { tools: { range: '^2.0.0' } };
export const Config = z.strictObject({});
export const manifest = { id: 'needs-v2', version: '1.0.0', owner: 't', provides: [], consumes: [{ token: 'tools', range: '^2.0.0' }], config: Config, reload: { code: 'restart', config: 'next-thread' }, capabilities: [] };
export function apply() {}
`,
      { mode: 0o600 },
    );
    chmodSync(module, 0o600);
    const patch = join(dir, 'overlay.yml');
    writeFileSync(patch, `- insert:\n    - id: needs-v2\n      name: '${module}'\n`, {
      mode: 0o600,
    });
    chmodSync(patch, 0o600);
    const lines: string[] = [];
    const server = await start(env, lines, ['--patch', patch]);
    const text = lines.join('\n');
    expect(text).toContain('needs-v2');
    expect(text).toMatch(/沒有掛上/u);
    expect(echoed(await openAndSay(server, 'a'))).toBe('回聲：CLI 接線測試');
  }, 90000);
});

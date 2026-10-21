/**
 * **收尾時間窗內，會讓排程器自己開一輪的 `/goal` 命令回 `server_closing`，而且一個字都沒寫**——[#1787](https://github.com/DemianLi/nexus-agent/issues/1787)
 * 第 3 點的補洞：`/goal <目標>`、`/goal resume` 不 `steer`，但目標一變成進行中，`thread-pump` 的排程器（`#scheduleGoalDrive`）就看見 `goal/change`、
 * 自己起第一輪——`acceptSteer` 攔不到這條路。閘門是 `CommandInvocation.openTurn`（`acceptOpenTurn`），goal 命令在寫 `goal/change` **之前**呼叫。
 *
 * 走真的 `runServe`＋腳本模型＋真的 `close()` 時間窗（`/readyz` 抓過才有窗）。**零憑證、零外部連線**。
 *
 * 突變（各自單獨做，做完還原，結果記在 PR）：
 *
 * 1. `acceptOpenTurn` 不查旗標 → 「/goal <目標>」「/goal resume」紅（目標被建起來／續上、續行輪開跑）。
 * 2. goal 命令的 create 那一格拿掉 `openTurn?.()` → 「/goal <目標>」紅。
 * 3. goal 命令的 resume 那一格拿掉 `openTurn?.()` → 「/goal resume」紅。
 * 4. `stopAdmission` 變成 no-op → 三格都紅。
 *
 * `/goal pause` 在窗內照常（它是人要停下來的路，不開輪）；一輪跑著時 `/goal <目標>`／`edit`／`resume` 本來就被「正在跑」的閘擋掉（#1516 E），
 * 所以真正漏過去的是兩輪之間的狀態；「edit 進行中的目標」那一格由 `command.test.ts` 的命令層測試釘住。
 */

import type { WireClient } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';

import { serveClient } from './fixtures.js';
import type { ScriptedTurn } from './scripted-model.js';
import { startScriptedServe } from './scripted-serve.js';
import type { ScriptedServe } from './scripted-serve.js';

let served: ScriptedServe | undefined;
afterEach(async () => {
  await served?.close();
  served = undefined;
});

const SLOW: ScriptedTurn = { content: '這一輪故意拖得很長。'.repeat(12), tokenDelayMs: 20 };

const DRAIN_ROWS = [
  '- id: ops-endpoints',
  '  config:',
  '    probes:',
  '      drainMs: 3000',
  '',
].join('\n');

async function until(predicate: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`等不到：${what}`);
}

/** 有沒有一輪在跑：用「跑著斜線命令會被擋」這條既有的閘門當探針。 */
async function isBusy(client: WireClient, thread: string): Promise<boolean> {
  const probe = await client.slashRun(thread, '/goal');
  return probe.kind === 'rejected' && probe.message.includes('這條 thread 正在跑');
}

async function goalText(client: WireClient, thread: string): Promise<string> {
  const shown = await client.slashRun(thread, '/goal');
  if (shown.kind !== 'success') throw new Error(`/goal 讀不到：${JSON.stringify(shown)}`);
  return shown.text ?? '';
}

async function start() {
  served = await startScriptedServe([SLOW, SLOW, SLOW], { extraRows: DRAIN_ROWS });
  const client = await serveClient(served.running);
  // 抓過 /readyz 才有時間窗（沒人抓就不等）。
  expect((await fetch(`${served.running.url}/readyz`)).status).toBe(200);
  return { client, running: served.running };
}

describe('窗內：/goal 不開輪、不寫日誌', () => {
  it('/goal <目標>：回 server_closing，沒有目標被建起來，續行輪沒有開', async () => {
    const { client, running } = await start();
    const thread = 'goal-closing-create';
    // 對照組：窗前 `/goal` 讀得到「沒有目標」。
    expect(await goalText(client, thread)).toContain('沒有');

    const closing = running.close();
    const refused = await client.slashRun(thread, '/goal 把測試修綠');
    expect(refused).toMatchObject({ kind: 'rejected', code: 'server_closing' });
    // 給排程器（setImmediate）足夠的時間：目標若建起來了，續行輪會在這之內開跑。
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await isBusy(client, thread)).toBe(false);
    expect(await goalText(client, thread)).toContain('沒有');
    await closing;
  });

  it('/goal resume：回 server_closing，目標仍是暫停，續行輪沒有開；/goal pause 照常', async () => {
    const { client, running } = await start();
    const thread = 'goal-closing-resume';
    // 窗前：建目標、續行輪開跑、暫停。
    expect(await client.slashRun(thread, '/goal 把測試修綠')).toMatchObject({ kind: 'success' });
    await until(() => isBusy(client, thread), '續行輪開跑');
    expect(await client.slashRun(thread, '/goal pause')).toMatchObject({ kind: 'success' });
    await until(async () => !(await isBusy(client, thread)), '暫停之後閒下來');
    expect(await goalText(client, thread)).toContain('狀態：暫停');

    const closing = running.close();
    const refused = await client.slashRun(thread, '/goal resume');
    expect(refused).toMatchObject({ kind: 'rejected', code: 'server_closing' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await isBusy(client, thread)).toBe(false);
    expect(await goalText(client, thread)).toContain('狀態：暫停');
    await closing;
  });

  it('/goal pause：窗內照常成功（不開輪的命令不受影響）', async () => {
    const { client, running } = await start();
    const thread = 'goal-closing-pause';
    expect(await client.slashRun(thread, '/goal 把測試修綠')).toMatchObject({ kind: 'success' });
    await until(() => isBusy(client, thread), '續行輪開跑');

    const closing = running.close();
    expect(await client.slashRun(thread, '/goal pause')).toMatchObject({ kind: 'success' });
    await until(async () => !(await isBusy(client, thread)), '暫停之後閒下來');
    expect(await goalText(client, thread)).toContain('狀態：暫停');
    await closing;
  });
});

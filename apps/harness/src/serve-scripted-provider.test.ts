/**
 * **在真的 serve 上，用 patch 換掉模型提供者，跑一條自訂的工具回合**——[#670](https://github.com/DemianLi/nexus-agent/issues/670)
 * 的產品路徑驗收。
 *
 * 做法照 dsh 的 headless e2e（`apps/cli/tests/profiles/headless/tests/source-tool.built.e2e.ts:36-42`）：一份 patch
 * `insert` 一列腳本提供者（`#settings/scripted-model`，腳本是它的 config）、再把 `agent-default-model` 指過去。整條路是
 * 真的——`runServe` 讀 patch、每條 thread 的 `createCliAgent` 解析選擇列、真的 `present` 工具、真的 wire handler——
 * 唯一換掉的是模型。
 *
 * 這一條同時補上一個以前沒有觀察點的接線：`serve.ts` 把 `deliverableLimits` 交給 handler。`CLI_SCRIPT` 一次都不呼叫
 * `present`，所以拔掉那一行全樹照樣綠（`deliverable-files.test.ts` 的 #536 註解量過）；現在腳本模型叫一次 `present`，
 * 上限調小的那一組讀不動，對照組（預設上限）讀得到。
 *
 * 突變（量過）：`serve.ts` 刪掉 `deliverableLimits,` → 「上限調小」那一條紅（讀到了，沒被拒）。
 *
 * **零憑證、零外部連線**：模型是腳本，工作區是暫存目錄。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PRESENT_TOOL_NAME } from '@nexus/plugin-present';
import { createDeliverableClient } from '@nexus/wire';
import type { DeliverableReadResult, DeliverablesEntry } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';

import { exchangeServeToken, fetchWithCookie, foldTurn, serveClient } from './fixtures.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';

const THREAD = 'scripted-provider';

/** 單行 200 個位元組：頁的位元組上限調到 64 時，按行切一定 too-large。 */
const BIG_LINE = `${'x'.repeat(199)}\n`;

const roots: string[] = [];
let running: RunningServe | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** 起一台 serve（patch 換掉提供者）、跑一輪 `present`，回那顆交付第 0 個檔的 `deliverable.read` 結果。 */
async function presentThenRead(deliverableFilesPatch: string): Promise<DeliverableReadResult> {
  const dir = await mkdtemp(join(tmpdir(), 'nexus-scripted-provider-'));
  roots.push(dir);
  await writeFile(join(dir, 'big.md'), BIG_LINE, 'utf8');
  const patch = join(dir, 'scripted.patch.yml');
  await writeFile(
    patch,
    `- insert:
    - id: probe-script
      name: '#settings/scripted-model'
      config:
        turns:
          - content: '交付。'
            toolCalls:
              - { name: ${PRESENT_TOOL_NAME}, args: { files: [{ path: big.md }] } }
          - content: '交付好了。'
- id: agent-default-model
  config:
    provider: probe-script
${deliverableFilesPatch}`,
    'utf8',
  );
  running = (await runServe({
    argv: ['--port', '0', '--workspace', dir, '--patch', patch],
    log: () => undefined,
    env: {},
  })) as RunningServe;
  const client = await serveClient(running);
  const events = await client.openEvents(THREAD);
  await client.runStart(THREAD, '交付吧。');
  const state = await foldTurn(events);
  await events.return?.(undefined);
  const presented = state.entries.find(
    (entry): entry is DeliverablesEntry => entry.kind === 'deliverables',
  );
  // 前提：腳本真的被用上了——模型叫了 `present`，線上有交付卡。換不掉提供者的話這裡就沒有。
  if (presented === undefined) throw new Error('這一輪沒有交付卡：腳本提供者沒有被選上');

  const cookie = await exchangeServeToken(running.authenticatedUrl);
  const read = await createDeliverableClient({
    baseUrl: running.url,
    fetch: fetchWithCookie(cookie),
  }).read(THREAD, { seq: presented.seq, index: 0 });
  if (read.kind !== 'ok') throw new Error(`被載體層擋下：${read.message}`);
  return read.result;
}

describe('serve：patch 換掉提供者之後，腳本回合跑在真的組裝上', () => {
  it('對照：預設的交付上限讀得到那一頁', async () => {
    const result = await presentThenRead('');
    expect(result.ok).toBe(true);
  }, 60000);

  it('上限調小：同一個檔，頁的位元組上限生效，讀不動', async () => {
    const result = await presentThenRead(`- id: deliverable-files
  config:
    maxBytes: 64
`);
    if (result.ok) throw new Error('上限調成 64 位元組，卻讀到了 200 位元組的那一行');
    expect(result.error.code).toBe('deliverable/too-large');
  }, 60000);
});

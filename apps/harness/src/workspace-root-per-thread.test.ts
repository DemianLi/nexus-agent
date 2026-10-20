/**
 * **可寫根是逐條 thread 取得的**（[#1774](https://github.com/DemianLi/nexus-agent/issues/1774)）：真的 `runServe`、真的 HTTP、出貨的組裝，
 * 「thread → 可寫根」那一支換成 A 回 X、B 回 Y（兩個都跟 `--workspace` 的根 D 不同）。
 *
 * **為什麼從 `runServe` 起量**（#1427）：手搭 `createAgent` 的測試自己把根傳進組裝，拿掉 `serve.ts` 那一行接線也不會紅。這一檔每一格都從產品入口讀出來：
 *
 * | 格 | 怎麼讀 |
 * | --- | --- |
 * | backend 的 `rootDir` | 腳本模型 `write_file` 寫一個檔，看它落在哪個目錄 |
 * | 交付錨（`ThreadState.workspaceRoot`） | `present` 一個只在 X／Y 裡的檔，走 wire 的 `deliverable.read` 讀回內容 |
 * | `@` 檔案搜尋的根 | wire 的 `fileReferences`，候選只有這條 thread 的根底下的檔 |
 * | 寫進 header 的 `workspaceRoot` | 讀落盤的 header JSON |
 * | host 服務 `workspaceRoot`（`FsService.workspaceRoot()`） | `/permission` 不帶引數報的可寫根 |
 *
 * 突變（各自單獨做，結果記在 PR）：
 *
 * 1. `assembly-root.ts` 讀根那一行改回 `resolveWorkspaceRoot(invocation.workspace, cwd)`（不用入口交來的）→ 上面每一格 B 都變成 D，紅。
 * 2. `serve.ts` 的 `createAgent` 不把 `workspaceRoot` 傳進 `assembly.create` → 同上。
 * 3. 續接守衛改回比 `--workspace` 的根 → 「續接守衛跟這條 thread 的根比」紅。
 *
 * **零憑證、零外部連線**：模型是腳本，目錄都在 `/var/tmp`。
 */

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { PRESENT_TOOL_NAME } from '@nexus/plugin-present';
import { createDeliverableClient } from '@nexus/wire';
import type { DeliverablesEntry } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';

import { exchangeServeToken, fetchWithCookie, foldTurn, serveClient } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';

const roots: string[] = [];
let running: RunningServe | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function scratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(join('/var/tmp', prefix));
  roots.push(dir);
  return dir;
}

/** 腳本：第一輪寫一個檔，第二輪交付 `probe.md`，第三輪收尾。 */
const SCRIPT = `- insert:
    - id: probe-script
      name: '#settings/scripted-model'
      config:
        turns:
          - content: ''
            toolCalls:
              - { name: write_file, args: { file_path: /written.txt, content: 寫了 } }
          - content: '交付。'
            toolCalls:
              - { name: ${PRESENT_TOOL_NAME}, args: { files: [{ path: probe.md }] } }
          - content: '好了。'
- id: agent-default-model
  config:
    provider: probe-script
`;

interface Fixture {
  readonly home: string;
  readonly launch: string;
  readonly x: string;
  readonly y: string;
}

/** 三個目錄：`--workspace` 的 D，與 A、B 各自的根 X、Y；X、Y 各有 `probe.md` 與只有自己有的檔。 */
async function fixture(): Promise<Fixture> {
  const home = await scratch('nexus-root-per-thread-home-');
  const launch = await scratch('nexus-root-per-thread-d-');
  const x = await scratch('nexus-root-per-thread-x-');
  const y = await scratch('nexus-root-per-thread-y-');
  await mkdir(join(x, 'src'));
  await writeFile(join(x, 'probe.md'), 'X-CONTENT', 'utf8');
  await writeFile(join(x, '/only-x.txt'), 'x', 'utf8');
  await writeFile(join(y, 'probe.md'), 'Y-CONTENT', 'utf8');
  await writeFile(join(y, '/only-y.txt'), 'y', 'utf8');
  return { home, launch, x, y };
}

async function start(fx: Fixture, rootOf: (threadId: string) => string | undefined) {
  const patch = join(fx.home, '..', `${fx.home.split('/').pop()}.patch.yml`);
  roots.push(patch);
  await writeFile(patch, SCRIPT, 'utf8');
  running = (await runServe({
    argv: ['--port', '0', '--workspace', fx.launch, '--patch', patch],
    log: () => undefined,
    env: { [HARNESS_HOME_ENV]: fx.home },
    workspaceRootOf: rootOf,
  })) as RunningServe;
  return running;
}

/** 跑完一條 thread 的腳本回合，回線上的交付卡。 */
async function runScript(server: RunningServe, thread: string): Promise<DeliverablesEntry> {
  const client = await serveClient(server);
  const events = await client.openEvents(thread);
  await client.runStart(thread, '開始。');
  const state = await foldTurn(events);
  await events.return?.(undefined);
  const presented = state.entries.find(
    (entry): entry is DeliverablesEntry => entry.kind === 'deliverables',
  );
  if (presented === undefined) throw new Error(`${thread} 這一輪沒有交付卡：腳本提供者沒有被選上`);
  return presented;
}

async function headerOf(home: string, thread: string): Promise<{ workspaceRoot?: string }> {
  const names = await readdir(home, { recursive: true });
  const found = names.find((name) => name.endsWith(`${thread}.header.json`));
  if (found === undefined) throw new Error(`找不到 ${thread} 的 header`);
  return JSON.parse(await readFile(join(home, found), 'utf8')) as { workspaceRoot?: string };
}

describe('可寫根逐條 thread：A 回 X、B 回 Y（兩個都不是 --workspace 的 D）', () => {
  it('backend、交付錨、檔案搜尋、header、/permission 每一格 A 都是 X、B 都是 Y', async () => {
    const fx = await fixture();
    const server = await start(fx, (thread) => (thread === 'a' ? fx.x : fx.y));
    const presentedA = await runScript(server, 'a');
    const presentedB = await runScript(server, 'b');

    // backend 的 rootDir：模型寫的檔落在各自的根；D 一個檔都沒有。
    expect(await readFile(join(fx.x, 'written.txt'), 'utf8')).toBe('寫了');
    expect(await readFile(join(fx.y, 'written.txt'), 'utf8')).toBe('寫了');
    expect(await readdir(fx.launch)).toEqual([]);

    // 交付錨：讀得回各自根底下的 probe.md。
    const cookie = await exchangeServeToken(server.authenticatedUrl);
    const deliverables = createDeliverableClient({
      baseUrl: server.url,
      fetch: fetchWithCookie(cookie),
    });
    const readA = await deliverables.read('a', { seq: presentedA.seq, index: 0 });
    const readB = await deliverables.read('b', { seq: presentedB.seq, index: 0 });
    expect(JSON.stringify(readA)).toContain('X-CONTENT');
    expect(JSON.stringify(readB)).toContain('Y-CONTENT');
    expect(JSON.stringify(readB)).not.toContain('X-CONTENT');

    // `@` 檔案搜尋的根。
    const client = await serveClient(server);
    const names = async (thread: string) => {
      const outcome = await client.fileReferences(thread, '');
      if (outcome.kind !== 'ok' || !outcome.result.available) throw new Error('列檔失敗');
      return outcome.result.candidates.map((candidate) => candidate.path);
    };
    const namesA = await names('a');
    const namesB = await names('b');
    expect(namesA).toContain('/only-x.txt');
    expect(namesA).not.toContain('/only-y.txt');
    expect(namesB).toContain('/only-y.txt');
    expect(namesB).not.toContain('/only-x.txt');

    // header 記的根。
    expect((await headerOf(fx.home, 'a')).workspaceRoot).toBe(fx.x);
    expect((await headerOf(fx.home, 'b')).workspaceRoot).toBe(fx.y);

    // host 服務 `workspaceRoot`（`FsService.workspaceRoot()`）：`/permission` 報這條 thread 的根。
    const reportA = JSON.stringify(await client.slashRun('a', '/permission'));
    const reportB = JSON.stringify(await client.slashRun('b', '/permission'));
    expect(reportA).toContain(fx.x);
    expect(reportA).not.toContain(fx.y);
    expect(reportB).toContain(fx.y);
    expect(reportB).not.toContain(fx.x);
  }, 120000);
});

describe('續接守衛跟這條 thread 的根比，不跟 --workspace 的 D 比', () => {
  it('header 記 X、這一次函式回 X：接得回來；回 Z：擋下，訊息指名 X 與 Z', async () => {
    const fx = await fixture();
    const other = await scratch('nexus-root-per-thread-z-');
    const first = await start(fx, () => fx.x);
    await runScript(first, 'a');
    // 前提：header 真的記了 X（沒記的日誌照設計放行，下面證不了東西）。
    expect((await headerOf(fx.home, 'a')).workspaceRoot).toBe(fx.x);
    await first.close();
    running = undefined;

    // header 記 X、函式回 X（≠ D）：守衛放行。若守衛比的是 `--workspace` 的 D，這裡會被擋。
    const same = await start(fx, () => fx.x);
    const resumed = await (await serveClient(same)).slashRun('a', '/permission');
    expect(resumed).not.toMatchObject({ kind: 'rejected' });
    expect(JSON.stringify(resumed)).toContain(fx.x);
    await same.close();
    running = undefined;

    // header 記 X、函式回 Z：擋下。
    const changed = await start(fx, () => other);
    const refused = await (await serveClient(changed)).slashRun('a', '/permission');
    expect(refused).toMatchObject({ kind: 'rejected' });
    expect(JSON.stringify(refused)).toContain(fx.x);
    expect(JSON.stringify(refused)).toContain(other);
  }, 120000);
});

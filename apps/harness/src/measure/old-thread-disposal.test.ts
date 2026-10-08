/**
 * 只給新對話更新時，仍在用舊版插件的 thread 能不能被處置——[#1138](https://github.com/DemianLi/nexus-agent/issues/1138)。
 *
 * 三個問題，各量一遍**今天的**行為（不是理想行為），整理在 `.docs/old-thread-disposal-2026-10-08.md`：
 *
 * 1. **能不能列出誰在用某一版？** 能，但只有一條路：讀落盤 header 的 `plugins` 清單。線上的列表沒有這一格。
 * 2. **能不能讓它們乾淨結束、日誌不壞？** 能：取消之後那一輪正常收尾；直接關機也只留下一份讀得出來的前綴。
 *    但**沒有「這條 thread 退役」這件事**：取消之後同一條 thread 照收新輸入、照用舊版。
 * 3. **換成新版之後 resume，走的是新版嗎？歷史完整嗎？** 走新版、歷史完整；但 header 不更新，所以
 *    第 1 題那條路會把已經換到新版的 thread 繼續列成舊版的使用者。
 *
 * 「新舊並存」在今天只有一種形狀：**兩台 serve 行程**（插件清單在啟動時解析一次，見 `loadDefaultPlugins`），
 * 所以這裡起兩台以上的 `runServe`，各自 `--patch` 一份指向不同版本目錄的清單，共用同一個會話根。
 *
 * 兩版插件是不 import 任何東西的 `.mjs`（夾具在 `/var/tmp`，解析不到 repo 的 node_modules），每次模型請求
 * 往共用的見證檔 append 一行 `{version, shape}`——跨模組實例都看得到，不靠模組層狀態。
 * 「卡住」的那一輪模擬一次進行中的網路呼叫：中止訊號舉起來就中斷，沒有訊號就永遠不回。
 */

import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { foldTurn, serveClient } from '../fixtures.js';
import { openJsonlSessionStore, projectKey } from '../jsonl-session-store.js';
import { runServe } from '../serve.js';
import type { RunningServe } from '../serve.js';

/** 版本 `version` 的插件原始碼：每次模型請求記一行；人話含「卡住」就記 `blocked` 然後等中止訊號。 */
function pluginSource(version: string): string {
  return `
import { appendFileSync } from 'node:fs';
const WITNESS = new URL('../witness.jsonl', import.meta.url);
const log = (line) => appendFileSync(WITNESS, JSON.stringify(line) + '\\n');
export default {
  name: 'versioned-probe',
  apply(registry) {
    registry.middleware.use({
      name: 'VersionedProbe',
      wrapModelCall: async (request, handler) => {
        const shape = request.messages
          .filter((message) => message.getType() !== 'system')
          .map((message) => message.getType() + ':' + message.text);
        log({ version: ${JSON.stringify(version)}, event: 'model', shape });
        const last = shape[shape.length - 1] ?? '';
        if (last.startsWith('human:') && last.includes('卡住')) {
          log({ version: ${JSON.stringify(version)}, event: 'blocked' });
          // 模擬一次進行中的網路呼叫：訊號舉起來就中斷，沒有訊號就永遠不回。
          const signal = request.runtime?.configurable?.nexus_turn_cancel;
          await new Promise((_, reject) => {
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        }
        return handler(request);
      },
    });
  },
};
`;
}

/** 腳本假模型一輪完整跑完，模型下一次會收到的前六則（見 `conversation-restore.test.ts` 的 REMEMBERED）。 */
const ONE_TURN = [
  'ai:先回聲一次，確認工具接得上。',
  'tool:回聲：CLI 接線測試',
  'ai:再寫一個檔，確認檔案系統接得上。',
  "tool:Successfully wrote to '/cli.md'",
  'ai:工具回來了，這條線是通的。',
];

type Witness = { version: string; event: string; shape?: string[] };

describe('仍在用舊版插件的 thread', () => {
  let dir: string;
  let logs: string;
  const servers: RunningServe[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(await realpath('/var/tmp'), 'nexus-old-thread-'));
    logs = join(dir, 'logs');
    await mkdir(logs);
    for (const version of ['v1', 'v2']) {
      await mkdir(join(dir, version));
      await writeFile(join(dir, version, 'plugin.mjs'), pluginSource(version), { mode: 0o600 });
      await writeFile(
        join(dir, `patch-${version}.yml`),
        `- insert:\n    - id: versioned-probe\n      name: ./${version}/plugin.mjs\n`,
        { mode: 0o600 },
      );
    }
    await writeFile(join(dir, 'witness.jsonl'), '');
  });

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close().catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  });

  async function start(version: 'v1' | 'v2'): Promise<RunningServe> {
    const server = await runServe({
      argv: ['--port', '0', '--session-log', logs, '--patch', join(dir, `patch-${version}.yml`)],
      log: () => undefined,
      env: {},
    });
    if (server === undefined) throw new Error('runServe 沒有起來');
    servers.push(server);
    return server;
  }

  async function witness(): Promise<Witness[]> {
    return (await readFile(join(dir, 'witness.jsonl'), 'utf8'))
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Witness);
  }

  /** 說一句話、等這一輪收掉。 */
  async function say(server: RunningServe, threadId: string, prompt: string): Promise<void> {
    const client = await serveClient(server);
    const events = await client.openEvents(threadId);
    await client.runStart(threadId, prompt);
    await foldTurn(events);
    await events.return?.(undefined);
  }

  const store = () => openJsonlSessionStore({ directory: join(logs, projectKey(process.cwd())) });
  const V1 = '/v1/plugin.mjs';
  const V2 = '/v2/plugin.mjs';

  /** header 的插件清單裡，有沒有一列的模組 specifier 以 `suffix` 結尾。 */
  async function usersOf(suffix: string): Promise<string[]> {
    const { sessions } = await store().list({});
    return sessions
      .filter(({ header }) => header.plugins?.some((row) => row.name.endsWith(suffix)))
      .map(({ header }) => header.id)
      .sort();
  }

  async function types(id: string): Promise<string[]> {
    // 嚴格讀：中段壞掉或 seq 不連續會拋——「日誌不壞」的判準就是它讀得完。
    return (await (await store().open(id, 'read')).read()).map((event) => event.type);
  }

  async function until(done: () => Promise<boolean>): Promise<void> {
    for (let i = 0; i < 200; i += 1) {
      if (await done()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('等不到');
  }

  /**
   * 開著 v1 的 server：`old-idle` 跑完一輪；`old-busy` 跑完一輪，第二輪卡在模型呼叫裡。
   * 回來時 v1 已經記下 `blocked`。
   */
  async function seedV1(): Promise<RunningServe> {
    const a = await start('v1');
    await say(a, 'old-idle', '第一句');
    await say(a, 'old-busy', '開場');
    const client = await serveClient(a);
    await client.openEvents('old-busy');
    await client.runStart('old-busy', '卡住了');
    await until(async () => (await witness()).some((w) => w.event === 'blocked'));
    return a;
  }

  it('問題 1：header 的插件清單分得出誰用哪一版；線上的列表分不出', async () => {
    const a = await seedV1();
    const b = await start('v2');
    await say(b, 'new', '新的一句');

    // 落盤那一條路：能列。
    expect(await usersOf(V1)).toEqual(['old-busy', 'old-idle']);
    expect(await usersOf(V2)).toEqual(['new']);

    // 線上的那一條：`running` 是這台 server 自己的、列的卻是整個會話根——a 列得出 b 的 `new`，
    // 而且一格講插件的欄位都沒有。要回答「哪些**活著**的 thread 在用 v1」得自己把兩邊對起來。
    const listed = await (await serveClient(a)).listThreads();
    expect(listed.kind).toBe('ok');
    const items = listed.kind === 'ok' ? listed.result.items : [];
    expect(items.map((item) => item.threadId).sort()).toEqual(['new', 'old-busy', 'old-idle']);
    expect(items.find((item) => item.threadId === 'old-busy')?.running).toBe(true);
    expect(items.find((item) => item.threadId === 'new')?.running).toBe(false);
    for (const item of items) {
      expect(Object.keys(item).filter((key) => /plugin|version/i.test(key))).toEqual([]);
    }
    const live = new Set(items.filter((item) => item.running).map((item) => item.threadId));
    expect((await usersOf(V1)).filter((id) => live.has(id))).toEqual(['old-busy']);
  }, 40_000);

  it('問題 2a：取消之後那一輪正常收尾，關機不再動日誌', async () => {
    const a = await seedV1();
    const client = await serveClient(a);
    expect(await client.runCancel('old-busy')).toMatchObject({ result: { accepted: true } });
    await until(async () => (await types('old-busy')).at(-1) === 'turn/end');

    // 被中斷的那一輪：有開始、有結尾，中間只有模型請求被切斷，沒有回覆。
    const afterCancel = await types('old-busy');
    expect(afterCancel.slice(-3)).toEqual(['model/start', 'model/end', 'turn/end']);

    await a.close();
    expect(await types('old-busy')).toEqual(afterCancel);
  }, 40_000);

  it('問題 2b：取消之後同一條 thread 照收新輸入，而且照用 v1', async () => {
    const a = await seedV1();
    const client = await serveClient(a);
    await client.runCancel('old-busy');
    await until(async () => (await types('old-busy')).at(-1) === 'turn/end');
    const mark = (await witness()).length;

    await say(a, 'old-busy', '取消之後再說一句');

    const later = (await witness()).slice(mark);
    expect(later.length).toBeGreaterThan(0);
    expect(new Set(later.map((w) => w.version))).toEqual(new Set(['v1']));
  }, 40_000);

  it('問題 2c：不取消直接關機，日誌停在進行中的那一輪，仍讀得完', async () => {
    const a = await seedV1();
    await a.close();

    const tail = await types('old-busy');
    // 沒有 `turn/end`：這一輪是被關機切斷的。前面完整的那一輪不受影響。
    expect(tail.at(-1)).toBe('model/start');
    expect(tail.filter((type) => type === 'turn/end')).toHaveLength(1);
    // 另一條已經跑完的沒被牽連。
    expect((await types('old-idle')).at(-1)).toBe('turn/end');
  }, 40_000);

  it('問題 3：換成 v2 之後 resume，走的是 v2、歷史完整；header 不更新', async () => {
    const a = await seedV1();
    await a.close();
    const mark = (await witness()).length;

    const c = await start('v2');
    await say(c, 'old-idle', '接著說');
    await say(c, 'old-busy', '接著說');

    const later = (await witness()).slice(mark);
    // 一次也沒回到 v1。
    expect(new Set(later.map((w) => w.version))).toEqual(new Set(['v2']));

    const firstOf = (needle: string) =>
      later.find((w) => w.event === 'model' && w.shape?.includes(needle))?.shape;
    // 跑完的那條：整段歷史都在模型的第一次請求裡。
    expect(firstOf('human:第一句')).toEqual(['human:第一句', ...ONE_TURN, 'human:接著說']);
    // 被切斷的那條：完整的一輪在，被切斷那一輪的人話也在（模型看到兩句連續的人話）。
    expect(firstOf('human:開場')).toEqual([
      'human:開場',
      ...ONE_TURN,
      'human:卡住了',
      'human:接著說',
    ]);

    // 日誌接著寫：舊的事件原封不動在前面，中間隔一顆 `session/end-seed`。
    const busy = await types('old-busy');
    expect(busy).toContain('session/end-seed');
    expect(busy.indexOf('session/end-seed')).toBeGreaterThan(busy.indexOf('model/start'));

    // header 不更新：這兩條現在跑在 v2 上，卻仍被第 1 題那條路列成 v1 的使用者。
    expect(await usersOf(V1)).toEqual(['old-busy', 'old-idle']);
    expect(await usersOf(V2)).toEqual([]);
  }, 40_000);
});

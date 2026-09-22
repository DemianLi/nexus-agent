/**
 * **「在設定裡覆寫會生效」的驗收**——[#529](https://github.com/DemianLi/nexus-agent/issues/529)
 * 起動期那幾列，[#457](https://github.com/DemianLi/nexus-agent/issues/457) 的五個值（標題兩個、
 * cookie 一個、交付檔三個裡走 `startupSetting` 的那一份）。
 *
 * **交付檔那三個的行為驗收不在這裡**，在 `deliverable-files.test.ts`：那條線要有一個宣告過的
 * 交付檔才看得見，而 serve 的假模型腳本一次都不呼叫 `present`。這裡只驗它讀得出來。
 *
 * 這一組**不驗那兩個數字本身**（那是 `browser-auth.test.ts` 與 `serve-session-list.test.ts` 的事），
 * 只驗**那條線通不通**：出貨清單 → `--patch` → `startupSetting` → 真的 serve 上的行為。
 *
 * **為什麼要有它**：起動期那兩格沒有服務可讀，值是解出來之後**用參數往下傳**的
 * （`settings/startup.ts` 的檔頭）。一條用參數傳的線天生沒有觀察點——把 `serve.ts` 那兩個
 * `startupSetting(...)` 換回寫死的常數，除了這一組以外全樹不會有任何東西紅，而部署寫在 patch
 * 裡的值會安靜地沒有作用。所以這裡的每一條都是**兩臂**：同一台 serve，只差有沒有那份 patch。
 *
 * **零憑證、零外部連線**：模型是出貨清單裡的假模型，session log 落在暫存目錄。
 */

import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendHumanTurn, emptyConversation, reduceConversation } from '@nexus/wire';
import type { ConversationState } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';

import { serveClient } from '../fixtures.js';
import { loadDefaultPlugins } from '../plugin-config.js';
import { runServe } from '../serve.js';
import type { RunningServe } from '../serve.js';
import { sessionPersistencePlugin } from '@nexus/core';

import { browserSessionPlugin, DEFAULT_BROWSER_SESSION_MAX_AGE_DAYS } from './browser-session.js';
import {
  deliverableFilesPlugin,
  DEFAULT_DELIVERABLE_MAX_FILE_BYTES,
  DEFAULT_DELIVERABLE_MAX_LINES,
  DEFAULT_DELIVERABLE_MAX_PAGE_BYTES,
} from './deliverable-files.js';
import { startupSetting } from './startup.js';
import { toolTextPlugin } from './tool-text.js';
import { DEFAULT_THREAD_TITLE_MAX_WORDS, threadTitlePlugin } from './thread-title.js';

const OVERRIDE_PATCH = 'src/settings/settings-override.patch.yml';
const DISABLED_PATCH = 'src/settings/settings-disabled.patch.yml';
/** 夠長，裁到 6 個位元組一定看得出來。 */
const PROMPT = 'abcdefghij 這一句話當標題。';

let running: RunningServe | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function start(extra: readonly string[] = []): Promise<RunningServe> {
  running = (await runServe({
    argv: ['--port', '0', ...extra],
    log: () => undefined,
    env: {},
  })) as RunningServe;
  return running;
}

async function stop(server: RunningServe): Promise<void> {
  await server.close();
  running = undefined;
}

/** 換 token，回原始的 `set-cookie`（`exchangeServeToken` 只回名字=值，這裡要 `Max-Age`）。 */
async function rawSetCookie(server: RunningServe): Promise<string> {
  const response = await fetch(server.authenticatedUrl, { redirect: 'manual' });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie === null) throw new Error(`token 交換失敗：${response.status}`);
  return setCookie;
}

/** 跑完一整輪，讓那份日誌有第一句話可以當標題。同 `serve-session-list.test.ts` 那一份。 */
async function driveTurn(server: RunningServe, threadId: string): Promise<void> {
  const client = await serveClient(server);
  const events = await client.openEvents(threadId);
  await client.runStart(threadId, PROMPT);
  let state: ConversationState = appendHumanTurn(emptyConversation(), PROMPT);
  while (state.status === 'running') {
    const next = await events.next();
    if (next.done === true) break;
    state = reduceConversation(state, next.value);
  }
  await events.return?.(undefined);
}

/**
 * 那個 `--session-log` 根底下所有 `.jsonl` 的事件行數合計。
 *
 * **只數 `.jsonl`**：`.lock`（租約）與 `.header.json`（表頭）在第一顆事件之前就存在了，
 * 數進去的話兩臂都非零，這條測試會永遠綠。實測過：窗口還沒到期時目錄裡只有 `.lock`。
 */
async function countPersistedEvents(root: string): Promise<number> {
  let total = 0;
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith('.jsonl')) {
        const text = await readFile(path, 'utf8');
        total += text.split('\n').filter((line) => line !== '').length;
      }
    }
  }
  await walk(root);
  return total;
}

describe('設定覆寫在真的 serve 上生效（#529）', () => {
  it('cookie 有效期：帶 patch 的那台是 1 天，不帶的是預設 30 天', async () => {
    const bare = await start();
    const bareCookie = await rawSetCookie(bare);
    await stop(bare);
    // 前提：對照組真的是 schema 的預設值換算來的。沒有這一行，下面那句可能只是「兩台不一樣」。
    expect(bareCookie).toContain(
      `Max-Age=${String(DEFAULT_BROWSER_SESSION_MAX_AGE_DAYS * 24 * 60 * 60)}`,
    );

    const patched = await start(['--patch', OVERRIDE_PATCH]);
    expect(await rawSetCookie(patched)).toContain('Max-Age=86400');
  });

  it('標題上限：帶 patch 的那台裁到 6 個位元組，不帶的是完整的第一句話', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-settings-'));

    // **寫的那一台先收掉再列。** 落盤是排空的（`DEFAULT_PERSISTENCE_WINDOW_MS`），同一台 server
    // 上跑完一輪就馬上列，機器忙的時候讀到的是還沒寫進去的空標題——量過：單跑綠、整包紅。
    // 關掉那一台才是「那一輪真的落地了」的判準，同 `serve-session-list.test.ts`。
    const writer = await start(['--session-log', root]);
    await driveTurn(writer, 'alpha');
    await stop(writer);

    const bare = await start(['--session-log', root]);
    const bareList = await (await serveClient(bare)).listThreads();
    await stop(bare);
    if (bareList.kind !== 'ok') throw new Error('列不出來');
    const bareTitle = bareList.result.items[0]?.title ?? '';
    // 前提：預設上限（40 位元組）底下這句話是**完整**的。不然兩臂的差別證不了是 patch 造成的。
    expect(bareTitle).toBe(PROMPT);

    const patched = await start(['--session-log', root, '--patch', OVERRIDE_PATCH]);
    const patchedList = await (await serveClient(patched)).listThreads();
    if (patchedList.kind !== 'ok') throw new Error('列不出來');
    const patchedTitle = patchedList.result.items[0]?.title ?? '';
    // **同一份日誌**（同一個 `--session-log` 根、同一條 thread，第二台一個位元組都沒寫），
    // 所以兩臂的差別只可能來自那份 patch。
    expect(Buffer.byteLength(patchedTitle, 'utf8')).toBeLessThanOrEqual(6);
    expect(patchedTitle).not.toBe(bareTitle);
  });

  it('落盤窗口：帶 patch 的那台等 300 毫秒還沒寫，不帶的早就寫完了', async () => {
    // **這一條量的是時序，不是回傳值**，所以兩臂各要一個乾淨的根：判準是「這個目錄裡有沒有
    // 事件」。同一個根會讓第一臂寫的東西變成第二臂的假陽性。
    //
    // **窗口從第一顆事件開始算，不是從這一輪結束開始算**（協調器的檔頭：第一顆待處理事件開窗、
    // 後續事件不重置截止時間）。所以安全邊際是 3000 減掉 `driveTurn` 自己花的時間再減 300
    // ——實測一輪的事件在 50 毫秒內就落盤完畢，邊際約十倍。
    const bareRoot = await mkdtemp(join(tmpdir(), 'nexus-window-bare-'));
    const bare = await start(['--session-log', bareRoot]);
    await driveTurn(bare, 'alpha');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const bareEvents = await countPersistedEvents(bareRoot);
    await stop(bare);
    // 前提：預設窗口（10 毫秒）底下這段等待**綽綽有餘**。沒有這一行，下面那句「另一臂是 0」
    // 可能只是因為根本沒有人在寫。
    expect(bareEvents).toBeGreaterThan(0);

    const patchedRoot = await mkdtemp(join(tmpdir(), 'nexus-window-patched-'));
    const patched = await start(['--session-log', patchedRoot, '--patch', OVERRIDE_PATCH]);
    await driveTurn(patched, 'alpha');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const patchedEvents = await countPersistedEvents(patchedRoot);
    // **讀完才收。** `close()` 會 dispose 每一份協調器，而 dispose 排空——收掉之後再讀，
    // 兩臂都會是滿的，這條測試就廢了。
    await stop(patched);
    expect(patchedEvents).toBe(0);
  });

  it('把只講設定的那一列關掉：載入期就失敗，不是一行警告', async () => {
    await expect(start(['--patch', DISABLED_PATCH])).rejects.toThrow(/thread-title/u);
  });
});

describe('startupSetting', () => {
  it('清單上沒有那一列：回 schema 的預設值', () => {
    expect(startupSetting([], threadTitlePlugin).maxWords).toBe(DEFAULT_THREAD_TITLE_MAX_WORDS);
    expect(startupSetting([], browserSessionPlugin).maxAgeDays).toBe(
      DEFAULT_BROWSER_SESSION_MAX_AGE_DAYS,
    );
    expect(startupSetting([], deliverableFilesPlugin)).toEqual({
      maxBytes: DEFAULT_DELIVERABLE_MAX_PAGE_BYTES,
      maxFileBytes: DEFAULT_DELIVERABLE_MAX_FILE_BYTES,
      maxLines: DEFAULT_DELIVERABLE_MAX_LINES,
    });
  });

  it('那一列的 config 不合法：當場拋，訊息指名是哪一列', () => {
    expect(() =>
      startupSetting(
        [{ plugin: threadTitlePlugin, id: 'thread-title', config: { maxBytes: -1 } }],
        threadTitlePlugin,
      ),
    ).toThrow(/thread-title/u);
  });

  it('出貨清單上真的讀得到那四列——不是只有手搭的清單走得通', async () => {
    const plugins = await loadDefaultPlugins({ env: {} });
    expect(startupSetting(plugins, threadTitlePlugin).maxBytes).toBe(40);
    expect(startupSetting(plugins, browserSessionPlugin).maxAgeDays).toBe(30);
    // **字面值，不是那三個常數**：出貨那一列與 schema 的預設今天是同一個數字，兩邊都讀常數的話
    // 改掉常數兩邊一起動，這一條就再也分不出「那一列在講話」與「那一列不見了」。
    expect(startupSetting(plugins, deliverableFilesPlugin)).toEqual({
      maxBytes: 2097152,
      maxFileBytes: 33554432,
      maxLines: 5000,
    });
    // 字面值，理由同上一段：10 同時是出貨那一列、schema 的預設、以及協調器自己的退路。
    expect(startupSetting(plugins, sessionPersistencePlugin).windowMs).toBe(10);
  });

  it('CLI 那條也解出那一列，而且真的傳給落盤——結構性的，因為沒有行為觀察點', async () => {
    // **這一條是退路，不是首選。** CLI 那一跳量不到行為：`runCli` 回來之前一定會
    // `persistence.dispose()`（`cli.ts:1455`、`:1468`），而 dispose 排空——跑完再看檔案，
    // 不管窗口是 10 還是 3000，兩臂都是滿的。同 #536 `serve.ts → handler` 那一跳的處境。
    //
    // 所以這裡釘的是原始碼：那兩行在不在。突變驗過——任一行拿掉這條就紅。
    const source = await readFile(new URL('../cli.ts', import.meta.url), 'utf8');
    // 掃空也會綠的防呆：先證明這個檔真的讀得到、而且那個呼叫真的在裡面。
    const callAt = source.indexOf('attachSessionPersistence(sessions, sessionStore, {');
    expect(callAt).toBeGreaterThan(0);
    // **釘的是那個賦值，不只是那次呼叫。** 只比對 `startupSetting(plugins, …)` 在不在的話，
    // 一個「照樣呼叫、但把結果丟掉、改用 schema 預設」的改動照樣綠——而那正好會讓清單上
    // 那一列對 CLI 這條路靜靜失效。
    expect(source).toContain(
      'persistenceWindow = startupSetting(plugins, sessionPersistencePlugin)',
    );
    const call = source.slice(callAt);
    expect(call.slice(0, call.indexOf('});'))).toContain('windowMs: persistenceWindow.windowMs');
  });

  it('serve 起動期解出工具文字那一列，而且真的傳給 handler——結構性的', async () => {
    // **同 `deliverable-files` 那一條的處境**（#536）：`serve.ts → createWireHandler` 這一跳
    // 沒有行為觀察點——產品路徑上的假模型只會 echo 一句十幾個位元組的話，造不出一段會被
    // 300 位元組上限截到的工具結果。實測過：把 `serve.ts` 那一行拿掉，全套 1243 條全綠。
    //
    // 所以這裡釘原始碼。**handler 往下那兩跳有真的行為測試**（`serve-history.test.ts` 走 route、
    // `tool-card-from-log.test.ts` 走即時），紅的分工因此是：那兩條管轉發，這一條管接線。
    const source = await readFile(new URL('../serve.ts', import.meta.url), 'utf8');
    expect(source).toContain('toolTextLimits = startupSetting(plugins, toolTextPlugin)');
    const call = source.slice(source.indexOf('createWireHandler({'));
    expect(call.slice(0, call.indexOf('createAgent'))).toContain('toolTextLimits,');
  });

  it('handler 把工具文字那一格轉給即時那條——結構性的', async () => {
    // **重播那一跳有行為測試**（`serve-history.test.ts` 走真的 route），**即時這一跳沒有**：
    // handler 的即時路徑要經過 SSE，而這棵樹上走那條路的假 agent 都不產生夠長的工具結果。
    // 實測過：把 `new ThreadPump(...)` 的那一格拿掉，全套 1246 條全綠。
    //
    // **`ThreadPump` 用得到那個值本身有行為證據**（`tool-card-from-log.test.ts` 那條驗即時與
    // 重播截在同一個位置），所以這裡缺的只有「handler 真的傳」這一格，釘原始碼剛好補它。
    const source = await readFile(new URL('../wire-handler.ts', import.meta.url), 'utf8');
    // **錨點要指到真的呼叫，不是講到它的散文。** 第一版用 `new ThreadPump(`，命中的是那個
    // 選項自己的檔頭裡「即時那條走 `new ThreadPump(...)`」那句，往後掃到的第一個 `);` 中間
    // 正好包著 `readonly toolTextLimits?`——於是它**永遠綠**。突變抓到的。
    const at = source.indexOf('const pump = new ThreadPump(');
    expect(at).toBeGreaterThan(0);
    expect(source.slice(at, source.indexOf(');', at))).toContain('toolTextLimits,');
  });

  it('工具文字上限低於 schema 的下限：載入期就失敗', () => {
    // **釘的是 schema 那條 `min(128)`**，不是 `capToolText` 的行為（那條在
    // `tool-result-text.test.ts`）。少了這一條，把下限放寬到 1 不會有任何東西紅。
    expect(() =>
      startupSetting(
        [{ plugin: toolTextPlugin, id: 'tool-text', config: { maxBytes: 127 } }],
        toolTextPlugin,
      ),
    ).toThrow(/tool-text/u);
  });

  it('落盤窗口超過計時器收得住的上限：載入期就失敗', () => {
    // **這個方向的壞值長得像「把落盤調得很懶」，實際上是窗口消失**——`setTimeout` 對超出 32
    // 位元的延遲立刻觸發，於是每一顆事件各寫一次。所以它必須在載入期就紅，不能等到執行期
    // 靜靜變成最勤的那一種。
    expect(() =>
      startupSetting(
        [
          {
            plugin: sessionPersistencePlugin,
            id: 'session-persistence',
            config: { windowMs: 2_147_483_648 },
          },
        ],
        sessionPersistencePlugin,
      ),
    ).toThrow(/session-persistence/u);
  });
});

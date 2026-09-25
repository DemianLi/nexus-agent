/**
 * `serve` 那條路上的會話日誌落盤——[#174](https://github.com/DemianLi/nexus-agent/issues/174)。
 *
 * CLI 那半在 [`session-log-durability.test.ts`](./session-log-durability.test.ts)，
 * 上游那半在 `@nexus/core` 的 `session-persistence.test.ts`。這一檔只問 `serve` 獨有的
 * 三件事，而三件都不是 CLI 那條路上存在的問題：
 *
 * 1. **一個專案目錄一格、一條 thread 一個檔，重開 server 之後接得回來。** 會話根按目錄分
 *    （照 dsh 的 `projectDir(root, cwd)`，[#251](https://github.com/DemianLi/nexus-agent/issues/251)
 *    拍板的第 3 件），檔名就是 thread id，所以同一條 thread 重開之後找得回自己那一份。CLI 的
 *    root 固定叫 `cli`，放在固定的地方會每次都撞，所以它仍然每次一個 run 目錄。
 * 2. **thread id 是呼叫端給的。** 它會出現在檔名裡，所以兩個壓平後同名的 id 必須落成
 *    兩個檔——不然第二條 thread 的日誌會安靜地消失（`jsonl-session-store.ts` 的
 *    `safeBaseName`）。
 * 3. **披露那一行**：一台正在把每一條 thread 的對話寫上磁碟的 server，畫面上要看得出來。
 */

import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appendHumanTurn,
  createWireClient,
  deliverableFilePath,
  emptyConversation,
  reduceConversation,
} from '@nexus/wire';
import type { ConversationState } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';
import { openJsonlSessionStore, projectKey } from './jsonl-session-store.js';
import { SESSION_LOG_OFF_DISCLOSURE } from './cli.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';
import { SESSION_LOG_FORMAT_VERSION } from '@nexus/core';
import type { SessionEvent } from '@nexus/core';
import { exchangeServeToken, fetchWithCookie, serveClient } from './fixtures.js';

let running: RunningServe | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function tmp(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/** 會話根底下，這個專案的那一格。`runServe` 沒給 `cwd`，所以是這個行程的。 */
function projectDirOf(root: string): string {
  return join(root, projectKey(process.cwd()));
}

/** 會話根底下只有這個專案那一格，回它。 */
async function onlyProjectDir(root: string): Promise<string> {
  expect(await readdir(root)).toEqual([projectKey(process.cwd())]);
  return projectDirOf(root);
}

/**
 * 跑完一整輪，讓 `turn/start` 與 `turn/end` 都落地。
 *
 * 折疊器的 `status` 是收線條件——同 `serve.test.ts` 那條，理由也一樣：這一層沒有
 * 「這一輪完了」的單一封包，有的是折出來的狀態。
 */
async function driveTurn(server: RunningServe, threadId: string): Promise<void> {
  const client = await serveClient(server);
  const events = await client.openEvents(threadId);
  const prompt = '把這句話回聲一次。';
  await client.runStart(threadId, prompt);
  let state: ConversationState = appendHumanTurn(emptyConversation(), prompt);
  while (state.status === 'running') {
    const next = await events.next();
    if (next.done === true) break;
    state = reduceConversation(state, next.value);
  }
  await events.return?.(undefined);
}

/**
 * 打一次交付預覽路由，座標固定在 `seq 0`——**接回來的 thread 上，`seq 0` 一定在續接線以下**。
 *
 * 回的是那一次拒絕的文字：兩條路都是 404，分得開它們的只有訊息
 * （[#519](https://github.com/DemianLi/nexus-agent/issues/519)）。
 *
 * @param server - 正在跑的那台。
 * @param threadId - 哪一條 thread。
 * @returns 那一次拒絕的文字。
 */
async function deliverableRefusal(server: RunningServe, threadId: string): Promise<string> {
  const cookie = await exchangeServeToken(server.authenticatedUrl);
  const withCookie = fetchWithCookie(cookie);
  // **拿歷史就把 thread 建起來了**，`ready` 有它，路由才問得到錨（同 `deliverable-files.test.ts`）。
  const page = await createWireClient({ baseUrl: server.url, fetch: withCookie }).threadHistory(
    threadId,
  );
  if (page.kind !== 'ok') throw new Error(`歷史拿不到：${page.message}`);
  const response = await withCookie(`${server.url}${deliverableFilePath(threadId)}?seq=0&index=0`, {
    method: 'GET',
    headers: { 'content-type': 'application/json' },
  });
  expect(response.status).toBe(404);
  return response.text();
}

function readEvents(body: string): readonly SessionEvent[] {
  return body
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as SessionEvent);
}

describe('serve 的 --session-log', () => {
  it('每條 thread 一個檔，seq 各自從 0 連續', async () => {
    const root = await tmp('nexus-serve-log-');
    running = await runServe({
      argv: ['--port', '0', '--session-log', root],
      log: () => undefined,
      env: {},
    });
    const started = running as RunningServe;
    await driveTurn(started, 'alpha');
    await driveTurn(started, 'beta');
    // 收線會排空並關檔——落盤的驗收只有在 `close()` 之後才成立。
    await started.close();
    running = undefined;

    const runDir = await onlyProjectDir(root);
    const files = (await readdir(runDir)).filter((name) => name.endsWith('.jsonl')).sort();
    expect(files).toEqual(['alpha.jsonl', 'beta.jsonl']);

    for (const file of files) {
      const events = readEvents(await readFile(join(runDir, file), 'utf8'));
      expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index));
      expect(events.map((event) => event.type)).toContain('turn/start');
      expect(events.map((event) => event.type)).toContain('turn/end');
    }
  });

  it('header 記的是 thread id', async () => {
    const root = await tmp('nexus-serve-log-');
    running = await runServe({
      argv: ['--port', '0', '--session-log', root],
      log: () => undefined,
      env: {},
    });
    const started = running as RunningServe;
    await driveTurn(started, 'gamma');
    await started.close();
    running = undefined;

    const runDir = await onlyProjectDir(root);
    const header = JSON.parse(await readFile(join(runDir, 'gamma.header.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(header.id).toBe('gamma');
    expect(header.parentSession).toBeUndefined();
  });

  /**
   * **這一條擋的是把 `wx` 誤當成護欄。**
   *
   * `thread id` 從 `/threads/:id/...` 進來，是呼叫端給的。舊的壓平規則把每個不在
   * `[A-Za-z0-9._-]` 裡的字元換成 `_`，而 `~` 在 URL 路徑段裡是合法的 unreserved
   * 字元——於是 `a~b` 與 `a_b`（線上兩條不同的 thread）壓成同一個檔名，第二條的第一次
   * 寫入撞上 `open(..., 'wx')` 而失敗。**而協調器按設計吞掉那個失敗**（暫停自動路徑、
   * 一行 warn），所以那條 thread 的日誌就這麼沒了，沒有人會發現。
   *
   * `wx` 那條拒絕是留給「未來的 resume 誤開了已存的會話」的絆索
   * （`session-store.ts` 檔頭），不是拿來擋這個的。
   */
  it('壓平後同名的兩條 thread 各自落成一個檔', async () => {
    const root = await tmp('nexus-serve-log-');
    running = await runServe({
      argv: ['--port', '0', '--session-log', root],
      log: () => undefined,
      env: {},
    });
    const started = running as RunningServe;
    await driveTurn(started, 'a~b');
    await driveTurn(started, 'a_b');
    await started.close();
    running = undefined;

    const runDir = await onlyProjectDir(root);
    const files = (await readdir(runDir)).filter((name) => name.endsWith('.jsonl'));
    expect(files).toHaveLength(2);
    // 兩個檔都真的有內容——「開得起來」與「寫得進去」是兩件事。
    for (const file of files) {
      expect(readEvents(await readFile(join(runDir, file), 'utf8')).length).toBeGreaterThan(0);
    }
  });

  /**
   * **翻面來的**（#444）：以前這裡守「沒給旗標就什麼都不落盤」。照 dsh 改成預設落在 harness home
   * 底下的 `sessions` 之後，同一個位置改守「沒給就寫進那裡，畫面上講得出那一格」。
   *
   * `env: {}` 沒有 `NEXUS_AGENT_HOME`，所以走的是 `~/.nexus-agent` 那條退路——`HOME` 由
   * `test-home.setup.ts` 逐條換成暫存目錄，這裡當場再確認一次。
   */
  it('沒給旗標就寫進 harness home 底下的 sessions，畫面上講得出那一格', async () => {
    expect(homedir().startsWith(tmpdir())).toBe(true);
    const root = join(homedir(), '.nexus-agent', 'sessions');
    const lines: string[] = [];
    running = await runServe({
      argv: ['--port', '0'],
      log: (line) => lines.push(line),
      env: {},
    });
    await driveTurn(running as RunningServe, 'delta');
    await (running as RunningServe).close();
    running = undefined;

    expect(lines.join('\n')).toContain(`會話日誌：${projectDirOf(root)}`);
    expect(lines.join('\n')).not.toContain('只在記憶體裡');
    const runDir = await onlyProjectDir(root);
    expect(readEvents(await readFile(join(runDir, 'delta.jsonl'), 'utf8')).length).toBeGreaterThan(
      0,
    );
  });

  it('NEXUS_AGENT_HOME 給了就落在它底下', async () => {
    const home = await tmp('nexus-serve-home-');
    const lines: string[] = [];
    running = await runServe({
      argv: ['--port', '0'],
      log: (line) => lines.push(line),
      env: { [HARNESS_HOME_ENV]: home },
    });
    expect(lines.join('\n')).toContain(`會話日誌：${projectDirOf(join(home, 'sessions'))}`);
  });

  it('預設的根落在 --workspace 底下時起不來，訊息講得出怎麼繞', async () => {
    const workspace = await tmp('nexus-serve-ws-');
    await expect(
      runServe({
        argv: ['--port', '0', '--workspace', workspace],
        log: () => undefined,
        env: { [HARNESS_HOME_ENV]: join(workspace, 'home') },
      }),
    ).rejects.toThrow(/預設的會話日誌目錄.*不能在 --workspace 底下.*--session-log/su);
  });

  it('給了旗標就把落腳處印出來', async () => {
    const root = await tmp('nexus-serve-log-');
    const lines: string[] = [];
    running = await runServe({
      argv: ['--port', '0', '--session-log', root],
      log: (line) => lines.push(line),
      env: {},
    });
    // 印的要是**那一格**，不只是根：根是那一格的前綴，斷言根的話印哪一個都綠。
    expect(lines.join('\n')).toContain(`會話日誌：${projectDirOf(root)}`);
  });

  it('--session-log 不能落在 --workspace 底下', async () => {
    const workspace = await tmp('nexus-serve-ws-');
    await expect(
      runServe({
        argv: ['--port', '0', '--workspace', workspace, '--session-log', join(workspace, 'logs')],
        log: () => undefined,
        env: {},
      }),
    ).rejects.toThrow('--session-log 不能在 --workspace 底下');
  });

  it('--session-log 給空字串是錯的，不是「沒給」', async () => {
    await expect(
      runServe({ argv: ['--port', '0', '--session-log', '  '], log: () => undefined, env: {} }),
    ).rejects.toThrow('--session-log 要給一個目錄路徑');
  });
});

/** 把落盤那一列關掉的夾具（#612）。 */
const PERSISTENCE_OFF_PATCH = fileURLToPath(
  new URL('./settings/persistence-off.patch.yml', import.meta.url),
);

/**
 * 清單把落盤關掉（[#612](https://github.com/DemianLi/nexus-agent/issues/612)），serve 那一半。照 dsh
 * 不掛 `session-persistence-jsonl`：一條 thread 都不寫、列表列不出來、以前寫過的也不接回來。
 */
describe('serve：清單把落盤關掉', () => {
  it('跑完一輪 sessions 底下什麼都沒有，畫面講只在記憶體裡，列表回列不出來', async () => {
    expect(homedir().startsWith(tmpdir())).toBe(true);
    const lines: string[] = [];
    const server = (await runServe({
      argv: ['--port', '0', '--patch', PERSISTENCE_OFF_PATCH],
      log: (line) => lines.push(line),
      env: {},
    })) as RunningServe;
    running = server;
    await driveTurn(server, 'delta');
    const listed = await (await serveClient(server)).listThreads();
    await server.close();
    running = undefined;

    expect(lines.join('\n')).toContain(SESSION_LOG_OFF_DISCLOSURE);
    expect(listed.kind).toBe('rejected');
    expect(listed.kind === 'rejected' && listed.message).toContain('session-persistence');
    // home 會有（瀏覽器會話的密鑰住在那裡），**`sessions` 不會**。
    await expect(readdir(join(homedir(), '.nexus-agent', 'sessions'))).rejects.toThrow();
  });

  it('以前寫過的 thread 不接回來，那個檔一個位元組都沒動', async () => {
    // **兩台都用預設的根**——同一個家、同一格。第一台用 `--session-log` 的話，第二台根本不看那裡，
    // 落盤沒關也碰不到那個檔，這一條就永遠綠。
    const first = (await runServe({
      argv: ['--port', '0'],
      log: () => undefined,
      env: {},
    })) as RunningServe;
    running = first;
    await driveTurn(first, 'echo');
    await first.close();
    const path = join(projectDirOf(join(homedir(), '.nexus-agent', 'sessions')), 'echo.jsonl');
    const before = await readFile(path, 'utf8');

    const second = (await runServe({
      argv: ['--port', '0', '--patch', PERSISTENCE_OFF_PATCH],
      log: () => undefined,
      env: {},
    })) as RunningServe;
    running = second;
    await driveTurn(second, 'echo');
    await second.close();
    running = undefined;
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('--session-log 跟它矛盾：起不來', async () => {
    const root = join(await tmp('nexus-serve-log-'), 'not-yet');
    await expect(
      runServe({
        argv: ['--port', '0', '--patch', PERSISTENCE_OFF_PATCH, '--session-log', root],
        log: () => undefined,
        env: {},
      }),
    ).rejects.toThrow(/--session-log 跟設定矛盾.*session-persistence/su);
    await expect(readdir(root)).rejects.toThrow();
  });

  it('預設的根落在 --workspace 底下也起得來：關掉的時候根本不解析它', async () => {
    const workspace = await tmp('nexus-serve-ws-');
    const lines: string[] = [];
    running = await runServe({
      argv: ['--port', '0', '--patch', PERSISTENCE_OFF_PATCH, '--workspace', workspace],
      log: (line) => lines.push(line),
      env: { [HARNESS_HOME_ENV]: join(workspace, 'home') },
    });
    expect(lines.join('\n')).toContain(SESSION_LOG_OFF_DISCLOSURE);
  });
});

/**
 * 重開 server、同一條 thread——serve 那一半的續接（照 dsh：碰到一個已存的 session id 就
 * resume）。回來的是日誌上推得出來的，對話也從日誌推回模型（門 B 照舊不開；那一半的驗收在
 * `conversation-restore.test.ts`）。
 *
 * **失敗的那幾條都要斷言兩件事**：這條 thread 起不來，而且檔案一個位元組都沒動。只斷言
 * 前一件的話，「退到新開、撞上 `wx`、被收成一行 warn」那條路一樣起不來——而那正是要擋的
 * 靜默遺失。
 */
describe('重開 server 之後接得回同一條 thread', () => {
  async function start(root: string, extra: readonly string[] = []): Promise<RunningServe> {
    running = await runServe({
      argv: ['--port', '0', '--session-log', root, ...extra],
      log: () => undefined,
      env: {},
    });
    return running as RunningServe;
  }

  async function stop(server: RunningServe): Promise<void> {
    await server.close();
    running = undefined;
  }

  function count(events: readonly SessionEvent[], type: string): number {
    return events.filter((event) => event.type === type).length;
  }

  it('同一個 thread id：同一個檔接著寫，seq 連續，中間只有一顆 end-seed', async () => {
    const root = await tmp('nexus-serve-resume-');
    const first = await start(root);
    await driveTurn(first, 'alpha');
    await stop(first);
    const second = await start(root);
    await driveTurn(second, 'alpha');
    await stop(second);

    const dir = await onlyProjectDir(root);
    expect((await readdir(dir)).filter((name) => name.endsWith('.jsonl'))).toEqual(['alpha.jsonl']);
    const events = readEvents(await readFile(join(dir, 'alpha.jsonl'), 'utf8'));
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index));
    expect(count(events, 'session/end-seed')).toBe(1);
    expect(count(events, 'turn/start')).toBe(2);
  });

  it('日誌壞了：這條 thread 起不來，檔案一個位元組都沒動', async () => {
    const root = await tmp('nexus-serve-resume-');
    const first = await start(root);
    await driveTurn(first, 'alpha');
    await stop(first);
    const log = join(projectDirOf(root), 'alpha.jsonl');
    const lines = (await readFile(log, 'utf8')).split('\n');
    lines[0] = '{壞的';
    await writeFile(log, lines.join('\n'));
    const before = await readFile(log, 'utf8');

    const second = await start(root);
    await expect(driveTurn(second, 'alpha')).rejects.toThrow();
    await stop(second);
    expect(await readFile(log, 'utf8')).toBe(before);
  });

  it('別的把手握著：起不來；它放了之後同一台 server 重試接得回來', async () => {
    const root = await tmp('nexus-serve-resume-');
    const first = await start(root);
    await driveTurn(first, 'alpha');
    await stop(first);
    const holder = await openJsonlSessionStore({ directory: projectDirOf(root) }).resume('alpha');

    const second = await start(root);
    await expect(driveTurn(second, 'alpha')).rejects.toThrow();
    await holder.stored.close();
    await driveTurn(second, 'alpha');
    await stop(second);

    const events = readEvents(await readFile(join(projectDirOf(root), 'alpha.jsonl'), 'utf8'));
    expect(count(events, 'turn/start')).toBe(2);
  });

  /**
   * **租約在失敗時放掉了。** 目錄比對在讀回之後、已經拿了租約；擋下之後沒放的話，同一台
   * server 下一次請求（`wire-handler.ts` 說好的重試）撞上的是自己上一次留下的租約。
   */
  it('目錄對不上：擋下；改回來之後同一台 server 重試接得回來', async () => {
    const root = await tmp('nexus-serve-resume-');
    const first = await start(root);
    await driveTurn(first, 'alpha');
    await stop(first);
    const headerPath = join(projectDirOf(root), 'alpha.header.json');
    const good = await readFile(headerPath, 'utf8');
    await writeFile(headerPath, JSON.stringify({ ...JSON.parse(good), cwd: '/別的地方' }));
    const log = join(projectDirOf(root), 'alpha.jsonl');
    const before = await readFile(log, 'utf8');

    const second = await start(root);
    await expect(driveTurn(second, 'alpha')).rejects.toThrow();
    expect(await readFile(log, 'utf8')).toBe(before);
    await writeFile(headerPath, good);
    await driveTurn(second, 'alpha');
    await stop(second);
  });

  /**
   * **第二道守衛也接在 serve 上**（[#504](https://github.com/DemianLi/nexus-agent/issues/504)）。
   *
   * 這一條要單獨存在的理由：`cwd` 那一格在這裡**全程一樣**（`runServe` 沒給 `cwd`，兩台
   * server 都是這個行程的目錄），所以上面那條目錄守衛從頭到尾放行——紅起來的只可能是工作區
   * 那一道。只在 CLI 那側測的話，「serve 也接上了」這個宣稱會無聲失效。
   *
   * 租約那一半同上一條：擋下之後要放掉，同一台 server 換回對的根才重試得了。
   */
  it('換了 --workspace：擋下；換回來之後同一台 server 重試接得回來', async () => {
    const root = await tmp('nexus-serve-resume-');
    const workspace = await tmp('nexus-serve-resume-ws-');
    const other = await tmp('nexus-serve-resume-ws2-');
    const first = await start(root, ['--workspace', workspace]);
    await driveTurn(first, 'alpha');
    await stop(first);
    // 前提：header 真的記了那一格。沒記的日誌照設計是放行的，下面那句證不了東西。
    const headerPath = join(projectDirOf(root), 'alpha.header.json');
    expect(JSON.parse(await readFile(headerPath, 'utf8')).workspaceRoot).toBe(workspace);
    const log = join(projectDirOf(root), 'alpha.jsonl');
    const before = await readFile(log, 'utf8');

    const second = await start(root, ['--workspace', other]);
    await expect(driveTurn(second, 'alpha')).rejects.toThrow();
    expect(await readFile(log, 'utf8')).toBe(before);
    // **訊息要活著到瀏覽器那端**（卡上寫的是「訊息指名兩個根」）。只斷言「拋了」的話，有人
    // 把 `threadOrError` 的錯包成一句通用的「thread 不可用」，這一條照樣綠，而多人共用主機上
    // 的維運者失去唯一改得動的線索。形狀同下面那條沙箱檢查：協定層回 `rejected`，不是拋。
    const refused = await (await serveClient(second)).slashRun('alpha', '/sandbox');
    expect(refused).toMatchObject({ kind: 'rejected' });
    expect(JSON.stringify(refused)).toContain(workspace);
    expect(JSON.stringify(refused)).toContain(other);
    await stop(second);

    const third = await start(root, ['--workspace', workspace]);
    await driveTurn(third, 'alpha');
    await stop(third);
    expect(count(readEvents(await readFile(log, 'utf8')), 'turn/start')).toBe(2);
  });

  /**
   * **`serve.ts` 把 header 記的工作區根轉交給路由那一行，唯一的觀察點**
   * （[#519](https://github.com/DemianLi/nexus-agent/issues/519)）。`deliverable-files.test.ts`
   * 那一組全部自己手搭 `createAgent`、直接交那一格，所以拔掉 `serve.ts` 那三行它一條都不紅，
   * 而真的 serve 上每一顆重播的交付都會 404——跟 `workspaceRoot` 當初量到的是同一個病。
   *
   * **兩條臂只差 header 有沒有那一格**，其餘一個位元組都不動；兩條都是 404，分得開它們的只有
   * 訊息。順帶把「判準是那一格在不在，不是 `version >= 13`」釘在產品路徑上：第二臂跑完之後
   * 那份 header 的 `version` 已經被續接覆寫成今天這一版，而那一格仍然不在。
   */
  it('接回來之後線以下那些的錨：header 記著就錨得住，沒記就拒——判準不是 version', async () => {
    const root = await tmp('nexus-serve-resume-');
    const workspace = await tmp('nexus-serve-resume-ws-');
    const first = await start(root, ['--workspace', workspace]);
    await driveTurn(first, 'alpha');
    await stop(first);
    const headerPath = join(projectDirOf(root), 'alpha.header.json');
    // 前提：第一次真的把那一格寫下去了。沒有這一條，下面兩臂的對比證不了東西。
    expect(JSON.parse(await readFile(headerPath, 'utf8')).workspaceRoot).toBe(workspace);

    // 第一臂：header 記著根。錨過得了，於是問得到下一道閘——那個 seq 上沒有交付宣告。
    const second = await start(root, ['--workspace', workspace]);
    expect(await deliverableRefusal(second, 'alpha')).toContain('沒有交付宣告');
    await stop(second);

    // 第二臂：把那一格拿掉（13 以前的日誌就長這樣），其餘原封不動。
    const { workspaceRoot: dropped, ...rest } = JSON.parse(
      await readFile(headerPath, 'utf8'),
    ) as Record<string, unknown>;
    expect(dropped).toBe(workspace);
    await writeFile(headerPath, JSON.stringify(rest));

    const third = await start(root, ['--workspace', workspace]);
    expect(await deliverableRefusal(third, 'alpha')).toContain('header 沒記工作區根');
    await stop(third);

    // **續接把 version 覆寫成今天這一版，那一格仍然不在。** 照版本號判的實作會在上一句放行，
    // 然後拿這一次的 `--workspace` 去讀一個沒人驗證過的錨——靜默錯檔，剛好是 #504 存在的理由。
    const rewritten = JSON.parse(await readFile(headerPath, 'utf8')) as Record<string, unknown>;
    expect(rewritten['version']).toBe(SESSION_LOG_FORMAT_VERSION);
    expect(rewritten).not.toHaveProperty('workspaceRoot');
  });

  it('沙箱模式跟著回來；日誌記著模式而這一次沒給 --workspace：擋下', async () => {
    const root = await tmp('nexus-serve-resume-');
    const workspace = await tmp('nexus-serve-resume-ws-');
    const first = await start(root, ['--workspace', workspace]);
    const client = await serveClient(first);
    await client.slashRun('alpha', '/sandbox read-only');
    await stop(first);

    const bare = await start(root);
    // 建不起這條 thread 是協定層的錯（`wire-handler.ts` 的 `threadOrError`）：斜線命令回
    // `rejected`，不是拋。原因要講到 `--workspace`——那是人唯一改得動的東西。
    const refused = await (await serveClient(bare)).slashRun('alpha', '/sandbox');
    expect(refused).toMatchObject({ kind: 'rejected' });
    expect(JSON.stringify(refused)).toContain('--workspace');
    await stop(bare);

    const second = await start(root, ['--workspace', workspace]);
    const reported = await (await serveClient(second)).slashRun('alpha', '/sandbox');
    await stop(second);
    // 前提：預設是 workspace-write，所以看得到 read-only 才證明是從日誌回來的。
    expect(JSON.stringify(reported)).toContain('read-only');
  });
});

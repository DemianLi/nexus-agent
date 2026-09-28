/**
 * 設定檔接線：**兩條進入點都真的走 `cordis.yml` 那條路**。
 *
 * 跟 [`invariant-paths.test.ts`](./invariant-paths.test.ts) 與
 * [`session-telemetry-paths.test.ts`](./session-telemetry-paths.test.ts) 是同一型的檔案：
 * 漏接任何一邊都不會有型別錯誤，只會靜靜地少掉一整層設定——而「我的 patch 沒有生效」在
 * 畫面上跟「我的 patch 寫錯了」長得一模一樣。
 *
 * **判準是「壞掉的那一層會讓啟動失敗」，不是「好的那一層看起來有生效」。** 一個沒有被讀
 * 的檔案不會讓任何東西失敗，所以讓它壞給我們看，是唯一能證明它真的被讀了的辦法；反過來
 * 的那一半（`[]` 照樣跑得完）也在，否則這些測試只證明了「永遠會失敗」。
 *
 * **測試碰不到真的 `~/.nexus-agent`**：`test-home.setup.ts` 每個測試檔換一個暫存 home，而且
 * 連 `HOME` 一起換、當場 assert `homedir()` 真的變了（#424）。`runCli` 傳 `env: {}` 的那些
 * 測試靠的就是那一半——沒有它，`resolveHarnessHome({})` 會退回開發者真的家目錄。
 *
 * @see [#454](https://github.com/DemianLi/nexus-agent/issues/454)
 */

import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { BROWSER_SESSION_SECRET_FILE } from './browser-session-secret.js';
import { createCliAgent, parseCliArgs, runCli } from './cli.js';
import { serveClient, foldTurn } from './fixtures.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { LIVE_API_KEY_ENV } from './live-model.js';
import { toAgentInvocation } from './messages.js';
import { loadDefaultPlugins } from './plugin-config.js';
import { ScriptedChatModel } from './scripted-model.js';
import { parseServeArgs, runServe } from './serve.js';
import type { RunningServe } from './serve.js';

const temporary: string[] = [];
let running: RunningServe | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

function privateHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'nexus-wire-home-'));
  temporary.push(root);
  chmodSync(root, 0o700);
  return root;
}

function writePatch(root: string, name: string, content: string): string {
  const path = join(root, name);
  writeFileSync(path, content);
  chmodSync(path, 0o600);
  return path;
}

/**
 * 一條合法但**值**不合法的 patch：`todo` 的 `allowParallelInProgress` 只收布林。
 *
 * 讀完清單時逐列驗設定，驗不過的那一列掉了（#751）：`todo` 是可少掛的，所以兩個入口都起得來、
 * 啟動時印一段警告指名它。**那段警告就是「這一層被讀了」的證據**：沒被讀的檔不會讓任何一列掉。
 */
const BAD_CONFIG = "- id: todo\n  config:\n    allowParallelInProgress: '不是布林'\n";

/**
 * 一條**形狀**就不合法的 patch：條目沒有 `inject` 這個欄位。
 *
 * 它是 `composeEntries` 在讀檔的當下就擋下來的，所以**兩個入口都適用**——包括 serve，
 * 它的 agent 是每條 thread 才組的。
 */
const BAD_SHAPE = '- id: todo\n  inject: [x]\n';

function silent(): {
  input: PassThrough;
  output: PassThrough;
  printer: Parameters<typeof runCli>[0]['printer'];
} {
  return {
    input: new PassThrough(),
    output: new PassThrough(),
    printer: { log: () => undefined, error: () => undefined },
  };
}

describe('--patch 的解析（兩個入口同一份規則）', () => {
  it('可以給多次，順序照命令列', () => {
    expect(parseCliArgs(['--patch', 'a.yml', '--patch', 'b.yml', '說點什麼']).patches).toEqual([
      'a.yml',
      'b.yml',
    ]);
    expect(parseServeArgs(['--patch', 'a.yml', '--patch', 'b.yml']).patches).toEqual([
      'a.yml',
      'b.yml',
    ]);
  });

  it('沒給就沒有那一格', () => {
    expect(parseCliArgs(['說點什麼']).patches).toBeUndefined();
    expect(parseServeArgs([]).patches).toBeUndefined();
  });

  it('空字串是打錯了，不是「不指定」', () => {
    expect(() => parseCliArgs(['--patch', ''])).toThrow(/--patch/u);
    expect(() => parseServeArgs(['--patch', ''])).toThrow(/--patch/u);
  });

  /**
   * **`--plugins` 拿掉了，而「拿掉」要是會講話的**（[#455](https://github.com/DemianLi/nexus-agent/issues/455)）。
   *
   * 靜靜忽略一個曾經存在的旗標是最壞的那種相容：那個人以為自己換掉了整份清單，實際上跑的是
   * 出貨清單，而畫面看起來一模一樣。`parseArgs` 的 strict 模式會把它當成不認得的旗標拒絕——
   * 這一條釘的是**那件事真的發生**，不是「選項表裡沒有它」（後者刪掉判準也不會紅）。
   *
   * 舊的兩條互斥規則（`--patch 不能配 --plugins`、`--dump-config 不能配 --plugins`）由這一條
   * 取代：沒有那個旗標，就沒有東西要互斥。
   */
  it('--plugins 已經沒有了，給了就當不認得的旗標拒絕', () => {
    expect(() => parseCliArgs(['--plugins', 'x.ts'])).toThrow(/--plugins[\s\S]*用法/u);
    expect(() => parseServeArgs(['--plugins', 'x.ts'])).toThrow(/--plugins[\s\S]*用法/u);
    // 配著 --patch 給也一樣：拒絕的理由是旗標不存在，不是兩個旗標打架。
    expect(() => parseCliArgs(['--patch', 'a.yml', '--plugins', 'x.ts'])).toThrow(/--plugins/u);
    expect(() => parseServeArgs(['--patch', 'a.yml', '--plugins', 'x.ts'])).toThrow(/--plugins/u);
  });
});

/** 跑一次 CLI，回它印到標準錯誤的每一行。 */
async function cliErrors(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<string[]> {
  const errors: string[] = [];
  await runCli({
    argv: [...argv],
    env,
    input: new PassThrough(),
    output: new PassThrough(),
    printer: { log: () => undefined, error: (line) => errors.push(line) },
  });
  return errors;
}

/** 警告裡指名 `todo` 掉在設定驗證的那一行。 */
const TODO_DROPPED = /^ {2}todo（@nexus\/plugin-todo）設定驗不過：/u;

describe('CLI 真的走設定檔那條路', () => {
  it('home 那一層的 `todo` 設定寫壞了：起得來、標準錯誤有一段警告指名它——證明那一層被讀了', async () => {
    const home = privateHome();
    writePatch(home, 'cordis.patch.yml', BAD_CONFIG);

    const errors = await cliErrors(['說點什麼'], { [HARNESS_HOME_ENV]: home });
    expect(errors[0]).toBe('警告：1 列沒有掛上，其餘照樣起來：');
    expect(errors.filter((line) => TODO_DROPPED.test(line))).toHaveLength(1);
  });

  it('--patch 那一層也一樣', async () => {
    const home = privateHome();
    const patch = writePatch(home, 'bad.yml', BAD_CONFIG);

    const errors = await cliErrors(['--patch', patch, '說點什麼'], { [HARNESS_HOME_ENV]: home });
    expect(errors.filter((line) => TODO_DROPPED.test(line))).toHaveLength(1);
  });

  /**
   * **掉了就是沒掛**：跟 `runCli` 同一條載入、同一支 `createCliAgent`，看模型拿到的工具清單。對照組是沒寫壞的同一份，
   * `todo_write` 在——不然「沒有」可能只是這個量法本來就看不到它。
   */
  it('掉了的 `todo` 不在模型拿到的工具清單上；對照：沒寫壞就在', async () => {
    const boundTools = async (env: NodeJS.ProcessEnv): Promise<readonly string[]> => {
      const { plugins } = await loadDefaultPlugins({ env });
      const built = await createCliAgent({ live: false }, plugins);
      try {
        await built.agent.invoke(toAgentInvocation('說點什麼'), {
          configurable: { thread_id: 'wire' },
        });
        return (built.model as ScriptedChatModel).boundToolNames;
      } finally {
        await built.dispose();
      }
    };
    const home = privateHome();
    expect(await boundTools({ [HARNESS_HOME_ENV]: home })).toContain('todo_write');
    writePatch(home, 'cordis.patch.yml', BAD_CONFIG);
    expect(await boundTools({ [HARNESS_HOME_ENV]: home })).not.toContain('todo_write');
  });

  it('--patch 指到不存在的檔就拋——是呼叫方指名它的', async () => {
    const home = privateHome();
    await expect(
      runCli({
        argv: ['--patch', join(home, '沒這個檔.yml'), '說點什麼'],
        env: { [HARNESS_HOME_ENV]: home },
        ...silent(),
      }),
    ).rejects.toThrow(/沒這個檔\.yml/u);
  });

  it('別人動得了的 patch 檔就拒絕啟動', async () => {
    const home = privateHome();
    const patch = writePatch(home, 'open.yml', '[]\n');
    chmodSync(patch, 0o666);

    await expect(
      runCli({
        argv: ['--patch', patch, '說點什麼'],
        env: { [HARNESS_HOME_ENV]: home },
        ...silent(),
      }),
    ).rejects.toThrow(/可寫/u);
  });

  it('反面：兩層都是 `[]` 的時候照樣跑得完', async () => {
    const home = privateHome();
    writePatch(home, 'cordis.patch.yml', '[]\n');
    const patch = writePatch(home, 'empty.yml', '[]\n');

    await expect(
      runCli({
        argv: ['--patch', patch, '說點什麼'],
        env: { [HARNESS_HOME_ENV]: home },
        ...silent(),
      }),
    ).resolves.not.toThrow();
  });

  it('home 那一層不在就是沒有那一層，不是失敗', async () => {
    const home = privateHome();
    await expect(
      runCli({ argv: ['說點什麼'], env: { [HARNESS_HOME_ENV]: home }, ...silent() }),
    ).resolves.not.toThrow();
  });
});

/**
 * serve 那一半：讀檔與形狀那一層（`BAD_SHAPE`），是 `composeEntries` 在開機當下做的，整份起不來。
 *
 * 值那一層（`BAD_CONFIG`）是一列自己的失敗：讀完清單時就驗、那一列掉了、照樣起來（#751），見下一組。
 */
describe('serve 也真的走設定檔那條路', () => {
  // **兩個入口各釘一條，不是只釘一個然後說「另一邊一樣」。** 兩條路各自呼叫一次
  // `loadDefaultPlugins`，只接一邊是型別過得去的改法。
  it('home 那一層壞掉就起不來', async () => {
    const home = privateHome();
    writePatch(home, 'cordis.patch.yml', BAD_SHAPE);

    await expect(
      runServe({ argv: ['--port', '0'], log: () => undefined, env: { [HARNESS_HOME_ENV]: home } }),
    ).rejects.toThrow(/inject/u);
  });

  it('--patch 壞掉也起不來', async () => {
    const home = privateHome();
    const patch = writePatch(home, 'bad.yml', BAD_SHAPE);

    await expect(
      runServe({
        argv: ['--port', '0', '--patch', patch],
        log: () => undefined,
        env: { [HARNESS_HOME_ENV]: home },
      }),
    ).rejects.toThrow(/inject/u);
  });

  it('別人動得了的 patch 檔也讓 serve 起不來', async () => {
    const home = privateHome();
    const patch = writePatch(home, 'open.yml', '[]\n');
    chmodSync(patch, 0o666);

    await expect(
      runServe({
        argv: ['--port', '0', '--patch', patch],
        log: () => undefined,
        env: { [HARNESS_HOME_ENV]: home },
      }),
    ).rejects.toThrow(/可寫/u);
  });
});

/**
 * **serve 在綁 port 之前先照每條 thread 那一次組一份 agent**（#749），清單上哪一列壞了在啟動時就講，
 * 跟 CLI 同一刻、同一句。dsh 在 `boot()` 就掛完整份清單（dsh `packages/boot/app-boot/README.zh.md:92`，`477b4f4`）。
 *
 * 報了之後起不起得來照 #751 的必掛名單：設定驗不過的 `todo`、`apply` 裡才驗的 `tool-result-pruner` 都是可少掛的，
 * 啟動時印警告、照樣起來。
 */
describe('serve 在啟動時就把清單組過一次', () => {
  /**
   * 卡上的驗收：同一份壞設定，serve 起得來、綁 port 之前伺服器日誌有**跟 CLI 同一段**警告，而且只印那一次——開兩條對話
   * 都不再印。「綁 port 之前」量的是順序：警告排在印網址那一行前面，而網址那一行是 `listen` 之後才印的。
   */
  it('值不合法的設定：serve 起得來，綁 port 之前印跟 CLI 同一段警告，開兩條對話也只印那一次', async () => {
    const home = privateHome();
    writePatch(home, 'cordis.patch.yml', BAD_CONFIG);
    const env = { [HARNESS_HOME_ENV]: home };
    const cli = await cliErrors(['說點什麼'], env);

    const lines: string[] = [];
    const server = (await runServe({
      argv: ['--port', '0'],
      log: (line) => lines.push(line),
      env,
    })) as RunningServe;
    running = server;
    const client = await serveClient(server);
    for (const thread of ['a', 'b']) {
      const events = await client.openEvents(thread);
      await client.runStart(thread, '說點什麼');
      await foldTurn(events);
      await events.return?.(undefined);
    }

    const warning = lines.filter((line) => line.startsWith('警告：') || TODO_DROPPED.test(line));
    expect(warning).toEqual(cli);
    const url = lines.findIndex((line) => line.includes(server.url));
    expect(url).toBeGreaterThan(lines.indexOf(cli[0] ?? ''));
    // 啟動那幾行裡的「plugin：」不列掉了的列。
    const listed = lines.find((line) => line.startsWith('plugin：'));
    expect(listed).not.toMatch(/[：、]todo(、|$)/u);
    expect(listed).toMatch(/[：、]plan-mode(、|$)/u);
  });

  /**
   * **`apply` 裡才驗的值也在啟動時報出來**，組裝那一次判定（#751）：那一列掉了、照樣起來，兩個入口印同一段警告，serve
   * 那段在綁 port 之前（排在網址那一行前面）。
   */
  it('`apply` 裡才驗的值：設定格式過得了、`apply` 拋的那一類也在啟動時報出來，那一列掉了、照樣起來', async () => {
    // 頭＋標記＋尾不能大於門檻，這條檢查刻意只放在 `apply` 裡（`tool-result-pruner.ts`），不在設定格式裡。
    const home = privateHome();
    writePatch(
      home,
      'cordis.patch.yml',
      '- id: tool-result-pruner\n  config:\n    thresholdChars: 10\n',
    );
    const env = { [HARNESS_HOME_ENV]: home };
    const cli = await cliErrors(['說點什麼'], env);
    expect(cli).toHaveLength(2);
    expect(cli[0]).toBe('警告：1 列沒有掛上，其餘照樣起來：');
    expect(cli[1]).toMatch(
      /^ {2}tool-result-pruner（@nexus\/core\/tool-result-pruner）掛上時失敗：.*apply 失敗/u,
    );

    const lines: string[] = [];
    const server = (await runServe({
      argv: ['--port', '0'],
      log: (line) => lines.push(line),
      env,
    })) as RunningServe;
    running = server;
    const start = lines.indexOf(cli[0] ?? '');
    expect(lines.slice(start, start + 2)).toEqual(cli);
    expect(lines.findIndex((line) => line.includes(server.url))).toBeGreaterThan(start);
    expect(lines.find((line) => line.startsWith('plugin：'))).not.toMatch(
      /[：、]tool-result-pruner(、|$)/u,
    );
  });

  /**
   * **檢查排在建瀏覽器會話密鑰之前**：起不來的那一次，home 底下沒有密鑰檔。用「`--live` 而環境裡沒有金鑰」測，
   * 因為它壞在組裝本身、不是某一列的設定，#751 合了之後照樣起不來，這條不會跟著翻。
   *
   * **`.env` 一個字都不讀**：金鑰缺的時候 `loadLiveEnvIfNeeded` 會去讀 repo 根目錄的 `.env`，在有那份檔的工作樹上
   * 會讀到真的金鑰，而且檔案裡其他的變數也會一起留在這個測試行程裡（`vi.unstubAllEnvs` 只還原 stub 過的那一格）。
   * 所以把 `process.loadEnvFile` 換成什麼都不做，並斷言它被叫過：走的是缺金鑰那條路，只是沒讀檔。
   */
  it('`--live` 沒有金鑰：起不來、講缺哪一個，密鑰檔還沒建；對照：有金鑰就起得來、密鑰檔建了', async () => {
    const home = privateHome();
    const env = { [HARNESS_HOME_ENV]: home };
    const secret = join(home, BROWSER_SESSION_SECRET_FILE);

    const loadEnvFile = vi.spyOn(process, 'loadEnvFile').mockImplementation(() => undefined);
    vi.stubEnv(LIVE_API_KEY_ENV, '');
    await expect(
      runServe({ argv: ['--port', '0', '--live'], log: () => undefined, env }),
    ).rejects.toThrow(`缺少環境變數 ${LIVE_API_KEY_ENV}`);
    expect(existsSync(secret)).toBe(false);
    expect(loadEnvFile).toHaveBeenCalled();

    vi.stubEnv(LIVE_API_KEY_ENV, 'nvapi-fake-key-for-tests');
    running = await runServe({ argv: ['--port', '0', '--live'], log: () => undefined, env });
    expect(existsSync(secret)).toBe(true);
  });

  it('反面：`disabled: true` 的那一列設定再壞也不驗，serve 起得來、開得了對話', async () => {
    const home = privateHome();
    writePatch(
      home,
      'cordis.patch.yml',
      "- id: todo\n  disabled: true\n  config:\n    allowParallelInProgress: '不是布林'\n",
    );
    const server = await runServe({
      argv: ['--port', '0'],
      log: () => undefined,
      env: { [HARNESS_HOME_ENV]: home },
    });
    running = server;
    const client = await serveClient(server as RunningServe);
    const events = await client.openEvents('t');
    await client.runStart('t', '說點什麼');
    await foldTurn(events);
    await events.return?.(undefined);
  });

  it('遙測披露印在啟動時，不等第一條 thread', async () => {
    const home = privateHome();
    const lines: string[] = [];
    running = await runServe({
      argv: ['--port', '0'],
      log: (line) => lines.push(line),
      env: { [HARNESS_HOME_ENV]: home },
    });
    expect(lines.filter((line) => line.startsWith('遙測：'))).toHaveLength(1);
  });
});

describe('--dump-config 在兩個入口都印得出來', () => {
  it('CLI：印出疊完的設定就退出，一個 plugin 都沒載', async () => {
    const home = privateHome();
    const patch = writePatch(home, 'p.yml', '- id: todo\n  disabled: true\n');
    const printed: string[] = [];

    await runCli({
      argv: ['--dump-config', '--patch', patch],
      env: { [HARNESS_HOME_ENV]: home },
      input: new PassThrough(),
      output: new PassThrough(),
      printer: { log: (line) => printed.push(line), error: () => undefined },
    });

    const dumped = printed.join('\n');
    expect(dumped).toContain('# ==');
    expect(dumped).toContain(patch);
    expect(dumped).toContain('disabled: true');
  });

  it('serve：印完就走，沒有綁任何 port', async () => {
    const home = privateHome();
    const patch = writePatch(home, 'p.yml', '- id: todo\n  disabled: true\n');
    const printed: string[] = [];

    const result = await runServe({
      argv: ['--dump-config', '--patch', patch, '--port', '0'],
      log: (line) => printed.push(line),
      env: { [HARNESS_HOME_ENV]: home },
    });

    // **回 undefined 才代表沒起 server**：有起來的話它回的是 `{ url, close }`。
    expect(result).toBeUndefined();
    expect(printed.join('\n')).toContain('disabled: true');
  });

  it('CLI 上不能配 --resume：印設定不跑任何一輪', () => {
    expect(() => parseCliArgs(['--dump-config', '--resume', '/tmp/run'])).toThrow(
      '--dump-config 不能配 --resume',
    );
  });
});

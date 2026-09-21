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

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { parseCliArgs, runCli } from './cli.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { parseServeArgs, runServe } from './serve.js';

const temporary: string[] = [];

afterEach(() => {
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
 * 它是 `resolveEntries` 擋下來的，而那件事發生在 `createCliAgent` 裡——所以它證得了
 * 「設定一路流到了驗證」，但只在**開機就組 agent** 的入口上（CLI）。
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

describe('CLI 真的走設定檔那條路', () => {
  it('home 那一層壞掉就啟動不了——證明它被讀了', async () => {
    const home = privateHome();
    writePatch(home, 'cordis.patch.yml', BAD_CONFIG);

    await expect(
      runCli({ argv: ['說點什麼'], env: { [HARNESS_HOME_ENV]: home }, ...silent() }),
    ).rejects.toThrow(/todo/u);
  });

  it('--patch 壞掉也啟動不了', async () => {
    const home = privateHome();
    const patch = writePatch(home, 'bad.yml', BAD_CONFIG);

    await expect(
      runCli({
        argv: ['--patch', patch, '說點什麼'],
        env: { [HARNESS_HOME_ENV]: home },
        ...silent(),
      }),
    ).rejects.toThrow(/todo/u);
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
 * serve 那一半。
 *
 * **這裡用 `BAD_SHAPE` 不是 `BAD_CONFIG`，而那個差別本身是一個發現。** serve 的 agent 是
 * **每條 thread 才組的**，所以 `resolveEntries` 擋的那一類（plugin 自己的 `config` 不合法）
 * 在開機的時候不會發生——伺服器照樣起得來，第一個開 thread 的人才會撞到。dsh 不是這樣：
 * 它在 `boot()` 就把每個條目掛起來，required 條目失敗就拆掉整個 app 非零退出
 * （`packages/boot/app-boot/README.zh.md` 的失敗矩陣）。
 *
 * 這一輪不動它——接線是這一刀的射程，而「設定錯了該在什麼時候炸」是另一個問題（多人共用
 * 的部署上，那是「第一個人的 thread 爆掉」與「伺服器不起來」的差別）。已經寫回卡上。
 * 讀檔與形狀那一層是 `composeEntries` 在開機當下做的，所以下面兩條在兩個入口上都成立。
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

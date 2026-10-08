/**
 * `--dump-default-config`（[#740](https://github.com/DemianLi/nexus-agent/issues/740)）：只印出貨那一層，**真的不讀**
 * home 覆寫檔與 `--patch`。
 *
 * 這個旗標存在的理由是「覆寫檔壞了，`--dump-config` 連自己都印不出來」，所以核心判準是壞檔的對照組：
 * 同一個壞掉的 home，`--dump-config` 拋、`--dump-default-config` 照印。少了對照組，
 * 「印得出來」有可能只是因為檔剛好沒壞。
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { CLI_PROBE_FILE } from './assembly-root.js';
import { USAGE, parseCliArgs, runCli } from './cli.js';
import { ConfigSchemaIncompleteError } from './config-schema-dump.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { USER_PATCH_FILENAME, renderConfigDump, serveShippedConfigPath } from './plugin-config.js';
import { parseServeArgs, runServe } from './serve.js';

const temporary: string[] = [];
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

function privateHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'nexus-dump-default-'));
  temporary.push(root);
  chmodSync(root, 0o700);
  return root;
}

function writeHomePatch(home: string, content: string, mode: number): string {
  const path = join(home, USER_PATCH_FILENAME);
  writeFileSync(path, content);
  chmodSync(path, mode);
  return path;
}

async function cliPrint(argv: readonly string[], home: string): Promise<string> {
  const printed: string[] = [];
  await runCli({
    argv,
    env: { [HARNESS_HOME_ENV]: home },
    input: new PassThrough(),
    output: new PassThrough(),
    printer: { log: (line) => printed.push(line), error: () => undefined },
  });
  return printed.join('\n');
}

describe('--dump-default-config 印的是出貨那一層', () => {
  it('輸出等於只拿出貨檔呼叫 renderConfigDump 的結果', async () => {
    const home = privateHome();
    expect(await cliPrint(['--dump-default-config'], home)).toBe(renderConfigDump({}).trimEnd());
  });

  it('沒有 home 覆寫檔時，它跟 --dump-config 印的一樣（三層只剩出貨那一層）', async () => {
    const home = privateHome();
    expect(await cliPrint(['--dump-default-config'], home)).toBe(
      await cliPrint(['--dump-config'], home),
    );
  });

  it('home 覆寫檔改過的列，--dump-default-config 看不到，--dump-config 看得到', async () => {
    const home = privateHome();
    const path = writeHomePatch(home, '- id: todo\n  disabled: true\n', 0o600);

    const shipped = await cliPrint(['--dump-default-config'], home);
    const layered = await cliPrint(['--dump-config'], home);

    expect(layered).toContain(path);
    expect(shipped).not.toContain(path);
    expect(shipped).not.toBe(layered);
  });
});

describe('假模型是清單上的一列（#670）', () => {
  it('--dump-config 印得出 cli-script 那一列與它的腳本；組裝用的就是這份資料', async () => {
    const dump = await cliPrint(['--dump-config'], privateHome());
    expect(dump).toContain('id: cli-script');
    expect(dump).toContain('name: "#settings/scripted-model"');
    // 腳本的內容是資料，印得出來：呼叫的工具名、寫的檔，跟 CLI 測試拿來確認 `--workspace` 的 `CLI_PROBE_FILE` 同一個字串。
    expect(dump).toContain('name: echo');
    expect(dump).toContain('name: write_file');
    expect(dump).toContain(`file_path: ${CLI_PROBE_FILE}`);
  });
});

describe('覆寫檔壞了：--dump-config 印不出來，--dump-default-config 照印', () => {
  it('權限是別人也寫得動（0666）', async () => {
    const home = privateHome();
    const path = writeHomePatch(home, '[]\n', 0o666);

    // 對照組：同一個壞掉的 home，`--dump-config` 拋。
    await expect(cliPrint(['--dump-config'], home)).rejects.toThrow(/可寫/u);

    const printed = await cliPrint(['--dump-default-config'], home);
    expect(printed).toBe(renderConfigDump({}).trimEnd());
    expect(printed).not.toContain(path);
  });

  it('YAML 寫壞', async () => {
    const home = privateHome();
    const path = writeHomePatch(home, 'id: [這不是 yaml\n  - : :\n', 0o600);

    await expect(cliPrint(['--dump-config'], home)).rejects.toThrow();

    const printed = await cliPrint(['--dump-default-config'], home);
    expect(printed).toBe(renderConfigDump({}).trimEnd());
    expect(printed).not.toContain(path);
  });

  it('serve：同一個壞掉的 home，印完就走、沒有綁任何 port', async () => {
    const home = privateHome();
    writeHomePatch(home, '[]\n', 0o666);
    const printed: string[] = [];

    await expect(
      runServe({
        argv: ['--dump-config', '--port', '0'],
        log: (line) => printed.push(line),
        env: { [HARNESS_HOME_ENV]: home },
      }),
    ).rejects.toThrow(/可寫/u);

    const result = await runServe({
      argv: ['--dump-default-config', '--port', '0'],
      log: (line) => printed.push(line),
      env: { [HARNESS_HOME_ENV]: home },
    });

    // **回 undefined 才代表沒起 server**：有起來的話它回的是 `{ url, close }`。
    expect(result).toBeUndefined();
    // serve 的出貨層多一個專屬檔（#669），所以對的是帶 serve 層的那份。
    expect(printed.join('\n')).toBe(
      renderConfigDump({ shippedLayers: [serveShippedConfigPath()] }).trimEnd(),
    );
  });
});

/**
 * **dump 分入口**（[#669](https://github.com/DemianLi/nexus-agent/issues/669) 第 4 步）：每一輪改了哪些檔那一列在 serve 專屬的出貨層，
 * 所以 `serve --dump-config` 印得到、`cli --dump-config` 印不到——dump 印的要是「這個入口啟動會掛的樹」。
 * 三個旗標（`--dump-config`、`--dump-default-config`、`--dump-config-schema`）兩個入口各一條。
 */
describe('dump 跟著入口走：serve 多一層專屬出貨清單', () => {
  async function servePrint(argv: readonly string[], home: string): Promise<string> {
    const printed: string[] = [];
    const result = await runServe({
      argv: [...argv, '--port', '0'],
      log: (line) => printed.push(line),
      env: { [HARNESS_HOME_ENV]: home },
    });
    expect(result).toBeUndefined();
    return printed.join('\n');
  }

  it('--dump-config：serve 印得到 workspace-changes（標著來源是 cordis.serve.yml），CLI 印不到', async () => {
    const home = privateHome();
    const serve = await servePrint(['--dump-config'], home);
    const cli = await cliPrint(['--dump-config'], home);
    expect(serve).toMatch(/id: workspace-changes$/m);
    expect(serve).toContain(`# == ${serveShippedConfigPath()}`);
    expect(cli).not.toMatch(/id: workspace-changes$/m);
    expect(cli).not.toContain('cordis.serve.yml');
  });

  it('--dump-default-config：同樣分入口', async () => {
    const home = privateHome();
    expect(await servePrint(['--dump-default-config'], home)).toMatch(/id: workspace-changes$/m);
    expect(await cliPrint(['--dump-default-config'], home)).not.toMatch(/id: workspace-changes$/m);
  });

  it('--dump-config-schema：serve 的規格表有 workspace-changes 的欄位，CLI 的沒有', async () => {
    const home = privateHome();
    // 規格表有幾條「轉不出來」的警告（既有的，與這一層無關），輸出印完才拋 `ConfigSchemaIncompleteError`；文件本身可用。
    const swallow = async (print: () => Promise<string>): Promise<string> => {
      try {
        return await print();
      } catch (error) {
        if (error instanceof ConfigSchemaIncompleteError) return captured.join('\n');
        throw error;
      }
    };
    const captured: string[] = [];
    const serve = await swallow(async () => {
      const result = await runServe({
        argv: ['--dump-config-schema', '--port', '0'],
        log: (line) => captured.push(line),
        env: { [HARNESS_HOME_ENV]: home },
      });
      expect(result).toBeUndefined();
      return captured.join('\n');
    });
    captured.length = 0;
    const cli = await swallow(async () => {
      await runCli({
        argv: ['--dump-config-schema'],
        env: { [HARNESS_HOME_ENV]: home },
        input: new PassThrough(),
        output: new PassThrough(),
        printer: { log: (line) => captured.push(line), error: () => undefined },
      });
      return captured.join('\n');
    });
    expect(serve).toContain('diffTimeoutMs');
    expect(cli).not.toContain('diffTimeoutMs');
  });

  it('home 的 patch 照樣能停用 serve 層那一列，dump 標出是誰改的', async () => {
    const home = privateHome();
    const path = writeHomePatch(home, '- id: workspace-changes\n  disabled: true\n', 0o600);
    const serve = await servePrint(['--dump-config'], home);
    expect(serve).toContain(`patched by ${path}`);
    expect(serve).toContain('disabled: true');
  });
});

describe('拒絕的組合，錯誤訊息點名是哪個旗標', () => {
  it('CLI 上不能配 --dump-config', () => {
    expect(() => parseCliArgs(['--dump-default-config', '--dump-config'])).toThrow(
      '--dump-default-config 不能配 --dump-config：',
    );
  });

  it('CLI 上不能配 --dump-config-schema', () => {
    expect(() => parseCliArgs(['--dump-default-config', '--dump-config-schema'])).toThrow(
      '--dump-default-config 不能配 --dump-config-schema',
    );
  });

  it('CLI 上不能配 --patch', () => {
    expect(() => parseCliArgs(['--dump-default-config', '--patch', 'p.yml'])).toThrow(
      '--dump-default-config 不能配 --patch',
    );
  });

  it('CLI 上不能配 --resume', () => {
    expect(() => parseCliArgs(['--dump-default-config', '--resume', '/tmp/run'])).toThrow(
      '--dump-default-config 不能配 --resume',
    );
  });

  it('CLI 上不能配要說的話', () => {
    expect(() => parseCliArgs(['--dump-default-config', '你好'])).toThrow(
      '--dump-default-config 不能配要說的話',
    );
  });

  it('--dump-config 也不再靜靜收下要說的話（這張一起補上）', () => {
    expect(() => parseCliArgs(['--dump-config', '你好'])).toThrow('--dump-config 不能配要說的話');
  });

  it('serve 上不能配 --dump-config、--dump-config-schema、--patch', () => {
    expect(() => parseServeArgs(['--dump-default-config', '--dump-config'])).toThrow(
      '--dump-default-config 不能配 --dump-config：',
    );
    expect(() => parseServeArgs(['--dump-default-config', '--dump-config-schema'])).toThrow(
      '--dump-default-config 不能配 --dump-config-schema',
    );
    expect(() => parseServeArgs(['--dump-default-config', '--patch', 'p.yml'])).toThrow(
      '--dump-default-config 不能配 --patch',
    );
  });

  it('單獨給可以', () => {
    expect(parseCliArgs(['--dump-default-config']).dumpDefaultConfig).toBe(true);
    expect(parseServeArgs(['--dump-default-config']).dumpDefaultConfig).toBe(true);
  });
});

describe('用法', () => {
  it('CLI 的 USAGE 寫著它', () => {
    expect(USAGE).toContain('--dump-default-config');
  });

  it('serve 的用法寫著它', async () => {
    const printed: string[] = [];
    await runServe({ argv: ['--help'], log: (line) => printed.push(line) });
    expect(printed.join('\n')).toContain('--dump-default-config');
  });
});

/**
 * `--dump-config-schema`（[#741](https://github.com/DemianLi/nexus-agent/issues/741)）：收集、文件、旗標。
 *
 * 轉換程式自己的單元測試在 `packages/nexus-core/src/config-schema.test.ts`；這一檔問的是只有 harness 這一層看得到的：
 * 出貨的清單疊完之後，每一列都收得到、標得對，輸出的文件真的能驗東西，以及模組載入的副作用進不了標準輸出。
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import Ajv2020 from 'ajv/dist/2020.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { USAGE, parseCliArgs, runCli } from './cli.js';
import {
  ConfigSchemaIncompleteError,
  generateConfigSchema,
  runDumpConfigSchema,
} from './config-schema-dump.js';
import type { ConfigSchemaDump } from './config-schema-dump.js';
import { composeEntries } from './plugin-config.js';
import { parseServeArgs, runServe } from './serve.js';

const temporary: string[] = [];
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  delete (globalThis as { __nx741?: unknown }).__nx741;
});

function privateDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'nexus-config-schema-'));
  temporary.push(root);
  chmodSync(root, 0o700);
  return root;
}

function writePrivate(root: string, name: string, content: string, mode = 0o600): string {
  const path = join(root, name);
  writeFileSync(path, content);
  chmodSync(path, mode);
  return path;
}

/** 出貨的清單加上（選配的）一份 patch 疊完的樣子，沒有 home 那一層。 */
function composed(patch?: { readonly root: string; readonly source: string }) {
  if (patch === undefined) return composeEntries({});
  return composeEntries({ overlays: [writePrivate(patch.root, 'p.yml', patch.source)] });
}

function validator(dump: ConfigSchemaDump, reference?: string) {
  const ajv = new Ajv2020({ strict: false });
  return ajv.compile(
    reference === undefined
      ? dump
      : { $schema: dump.$schema, $defs: dump.$defs, $ref: `#/$defs/${reference}` },
  );
}

/** 一顆放在私有目錄裡、要求一個 `token` 的 plugin；zod 用 harness 自己的那一份。 */
function tokenPlugin(root: string, mode = 0o600): string {
  return writePrivate(
    root,
    'needs-token.mjs',
    `import { z } from '${import.meta.resolve('zod')}';\n` +
      `globalThis.__nx741 = (globalThis.__nx741 ?? 0) + 1;\n` +
      `export default { name: 'needs-token', Config: z.strictObject({ token: z.string() }), apply() {} };\n`,
    mode,
  );
}

describe('出貨的清單', () => {
  it('每一列都收，轉不出來的標成不完整，沒有 Config 的是 absent，結束碼會是 1', async () => {
    const entries = composed();
    const dump = await generateConfigSchema(entries);
    const note = dump['x-nexus'];
    expect(note.entries).toHaveLength(entries.length);
    expect(note.diagnostics.filter((item) => item.level === 'error')).toEqual([]);
    const partial = note.entries.filter((entry) => entry.status === 'partial').map((e) => e.id);
    // 這幾列的 Config 用了 refine／custom：`live-model`、`thread-title`（refine），`present` 的 `maxFiles`（`.custom`，
    // 卡上那條 git grep 是逐行的，跨行的 `.custom<number>(` 掃不到，這裡的偵測看的是 schema 樹）。
    expect(partial).toEqual(expect.arrayContaining(['live-model', 'thread-title', 'present']));
    expect(note.entries.some((entry) => entry.status === 'absent')).toBe(true);
    expect(note.entries.some((entry) => entry.status === 'schema')).toBe(true);
    expect(note.complete).toBe(false);
    for (const entry of note.entries.filter((item) => item.status === 'partial')) {
      expect(entry.losses.length).toBeGreaterThan(0);
    }
  });

  it('疊完的清單拿輸出的文件驗會過', async () => {
    const entries = composed();
    const dump = await generateConfigSchema(entries);
    const validate = validator(dump);
    expect(validate(entries), JSON.stringify(validate.errors)).toBe(true);
  });

  it('條目的 id 不能有前後空白——那條 refine 寫進 pattern，不是標不完整', async () => {
    const dump = await generateConfigSchema(composed());
    const validate = validator(dump);
    for (const id of [' present', 'present ', '\tx']) {
      expect(validate([{ id, name: '@nexus/plugin-echo' }]), id).toBe(false);
    }
    expect(validate([{ id: 'a b', name: '@nexus/plugin-echo' }])).toBe(true);
  });

  it('停用的列也收：也 import、也標不完整', async () => {
    const root = privateDirectory();
    const dump = await generateConfigSchema(
      composed({ root, source: '- id: present\n  disabled: true\n' }),
    );
    expect(dump['x-nexus'].entries.find((entry) => entry.id === 'present')).toMatchObject({
      disabled: true,
      status: 'partial',
    });
  });
});

describe('覆寫檔的格式（$defs.patchList）', () => {
  it('合法的覆寫檔驗得過', async () => {
    const validate = validator(await generateConfigSchema(composed()), 'patchList');
    const patch = [
      { id: 'thread-title', config: { maxWords: 3 } },
      { id: 'present', disabled: true },
      { insert: [{ id: 'mine', name: '@nexus/plugin-echo' }] },
    ];
    expect(validate(patch), JSON.stringify(validate.errors)).toBe(true);
  });

  it('對認得的 id 整份換掉 config，欄位名打錯就驗不過——多寫一個、型別不對都是', async () => {
    const validate = validator(await generateConfigSchema(composed()), 'patchList');
    expect(validate([{ id: 'thread-title', config: { maxWord: 3 } }])).toBe(false);
    expect(validate([{ id: 'thread-title', config: { maxWords: 'three' } }])).toBe(false);
    // 對照組：拼對就過，所以上面兩條驗不過是因為打錯，不是因為這一條路整個不通。
    expect(validate([{ id: 'thread-title', config: { maxWords: 3 } }])).toBe(true);
  });

  it('patch 自己的欄位打錯（沒有這個欄位）也驗不過', async () => {
    const validate = validator(await generateConfigSchema(composed()), 'patchList');
    expect(validate([{ id: 'present', disable: true }])).toBe(false);
  });

  it('不認得的 id 與不認得的 plugin 名維持開放：欄位未知，不是禁止設定', async () => {
    const validate = validator(await generateConfigSchema(composed()), 'patchList');
    expect(validate([{ id: 'nobody', config: { anything: 1 } }])).toBe(true);
    expect(
      validate([{ insert: [{ id: 'x', name: './somewhere.mjs', config: { anything: 1 } }] }]),
    ).toBe(true);
  });
});

describe('停用的列與必填的 config', () => {
  it('停用的列可以省略必填的 config，但有寫的值仍然要驗；沒停用的省略就驗不過', async () => {
    const root = privateDirectory();
    const module = tokenPlugin(root);
    const dump = await generateConfigSchema(
      composed({ root, source: `- insert:\n    - id: nt\n      name: '${module}'\n` }),
    );
    expect(dump['x-nexus'].entries.find((entry) => entry.id === 'nt')?.status).toBe('schema');
    const validate = validator(dump);
    const name = `file://${module}`;
    expect(validate([{ id: 'nt', name, disabled: true }])).toBe(true);
    expect(validate([{ id: 'nt', name, disabled: true, config: { tokn: 'x' } }])).toBe(false);
    expect(validate([{ id: 'nt', name }])).toBe(false);
    expect(validate([{ id: 'nt', name, disabled: false }])).toBe(false);
    expect(validate([{ id: 'nt', name, config: { token: 'x' } }])).toBe(true);
  });
});

describe('別人寫得動的 file: 模組', () => {
  it('不 import，這一列標成錯誤，整份不完整', async () => {
    const root = privateDirectory();
    const module = tokenPlugin(root, 0o664);
    const dump = await generateConfigSchema(
      composed({ root, source: `- insert:\n    - id: nt\n      name: '${module}'\n` }),
    );
    // 沒被 import：模組頂層那句 `globalThis.__nx741 += 1` 一次都沒跑。
    expect((globalThis as { __nx741?: unknown }).__nx741).toBeUndefined();
    expect(dump['x-nexus'].entries.find((entry) => entry.id === 'nt')?.status).toBe('failed');
    expect(dump['x-nexus'].diagnostics).toContainEqual(
      expect.objectContaining({
        level: 'error',
        message: expect.stringContaining('群組或其他人可寫'),
      }),
    );
    expect(dump['x-nexus'].complete).toBe(false);
  });
});

describe('runDumpConfigSchema', () => {
  it('模組 import 時寫進標準輸出的東西轉到標準錯誤，標準輸出只有那份 JSON', async () => {
    const root = privateDirectory();
    const noisy = writePrivate(
      root,
      'noisy.mjs',
      `process.stdout.write('NOISE-FROM-IMPORT\\n');\nexport default { name: 'noisy', apply() {} };\n`,
    );
    const shipped = writePrivate(root, 'cordis.yml', `- id: noisy\n  name: '${noisy}'\n`);
    const stderr: string[] = [];
    const original = process.stdout.write;
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    const out: string[] = [];
    await runDumpConfigSchema(() => composeEntries({ shipped }), {
      out: (text) => out.push(text),
      err: () => undefined,
    });
    expect(stderr.join('')).toContain('NOISE-FROM-IMPORT');
    expect(out).toHaveLength(1);
    expect(out.join('')).not.toContain('NOISE');
    expect((JSON.parse(out.join('')) as ConfigSchemaDump)['x-nexus'].complete).toBe(true);
    // 轉向是暫時的：跑完要還原，不然同一個行程裡後面所有的輸出都跑到標準錯誤去。
    expect(process.stdout.write).toBe(original);
  });

  it('不完整：文件與診斷照樣印完，然後拋 ConfigSchemaIncompleteError', async () => {
    const out: string[] = [];
    const err: string[] = [];
    await expect(
      runDumpConfigSchema(() => composed(), {
        out: (text) => out.push(text),
        err: (text) => err.push(text),
      }),
    ).rejects.toThrow(ConfigSchemaIncompleteError);
    expect(JSON.parse(out.join('')) as ConfigSchemaDump).toHaveProperty('x-nexus.complete', false);
    expect(err.join('')).toContain('warning: [thread-title');
  });
});

describe('旗標', () => {
  it('USAGE 寫著它', () => {
    expect(USAGE).toContain('--dump-config-schema');
  });

  it('cli：單獨給可以；不能配 --dump-config、--resume 或要說的話', () => {
    expect(parseCliArgs(['--dump-config-schema']).dumpConfigSchema).toBe(true);
    expect(parseCliArgs([]).dumpConfigSchema).toBe(false);
    expect(() => parseCliArgs(['--dump-config-schema', '--dump-config'])).toThrow(
      '--dump-config-schema 不能配 --dump-config',
    );
    expect(() => parseCliArgs(['--dump-config-schema', '--resume', 'x'])).toThrow(
      '--dump-config-schema 不能配 --resume',
    );
    expect(() => parseCliArgs(['--dump-config-schema', '你好'])).toThrow(
      '--dump-config-schema 不能配要說的話',
    );
  });

  it('serve：單獨給可以；不能配 --dump-config', () => {
    expect(parseServeArgs(['--dump-config-schema']).dumpConfigSchema).toBe(true);
    expect(() => parseServeArgs(['--dump-config-schema', '--dump-config'])).toThrow(
      '--dump-config-schema 不能配 --dump-config',
    );
  });

  it('cli 的整條路：標準輸出（printer.log）只有一份 JSON，診斷走 printer.error，不完整拋出去', async () => {
    const home = privateDirectory();
    const log: string[] = [];
    const error: string[] = [];
    await expect(
      runCli({
        argv: ['--dump-config-schema'],
        input: new PassThrough(),
        output: new PassThrough(),
        env: { NEXUS_AGENT_HOME: home },
        printer: { log: (line) => log.push(line), error: (line) => error.push(line) },
      }),
    ).rejects.toThrow(ConfigSchemaIncompleteError);
    expect(log).toHaveLength(1);
    expect(JSON.parse(log[0]!) as ConfigSchemaDump).toHaveProperty('$schema');
    expect(error.join('\n')).toContain('warning:');
  });

  it('serve 的整條路：不開 server，印出同一份文件，不完整拋出去', async () => {
    const home = privateDirectory();
    const log: string[] = [];
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await expect(
      runServe({
        argv: ['--dump-config-schema'],
        env: { NEXUS_AGENT_HOME: home },
        log: (line) => log.push(line),
      }),
    ).rejects.toThrow(ConfigSchemaIncompleteError);
    expect(log).toHaveLength(1);
    expect(JSON.parse(log[0]!) as ConfigSchemaDump).toHaveProperty('x-nexus.entries');
  });

  it('--patch 疊上去的東西看得到（同 --dump-config 的層）', async () => {
    const root = privateDirectory();
    const patch = writePrivate(root, 'p.yml', '- id: present\n  disabled: true\n');
    const log: string[] = [];
    await runCli({
      argv: ['--dump-config-schema', '--patch', patch],
      input: new PassThrough(),
      output: new PassThrough(),
      env: { NEXUS_AGENT_HOME: root },
      printer: { log: (line) => log.push(line), error: () => undefined },
    }).catch(() => undefined);
    const dump = JSON.parse(log[0]!) as ConfigSchemaDump;
    expect(dump['x-nexus'].entries.find((entry) => entry.id === 'present')?.disabled).toBe(true);
  });
});

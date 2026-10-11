/**
 * [#1386](https://github.com/DemianLi/nexus-agent/issues/1386) 驗收 ①：vendor 的上游 Cordis 在 `module: NodeNext` 下型別解得到。
 *
 * `nodenext/consumer.ts` 只相依 `cordis` 與 `@cordisjs/plugin-loader`，用一份 strict 的 NodeNext tsconfig 檢查。
 * 「解得到」不靠 tsc 綠證明——消費者裡有四行標了 `@ts-expect-error` 的錯用法，型別退化成 `any` 時那幾行不再報錯，
 * 標記變成未使用（TS2578），tsc 會紅。第二條測試把標記拿掉，確認那四行真的各報一個錯。
 *
 * 前提是 vendor 的宣告檔已經由 `prepare`（`pnpm install` 時）建好；量測數字與上游原樣的對照見
 * `.docs/cordis-probe-measurement-2026-10-11.md` 的 ①。
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const TSC = createRequire(import.meta.url).resolve('typescript/bin/tsc');
const DIR = join(import.meta.dirname, 'nodenext');

/** 跑一次 tsc，回傳退出碼與所有錯誤代碼。 */
async function tsc(project: string): Promise<{ code: number; errors: string[] }> {
  try {
    await run(process.execPath, [TSC, '-p', project], { cwd: DIR });
    return { code: 0, errors: [] };
  } catch (error) {
    const { code, stdout } = error as { code: number; stdout: string };
    return { code, errors: stdout.match(/error TS\d+/gu) ?? [] };
  }
}

describe('vendor 的 Cordis 在 NodeNext 下（#1386 ①）', () => {
  it('消費者 tsc 綠，四道 @ts-expect-error 都有作用（get、inject 的 ctx、loader、provide 的回傳）', async () => {
    expect(await tsc('tsconfig.json')).toEqual({ code: 0, errors: [] });
  }, 60_000);

  it('拿掉 @ts-expect-error 後那四行各報一個錯：型別沒有退化成 any', async () => {
    const source = await readFile(join(DIR, 'consumer.ts'), 'utf8');
    const stripped = source.replace(/^\s*\/\/ @ts-expect-error.*\n/gmu, '');
    expect(stripped).not.toBe(source);
    const tmp = await mkdtemp(join(DIR, '.mutant-'));
    try {
      await writeFile(join(tmp, 'consumer.ts'), stripped);
      const config = JSON.parse(await readFile(join(DIR, 'tsconfig.json'), 'utf8')) as object;
      await writeFile(join(tmp, 'tsconfig.json'), JSON.stringify(config));
      const result = await tsc(join(tmp, 'tsconfig.json'));
      expect(result.code).not.toBe(0);
      expect(result.errors).toHaveLength(4);
      expect(result.errors).not.toContain('error TS2578');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});

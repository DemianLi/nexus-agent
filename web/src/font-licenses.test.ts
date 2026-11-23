// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { FONT_LICENSES, fontLicensePath, fontLicenses } from '../font-licenses';
import { checkFontLicenses, EXPECTED } from '../scripts/check-font-licenses.mjs';

const OFL_TITLE = 'SIL OPEN FONT LICENSE Version 1.1';

/** 跑外掛的 `generateBundle`，收下它 `emitFile` 的每一份。 */
async function emitted(): Promise<{ fileName: string; source: string }[]> {
  const files: { fileName: string; source: string }[] = [];
  const plugin = fontLicenses();
  const hook = plugin.generateBundle as unknown as (this: object) => Promise<void>;
  await hook.call({
    emitFile: (file: { type: string; fileName: string; source: Uint8Array | string }) => {
      expect(file.type).toBe('asset');
      files.push({ fileName: file.fileName, source: Buffer.from(file.source).toString('utf8') });
      return file.fileName;
    },
  });
  return files;
}

describe('字型授權全文跟著字型進產物（#1713，照 dsh brandFontLicense）', () => {
  it('三顆字型各一份，放在 assets/fonts/，都是 OFL 1.1 全文', async () => {
    const files = await emitted();
    expect(files.map((f) => f.fileName)).toEqual([
      'assets/fonts/Geist-OFL.txt',
      'assets/fonts/GeistMono-OFL.txt',
      'assets/fonts/NotoSansTC-OFL.txt',
    ]);
    for (const file of files) expect(file.source).toContain(OFL_TITLE);
  });

  it('每一份就是對應套件自己帶的 LICENSE，一個位元組都不差', async () => {
    const files = await emitted();
    for (const [index, { package: fontPackage }] of FONT_LICENSES.entries()) {
      expect(files[index]?.source).toBe(readFileSync(fontLicensePath(fontPackage), 'utf8'));
    }
  });

  it('build 最後一步的清單跟外掛的是同一份', () => {
    expect(EXPECTED.map((e) => e.fileName)).toEqual(FONT_LICENSES.map((f) => f.fileName));
  });
});

describe('build 最後一步的量具（scripts/check-font-licenses.mjs）', () => {
  let dist: string | undefined;
  afterEach(() => {
    if (dist !== undefined) rmSync(dist, { recursive: true, force: true });
    dist = undefined;
  });

  /** 照外掛的輸出擺一份假的 dist，`drop` 的那份不擺、`swap` 的兩份對調內容。 */
  async function fakeDist(options: { drop?: string; swap?: [string, string] } = {}): Promise<URL> {
    dist = mkdtempSync(join(tmpdir(), 'font-ofl-'));
    mkdirSync(join(dist, 'assets/fonts'), { recursive: true });
    const files = await emitted();
    const byName = new Map(files.map((f) => [f.fileName, f.source]));
    if (options.swap !== undefined) {
      const [a, b] = options.swap;
      const textA = byName.get(a)!;
      byName.set(a, byName.get(b)!);
      byName.set(b, textA);
    }
    for (const [fileName, source] of byName) {
      if (fileName !== options.drop) writeFileSync(join(dist, fileName), source);
    }
    return pathToFileURL(`${dist}/`);
  }

  it('三份都在、內容對：沒有問題', async () => {
    expect(checkFontLicenses(await fakeDist())).toEqual([]);
  });

  it('少一份：點名那一份', async () => {
    const problems = checkFontLicenses(await fakeDist({ drop: 'assets/fonts/GeistMono-OFL.txt' }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('GeistMono-OFL.txt 不在產物裡');
  });

  it('兩份放反了：兩份都點名', async () => {
    const problems = checkFontLicenses(
      await fakeDist({ swap: ['assets/fonts/Geist-OFL.txt', 'assets/fonts/NotoSansTC-OFL.txt'] }),
    );
    expect(problems.map((p) => p.split(' ')[0])).toEqual([
      'assets/fonts/Geist-OFL.txt',
      'assets/fonts/NotoSansTC-OFL.txt',
    ]);
  });
});

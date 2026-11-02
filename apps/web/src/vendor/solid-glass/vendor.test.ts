// @vitest-environment node
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import { applyAll, PATCH_NAME, revertAll } from './patches.mjs';

/**
 * vendor 的檔是上游原樣，或上游原樣加上登記的 patch（#1468 Q9：修改預設寫在後載入的覆寫檔；非改 vendor 檔不可的寫成
 * `patches/` 的 patch，#1583）。`sync.mjs --check` 要有上游 clone 才跑得了，這裡不用：
 *
 * - 比對每個檔與 `manifest.json` 記的 sha256：手改 vendor 的檔、不登記 patch，CI 就紅。sha256 只由 `sync.mjs` 寫。
 * - 有 patch 的檔，把 patch 倒序反向套回去，結果要等於 manifest 記的 `upstreamSha256`（上游原樣）：連 sha256 一起改掉的手改也抓得到。
 *   反向套用與 `sync.mjs` 的正向套用是同一份 `patches.mjs`（jsdiff，fuzz 0）。
 * - `patches/` 底下每個檔都被正好一筆 manifest 引用，沒有沒人認的 patch。
 */

const dir = new URL('./', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', dir), 'utf8')) as {
  sources: {
    'solid-glass': { upstream: string; commit: string };
    shadcn: { upstream: string; package: string; version: string; integrity: string };
  };
  files: Record<
    string,
    { source: string; from: string; sha256: string; upstreamSha256?: string; patches?: string[] }
  >;
};

/** 這個目錄裡我們自己的檔（只在最上層）；其餘的，子目錄裡的也算，都要是登記過的上游檔。 */
const OURS = [
  '.gitattributes',
  'README.md',
  'manifest.json',
  'patches.d.mts',
  'patches.mjs',
  'sync.mjs',
  'vendor.test.ts',
];

const read = (name: string) => readFileSync(new URL(name, dir), 'utf8');
const patched = Object.entries(manifest.files).filter(([, entry]) => entry.patches !== undefined);
const patchesOf = (entry: { patches?: string[] }) =>
  (entry.patches ?? []).map((name): [string, string] => [name, read(name)]);

const sha256 = (name: string) =>
  createHash('sha256')
    .update(readFileSync(new URL(name, dir)))
    .digest('hex');

describe('vendor 的 solid-glass 是上游原樣', () => {
  test('兩個上游都固定住：solid-glass 一個 commit，shadcn 一個版本與 tarball 的 integrity（#1523）', () => {
    expect(manifest.sources['solid-glass'].upstream).toBe(
      'https://github.com/deeplethe/solid-glass',
    );
    expect(manifest.sources['solid-glass'].commit).toMatch(/^[0-9a-f]{40}$/);
    expect(manifest.sources.shadcn.package).toBe('shadcn');
    expect(manifest.sources.shadcn.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.sources.shadcn.integrity).toMatch(/^sha512-[A-Za-z0-9+/]+=*$/);
  });

  test.each(Object.entries(manifest.files))('%s 登記的上游存在', (_name, entry) => {
    expect(Object.keys(manifest.sources)).toContain(entry.source);
  });

  test.each(Object.entries(manifest.files))('%s 的 sha256 等於 manifest 記的', (name, entry) => {
    expect(sha256(name)).toBe(entry.sha256);
  });

  test('目錄裡（含子目錄）的上游檔正好是 manifest 登記的那幾個，不多不少', () => {
    const present = readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) =>
        relative(fileURLToPath(dir), join(entry.parentPath, entry.name)).split(sep).join('/'),
      )
      .filter((name) => !OURS.includes(name) && !name.startsWith('patches/'));
    expect(present.sort()).toEqual(Object.keys(manifest.files).sort());
  });
});

describe('改 vendor 檔的 patch（#1583）', () => {
  const onDisk = readdirSync(new URL('patches/', dir)).map((name) => `patches/${name}`);
  const referenced = Object.values(manifest.files).flatMap((entry) => entry.patches ?? []);

  test('有 patch 的檔才記 upstreamSha256，記了就一定有 patch', () => {
    for (const [name, entry] of Object.entries(manifest.files)) {
      expect(entry.upstreamSha256 === undefined, name).toBe(entry.patches === undefined);
      if (entry.patches !== undefined) {
        expect(entry.patches.length, name).toBeGreaterThan(0);
        expect(entry.upstreamSha256, name).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });

  test('patches/ 底下每個檔都被正好一筆 manifest 引用，引用的都存在，檔名照 NNNN-<元件>-<事由>.patch', () => {
    expect([...referenced].sort()).toEqual([...onDisk].sort());
    expect(new Set(referenced).size).toBe(referenced.length);
    for (const name of onDisk) expect(name).toMatch(PATCH_NAME);
  });

  test.each(patched)(
    '%s：patch 倒序反向套回去，等於上游原樣（upstreamSha256）；再正向套一次，等於 vendor 的檔',
    (name, entry) => {
      const vendor = read(name);
      const upstream = revertAll(vendor, patchesOf(entry));
      expect(createHash('sha256').update(upstream, 'utf8').digest('hex')).toBe(
        entry.upstreamSha256,
      );
      expect(applyAll(upstream, patchesOf(entry))).toBe(vendor);
    },
  );

  test('量具自檢：fuzz 0，context 差一行就套不上；CR 直接拒收', () => {
    const before = 'a\nb\nc\nd\ne\n';
    const patch = '--- a/x.tsx\n+++ b/x.tsx\n@@ -1,5 +1,5 @@\n a\n b\n-c\n+C\n d\n e\n';
    expect(applyAll(before, [['p', patch]])).toBe('a\nb\nC\nd\ne\n');
    expect(() => applyAll('a\nB\nc\nd\ne\n', [['p', patch]])).toThrow('套不上');
    expect(() => applyAll(before, [['p', patch.replace(/\n/g, '\r\n')]])).toThrow('CR');
  });
});

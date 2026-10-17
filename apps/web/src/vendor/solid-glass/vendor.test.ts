// @vitest-environment node
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

/**
 * vendor 的檔是上游原樣（#1468 Q9：修改寫在後載入的覆寫檔，不動這裡）。`sync.mjs --check` 要有上游 clone 才跑得了，
 * 這條不用：比對每個檔與 `manifest.json` 記的 sha256，手改 vendor 的檔在 CI 就紅。sha256 只由 `sync.mjs` 寫。
 */

const dir = new URL('./', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', dir), 'utf8')) as {
  upstream: string;
  commit: string;
  files: Record<string, { from: string; sha256: string }>;
};

/** 這個目錄裡我們自己的檔；其餘的都要是登記過的上游檔。 */
const OURS = ['.gitattributes', 'README.md', 'manifest.json', 'sync.mjs', 'vendor.test.ts'];

const sha256 = (name: string) =>
  createHash('sha256')
    .update(readFileSync(new URL(name, dir)))
    .digest('hex');

describe('vendor 的 solid-glass 是上游原樣', () => {
  test('固定在一個 commit', () => {
    expect(manifest.upstream).toBe('https://github.com/deeplethe/solid-glass');
    expect(manifest.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  test.each(Object.entries(manifest.files))('%s 的 sha256 等於 manifest 記的', (name, entry) => {
    expect(sha256(name)).toBe(entry.sha256);
  });

  test('目錄裡的上游檔正好是 manifest 登記的那幾個，不多不少', () => {
    const present = readdirSync(dir).filter((name) => !OURS.includes(name));
    expect(present.sort()).toEqual(Object.keys(manifest.files).sort());
  });
});

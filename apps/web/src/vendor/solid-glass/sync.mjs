#!/usr/bin/env node
/* global console, process */
// 從上游 deeplethe/solid-glass 的 clone 同步 vendor 的檔：原樣複製，不做任何改寫（#1468 Q9：修改寫在後載入的覆寫檔）。
//
// 用法：
//   node apps/web/src/vendor/solid-glass/sync.mjs <上游 clone>           蓋過 vendor 的檔，重寫 manifest.json 的 sha256
//   node apps/web/src/vendor/solid-glass/sync.mjs <上游 clone> --check   只比對：vendor 的檔與 manifest 的 sha256 都要等於上游原樣，
//                                                                       有差異就印出並以 1 退出
//
// clone 要停在 manifest.json 記的 commit，而且工作區要乾淨；不是的話直接失敗（以 2 退出）。
// 換版本：先改 manifest.json 的 `commit`，再不帶 --check 跑一次。步驟見同目錄的 README.md。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VENDOR = dirname(fileURLToPath(import.meta.url));
const MANIFEST = join(VENDOR, 'manifest.json');

const [upstream, flag] = process.argv.slice(2);
if (upstream === undefined || (flag !== undefined && flag !== '--check')) {
  console.error('用法：node apps/web/src/vendor/solid-glass/sync.mjs <上游 clone> [--check]');
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const git = (...args) =>
  execFileSync('git', ['-C', upstream, ...args], { encoding: 'utf8' }).trim();

const head = git('rev-parse', 'HEAD');
if (head !== manifest.commit) {
  console.error(`clone 停在 ${head}，manifest.json 記的是 ${manifest.commit}`);
  process.exit(2);
}
const dirty = git('status', '--porcelain');
if (dirty !== '') {
  console.error(`clone 的工作區不乾淨，拿它比對等於拿改過的上游比：\n${dirty}`);
  process.exit(2);
}

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

if (flag === '--check') {
  const diffs = [];
  for (const [name, entry] of Object.entries(manifest.files)) {
    const expected = sha256(join(upstream, entry.from));
    let actual;
    try {
      actual = sha256(join(VENDOR, name));
    } catch {
      actual = '（不存在）';
    }
    if (actual !== expected)
      diffs.push(`不同：${name}（vendor ${actual}，上游 ${entry.from} ${expected}）`);
    if (entry.sha256 !== expected)
      diffs.push(`不同：manifest.json 的 ${name}（記 ${entry.sha256}，上游 ${expected}）`);
  }
  for (const line of diffs) console.log(line);
  const count = Object.keys(manifest.files).length;
  console.log(
    diffs.length === 0 ? `一致（${count} 個檔，上游 ${head}）` : `${diffs.length} 處不同`,
  );
  process.exitCode = diffs.length === 0 ? 0 : 1;
} else {
  for (const [name, entry] of Object.entries(manifest.files)) {
    copyFileSync(join(upstream, entry.from), join(VENDOR, name));
    entry.sha256 = sha256(join(VENDOR, name));
  }
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`已同步（${Object.keys(manifest.files).length} 個檔，上游 ${head}）`);
}

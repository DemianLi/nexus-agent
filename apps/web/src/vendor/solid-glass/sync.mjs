#!/usr/bin/env node
/* global console, process */
// 從上游同步 vendor 的檔：原樣複製，不做任何改寫（#1468 Q9：修改寫在後載入的覆寫檔或 `components/ui` 那一層）。
//
// 上游有兩個（manifest.json 的 `sources`）：
//   solid-glass  deeplethe/solid-glass 的 git clone，要停在 `commit`、工作區乾淨
//   shadcn       npm 的 shadcn 套件 tarball（`npm pack shadcn@<version>`），sha512 要等於 `integrity`（SG 的 package-lock 記的那一個）
//
// 用法：
//   node apps/web/src/vendor/solid-glass/sync.mjs --solid-glass <clone> --shadcn <tgz>           蓋過 vendor 的檔，重寫 sha256
//   node apps/web/src/vendor/solid-glass/sync.mjs --solid-glass <clone> --shadcn <tgz> --check   只比對：vendor 的檔與 manifest 的 sha256
//                                                                                              都要等於上游原樣，有差異就印出並以 1 退出
//
// 上游對不上 manifest（commit、工作區、integrity、版本）直接失敗（以 2 退出）。換版本：先改 manifest.json 的 `sources`，再不帶 --check 跑一次。
// 步驟見同目錄的 README.md。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VENDOR = dirname(fileURLToPath(import.meta.url));
const MANIFEST = join(VENDOR, 'manifest.json');
const USAGE =
  '用法：node apps/web/src/vendor/solid-glass/sync.mjs --solid-glass <clone> --shadcn <tgz> [--check]';

const args = process.argv.slice(2);
const options = {};
let check = false;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--check') check = true;
  else if ((args[i] === '--solid-glass' || args[i] === '--shadcn') && args[i + 1] !== undefined)
    options[args[i].slice(2)] = args[(i += 1)];
  else {
    console.error(USAGE);
    process.exit(2);
  }
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const fail = (message) => {
  console.error(message);
  process.exit(2);
};
for (const name of Object.keys(manifest.sources)) if (options[name] === undefined) fail(USAGE);

/** 每個上游解成一個根目錄，`files.*.from` 相對於它。 */
const roots = {};
const cleanup = [];

{
  const clone = options['solid-glass'];
  const git = (...rest) => execFileSync('git', ['-C', clone, ...rest], { encoding: 'utf8' }).trim();
  const head = git('rev-parse', 'HEAD');
  if (head !== manifest.sources['solid-glass'].commit)
    fail(
      `solid-glass 的 clone 停在 ${head}，manifest.json 記的是 ${manifest.sources['solid-glass'].commit}`,
    );
  const dirty = git('status', '--porcelain');
  if (dirty !== '')
    fail(`solid-glass 的 clone 工作區不乾淨，拿它比對等於拿改過的上游比：\n${dirty}`);
  roots['solid-glass'] = clone;
}

{
  const source = manifest.sources.shadcn;
  const tgz = options.shadcn;
  const integrity = `sha512-${createHash('sha512').update(readFileSync(tgz)).digest('base64')}`;
  if (integrity !== source.integrity)
    fail(`shadcn 的 tarball 是 ${integrity}，manifest.json 記的是 ${source.integrity}`);
  const out = mkdtempSync(join(tmpdir(), 'nexus-sg-shadcn-'));
  cleanup.push(out);
  execFileSync('tar', ['-xzf', tgz, '-C', out]);
  const root = join(out, 'package');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (pkg.name !== source.package || pkg.version !== source.version)
    fail(
      `shadcn 的 tarball 是 ${pkg.name}@${pkg.version}，manifest.json 記的是 ${source.package}@${source.version}`,
    );
  roots.shadcn = root;
}

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const upstreamPath = (entry) => {
  const root = roots[entry.source];
  if (root === undefined) fail(`manifest.json 的檔指到沒有登記的上游 ${entry.source}`);
  return join(root, entry.from);
};
const describeSources = () =>
  `solid-glass ${manifest.sources['solid-glass'].commit}、shadcn@${manifest.sources.shadcn.version}`;

try {
  if (check) {
    const diffs = [];
    for (const [name, entry] of Object.entries(manifest.files)) {
      const expected = sha256(upstreamPath(entry));
      let actual;
      try {
        actual = sha256(join(VENDOR, name));
      } catch {
        actual = '（不存在）';
      }
      if (actual !== expected)
        diffs.push(
          `不同：${name}（vendor ${actual}，上游 ${entry.source}:${entry.from} ${expected}）`,
        );
      if (entry.sha256 !== expected)
        diffs.push(`不同：manifest.json 的 ${name}（記 ${entry.sha256}，上游 ${expected}）`);
    }
    for (const line of diffs) console.log(line);
    const count = Object.keys(manifest.files).length;
    console.log(
      diffs.length === 0 ? `一致（${count} 個檔，${describeSources()}）` : `${diffs.length} 處不同`,
    );
    process.exitCode = diffs.length === 0 ? 0 : 1;
  } else {
    for (const [name, entry] of Object.entries(manifest.files)) {
      mkdirSync(dirname(join(VENDOR, name)), { recursive: true });
      copyFileSync(upstreamPath(entry), join(VENDOR, name));
      entry.sha256 = sha256(join(VENDOR, name));
    }
    writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`已同步（${Object.keys(manifest.files).length} 個檔，${describeSources()}）`);
  }
} finally {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
}

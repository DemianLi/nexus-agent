#!/usr/bin/env node
/* global console, process */
// 從上游同步 vendor 的檔：複製上游原樣，再套 manifest 登記的 patch（#1468 Q9：修改預設寫在後載入的覆寫檔或 `components/ui`
// 那一層；非改 vendor 檔不可的，寫成 `patches/` 的 patch，#1583）。套 patch 用同目錄的 `patches.mjs`（jsdiff，fuzz 0），
// `vendor.test.ts` 的離線反向比對也用它。
//
// 上游有兩個（manifest.json 的 `sources`）：
//   solid-glass  deeplethe/solid-glass 的 git clone，要停在 `commit`、工作區乾淨
//   shadcn       npm 的 shadcn 套件 tarball（`npm pack shadcn@<version>`），sha512 要等於 `integrity`（SG 的 package-lock 記的那一個）
//
// 用法：
//   node apps/web/src/vendor/solid-glass/sync.mjs --solid-glass <clone> --shadcn <tgz>           蓋過 vendor 的檔，重寫 sha256
//   node apps/web/src/vendor/solid-glass/sync.mjs --solid-glass <clone> --shadcn <tgz> --check   只比對：vendor 的檔與 manifest 的 sha256
//                                                                                              都要等於上游原樣加上登記的 patch，
//                                                                                              有差異或 patch 套不上就印出並以 1 退出
//   node apps/web/src/vendor/solid-glass/sync.mjs --solid-glass <clone> --shadcn <tgz> --record <檔> <事由>
//       把手改過的 vendor 檔記成下一個 patch（`patches/NNNN-<元件>-<事由>.patch`），登記進 manifest 的 `patches`
//
// 上游對不上 manifest（commit、工作區、integrity、版本）直接失敗（以 2 退出）。換版本：先改 manifest.json 的 `sources`，再不帶 --check 跑一次。
// 步驟見同目錄的 README.md。
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyAll, createOne } from './patches.mjs';

const VENDOR = dirname(fileURLToPath(import.meta.url));
const MANIFEST = join(VENDOR, 'manifest.json');
const USAGE =
  '用法：node apps/web/src/vendor/solid-glass/sync.mjs --solid-glass <clone> --shadcn <tgz> [--check | --record <檔> <事由>]';

const args = process.argv.slice(2);
const options = {};
let check = false;
let record;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--check') check = true;
  else if (args[i] === '--record' && args[i + 2] !== undefined)
    record = { file: args[(i += 1)], reason: args[(i += 1)] };
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
if (check && record !== undefined) fail(USAGE);

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

const sha256Of = (content) => createHash('sha256').update(content).digest('hex');
const sha256 = (path) => sha256Of(readFileSync(path));
/** 一筆登記的 patch，照 manifest 的順序：`[名字, 內容]`。 */
const patchesOf = (entry) =>
  (entry.patches ?? []).map((name) => [name, readFileSync(join(VENDOR, name), 'utf8')]);
/** 上游原樣加上登記的 patch：沒有 patch 的檔逐位元複製（不經字串，LICENSE 之類也不會被改到）。 */
const expectedOf = (entry) => {
  const upstream = readFileSync(upstreamPath(entry));
  const patches = patchesOf(entry);
  return patches.length === 0
    ? upstream
    : Buffer.from(applyAll(upstream.toString('utf8'), patches), 'utf8');
};
const upstreamPath = (entry) => {
  const root = roots[entry.source];
  if (root === undefined) fail(`manifest.json 的檔指到沒有登記的上游 ${entry.source}`);
  return join(root, entry.from);
};
/** `patches/` 底下的檔，用 `patches/<名字>` 表示。 */
const listPatches = () => {
  try {
    return readdirSync(join(VENDOR, 'patches')).map((name) => `patches/${name}`);
  } catch {
    return [];
  }
};
const describeSources = () =>
  `solid-glass ${manifest.sources['solid-glass'].commit}、shadcn@${manifest.sources.shadcn.version}`;

try {
  if (check) {
    const diffs = [];
    for (const [name, entry] of Object.entries(manifest.files)) {
      if (entry.patches !== undefined) {
        const upstream = sha256(upstreamPath(entry));
        if (entry.upstreamSha256 !== upstream)
          diffs.push(
            `不同：manifest.json 的 ${name} upstreamSha256（記 ${entry.upstreamSha256}，上游 ${upstream}）`,
          );
      }
      let expected;
      try {
        expected = sha256Of(expectedOf(entry));
      } catch (error) {
        diffs.push(`套不上：${name}（${error.message}）`);
        continue;
      }
      let actual;
      try {
        actual = sha256(join(VENDOR, name));
      } catch {
        actual = '（不存在）';
      }
      if (actual !== expected)
        diffs.push(
          `不同：${name}（vendor ${actual}，上游 ${entry.source}:${entry.from}${entry.patches ? ' 加 patch' : ''} ${expected}）`,
        );
      if (entry.sha256 !== expected)
        diffs.push(`不同：manifest.json 的 ${name}（記 ${entry.sha256}，上游 ${expected}）`);
    }
    const registered = new Set(
      Object.values(manifest.files).flatMap((entry) => entry.patches ?? []),
    );
    for (const name of listPatches())
      if (!registered.has(name)) diffs.push(`沒登記的 patch：${name}`);
    for (const line of diffs) console.log(line);
    const count = Object.keys(manifest.files).length;
    console.log(
      diffs.length === 0 ? `一致（${count} 個檔，${describeSources()}）` : `${diffs.length} 處不同`,
    );
    process.exitCode = diffs.length === 0 ? 0 : 1;
  } else if (record !== undefined) {
    const entry = manifest.files[record.file];
    if (entry === undefined) fail(`${record.file} 不在 manifest.json 的 files 裡`);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(record.reason))
      fail(`事由要是小寫英數與連字號：${record.reason}`);
    const before = expectedOf(entry).toString('utf8');
    const after = readFileSync(join(VENDOR, record.file), 'utf8');
    if (before === after) fail(`${record.file} 跟上游加上已登記的 patch 一樣，沒有東西可記`);
    const component = record.file.replace(/^.*\//, '').replace(/\.[^.]+$/, '');
    const next = Math.max(0, ...listPatches().map((name) => Number(name.slice(8, 12)))) + 1;
    const name = `patches/${String(next).padStart(4, '0')}-${component}-${record.reason}.patch`;
    const patch = createOne(record.file, before, after);
    if (applyAll(before, [[name, patch]]) !== after) fail(`${name} 產生後套回去不等於手改的檔`);
    mkdirSync(join(VENDOR, 'patches'), { recursive: true });
    writeFileSync(join(VENDOR, name), patch);
    entry.patches = [...(entry.patches ?? []), name];
    entry.upstreamSha256 = sha256(upstreamPath(entry));
    entry.sha256 = sha256(join(VENDOR, record.file));
    writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`已記成 ${name}（${record.file}）`);
  } else {
    for (const [name, entry] of Object.entries(manifest.files)) {
      mkdirSync(dirname(join(VENDOR, name)), { recursive: true });
      writeFileSync(join(VENDOR, name), expectedOf(entry));
      if (entry.patches !== undefined) entry.upstreamSha256 = sha256(upstreamPath(entry));
      entry.sha256 = sha256(join(VENDOR, name));
    }
    writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`已同步（${Object.keys(manifest.files).length} 個檔，${describeSources()}）`);
  }
} finally {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
}

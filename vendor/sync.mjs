#!/usr/bin/env node
// 從上游 cordiverse/cordis 的 clone 重建 vendor 的原始碼：複製 → 套 patches/ 裡的上游修補 → 機械改寫。
//
// 用法：
//   node vendor/sync.mjs <上游 clone>           蓋過 vendor/cordis/{src,tests} 與 vendor/loader/src
//   node vendor/sync.mjs <上游 clone> --check   重建到暫存目錄，與 vendor 逐檔比對；有差異就印出並以 1 退出
//
// 上游 clone 要停在 README 清單記的 commit。步驟與每一條本地修改的對應見 vendor/README.md。
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const VENDOR = dirname(fileURLToPath(import.meta.url));
const PATCHES = join(VENDOR, 'patches');
const SCOPE = { cordis: '@nexus/cordis', '@cordisjs/plugin-loader': '@nexus/cordis-plugin-loader' };

/** 目標目錄 ← 上游路徑。 */
const COPIES = [
  ['cordis/src', 'packages/core/src'],
  ['cordis/tests', 'packages/core/tests'],
  ['loader/src', 'packages/loader/src'],
];

const [upstream, flag] = process.argv.slice(2);
if (upstream === undefined || (flag !== undefined && flag !== '--check')) {
  console.error('用法：node vendor/sync.mjs <上游 clone> [--check]');
  process.exit(2);
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

function rewrite(dir, transform) {
  for (const file of walk(dir).filter((path) => path.endsWith('.ts'))) {
    const before = readFileSync(file, 'utf8');
    const after = transform(before);
    if (after !== before) writeFileSync(file, after);
  }
}

/** 本地修改第 1 條：core 原始碼的相對 specifier 補上 `.ts`（等同上游 #125）。 */
function explicitExtensions(source) {
  return source
    .replace(/(from |import\(|declare module )'(\.\/[\w/-]+)'/g, "$1'$2.ts'")
    .replace(
      "import type { Context, Service } from '.'\n",
      "import type { Context } from './context.ts'\nimport type { Service } from './service.ts'\n",
    );
}

/** 本地修改第 4 條：指向 vendor 套件的 specifier 換成我們的 scope（照 dsh 第 17 條）。 */
function rescope(source) {
  let out = source;
  for (const [from, to] of Object.entries(SCOPE)) {
    out = out.replace(new RegExp(`(from |import\\(|declare module )'${from.replace(/[/@]/g, '\\$&')}'`, 'g'), `$1'${to}'`);
  }
  return out;
}

const work = mkdtempSync(join(tmpdir(), 'vendor-sync-'));
try {
  // 1. 上游原樣。
  const base = join(work, 'upstream');
  for (const [, from] of COPIES) cpSync(join(upstream, from), join(base, from), { recursive: true });
  // 2. 上游修補，依檔名順序；每一份都是上游 PR 的原樣 diff（只留 packages/core 與 packages/loader）。
  const patches = existsSync(PATCHES) ? readdirSync(PATCHES).filter((name) => name.endsWith('.patch')).sort() : [];
  for (const name of patches) {
    execFileSync('patch', ['-p1', '--forward', '--batch', '-s', '-d', base, '-i', join(PATCHES, name)], { stdio: 'inherit' });
  }
  // 上下文有偏移時 patch 會留 .orig 備份；有 .rej 代表沒套上，直接失敗。
  for (const file of walk(base)) {
    if (file.endsWith('.rej')) throw new Error(`修補沒套上：${file}`);
    if (file.endsWith('.orig')) rmSync(file);
  }
  // 3. 放到 vendor 的形狀，再做機械改寫。
  const out = join(work, 'vendor');
  for (const [to, from] of COPIES) cpSync(join(base, from), join(out, to), { recursive: true });
  // 本地修改第 5 條：上游測試的 tsconfig extends 上游根目錄的設定，那份沒有 vendor；拿掉後 vitest 用套件自己的 tsconfig。
  rmSync(join(out, 'cordis/tests/tsconfig.json'));
  rewrite(join(out, 'cordis/src'), explicitExtensions);
  rewrite(join(out, 'loader/src'), rescope);
  rewrite(join(out, 'cordis/tests'), rescope);

  if (flag === '--check') {
    const rel = (root) => new Set(COPIES.flatMap(([to]) => (existsSync(join(root, to)) ? walk(join(root, to)) : []).map((path) => relative(root, path))));
    const expected = rel(out);
    const actual = rel(VENDOR);
    const diffs = [...new Set([...expected, ...actual])].sort().filter((path) => {
      const a = existsSync(join(out, path)) ? readFileSync(join(out, path), 'utf8') : undefined;
      const b = existsSync(join(VENDOR, path)) ? readFileSync(join(VENDOR, path), 'utf8') : undefined;
      return a !== b;
    });
    for (const path of diffs) console.log(`不同：vendor/${path}`);
    console.log(diffs.length === 0 ? `一致（${expected.size} 個檔，${patches.length} 份修補）` : `${diffs.length} 個檔不同`);
    process.exitCode = diffs.length === 0 ? 0 : 1;
  } else {
    for (const [to] of COPIES) {
      rmSync(join(VENDOR, to), { recursive: true, force: true });
      cpSync(join(out, to), join(VENDOR, to), { recursive: true });
    }
    console.log(`已重建（${patches.length} 份修補）`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

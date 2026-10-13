#!/usr/bin/env node
// 從上游 cordiverse/cordis 的 clone 重建 vendor 的原始碼：複製 → 套 patches/ 裡的上游修補 → 機械改寫。
//
// 用法：
//   node vendor/sync.mjs <上游 clone>           蓋過 vendor/cordis/{src,tests}、vendor/loader/src 與 vendor/include/src
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
  ['include/src', 'packages/include/src'],
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

/**
 * 本地修改第 7 條（include）：關掉寫回，拿掉 HMR 監看。每一處都要在上游原樣裡剛好命中一次，否則同步時直接失敗，
 * 不靜默漏改。理由與涵蓋的測試見 vendor/README.md。
 */
function closeWriteBack(source) {
  const once = (text, from, to) => {
    const parts = text.split(from);
    if (parts.length !== 2) throw new Error(`include 本地修改沒命中（${parts.length - 1} 處）：${from.slice(0, 60)}`);
    return parts.join(to);
  };
  let out = source;
  // HMR 不 vendor（決議 §3-1 第 1 條）：型別宣告與檔案監看都拿掉；樹只由 `patches` 驅動。
  out = once(out, "import type {} from '@cordisjs/plugin-hmr'\n", '');
  out = once(
    out,
    `    ctx.inject(['hmr'], (ctx) => {
      ctx.hmr.watch(this.filename, () => this.refresh())
    })
`,
    '',
  );
  // 寫回路徑 (b)：缺檔時上游把 `initial` 寫成檔。這裡缺檔就是錯，不建檔。
  out = once(
    out,
    `      if (!this.config.initial) {
        throw new Error(\`config file not found: \${this.filename}\`)
      }
      const initial = structuredClone(this.config.initial) as EntryOptions[]
      ensureIds(initial, id => !!this.store[id])
      await this._writeText(this.dump(initial))
      await this._read()
`,
    `      throw new Error(\`config file not found: \${this.filename}\`)
`,
  );
  // 寫回路徑 (a)、(c)：樹側的變更（含 Loader 對插件自我停用的 case 7）不進 journal，也就不會寫檔、不會路由回 patches。
  out = once(
    out,
    `    const parent = change.group === this.root ? null : change.group.ctx.fiber.entry!.options.id
    record(this.journal, change, parent)
    this.dirtyWrite = true
    this._drain()
`,
    '',
  );
  // 縱深：就算 `dirtyWrite` 因別的原因被設起來，迴圈也不呼叫 `_write`（`_write` 留著沒人叫）。
  out = once(
    out,
    `        try {
          await this._write()
        } catch (error) {
          this.ctx.logger.error(error)
        }
`,
    '',
  );
  // 允許名單：疊完 patch 之後才過濾（先疊、後濾——patch 指到允許名單外的列照樣命中，不會多出「找不到」的警告）。
  // `only` 是模組 specifier 的清單；沒給就不濾，等同上游。
  out = once(
    out,
    `    path: string
    initial?: any[]
`,
    `    path: string
    initial?: any[]
    /** nexus 本地修改：只掛 \`name\` 在這份清單裡的列（模組 specifier），疊完 patch 之後才濾。 */
    only?: string[]
`,
  );
  out = once(
    out,
    `    const tree = applyPatches(this.cache.data, this.config.patches, this.warn)
    this._pendingTree = applyJournal(tree, this.journal, undefined, this.warn)
`,
    `    const patched = applyPatches(this.cache.data, this.config.patches, this.warn)
    const only = this.config.only
    const tree = only === undefined ? patched : patched.filter((options) => only.includes(options.name))
    this._pendingTree = applyJournal(tree, this.journal, undefined, this.warn)
`,
  );
  return out;
}

/**
 * 本地修改第 9 條（loader）：宿主可以給一支解析函式，Loader 就不在安裝樹裡寫 `.cordis/resolve.mjs` 輔助檔。
 * 上游的 `createResolve` 會在 `baseUrl` 所屬專案根（這裡是 `apps/harness`）建 `.cordis/{.gitignore,resolve.mjs}`，
 * 唯讀的安裝樹或別的帳號建過時，寫不進去只能退回原生 `import()`；產品路徑不該依賴安裝樹可寫。
 * 每一處都要在上游原樣裡剛好命中一次，沒命中同步直接失敗。理由與涵蓋的測試見 vendor/README.md。
 */
function hostResolver(source, file) {
  const once = (text, from, to) => {
    const parts = text.split(from);
    if (parts.length !== 2) throw new Error(`loader 本地修改沒命中（${file}，${parts.length - 1} 處）：${from.slice(0, 60)}`);
    return parts.join(to);
  };
  if (file === 'index.ts') {
    return once(
      source,
      `  public internal = ModuleLoader.fromInternal()
`,
      `  public internal = ModuleLoader.fromInternal()

  /**
   * nexus 本地修改：宿主給的裸 specifier 解析函式。有就用它，不走 \`createResolve\`（不在安裝樹裡寫 \`.cordis/\`）。
   * 沒給就照上游。
   */
  public resolver?: (specifier: string) => string
`,
    );
  }
  if (file === 'config/tree.ts') {
    return once(
      source,
      `        const resolve = await createResolve(this.ctx.baseUrl)
`,
      `        const resolve = this.ctx.loader.resolver ?? await createResolve(this.ctx.baseUrl)
`,
    );
  }
  return source;
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
  rewrite(join(out, 'include/src'), (source) => rescope(explicitExtensions(source)));
  rewrite(join(out, 'include/src'), (source) => (source.includes('class Include') ? closeWriteBack(source) : source));
  rewrite(join(out, 'cordis/tests'), rescope);
  // 本地修改第 9 條：兩個檔各命中一次。
  for (const file of ['index.ts', 'config/tree.ts']) {
    const path = join(out, 'loader/src', file);
    writeFileSync(path, hostResolver(readFileSync(path, 'utf8'), file));
  }

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

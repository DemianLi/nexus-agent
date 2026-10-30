/**
 * 打包出來的產物裡該有什麼、不該有什麼（[#1502](https://github.com/DemianLi/nexus-agent/issues/1502) 刀 2）。
 *
 * 三道靜態檢查。**1、2 在 `pack`（tar 之前，對著 `pnpm deploy` 的暫存樹）和 `verify-packed-install`（對解開後的安裝樹）各跑一次；
 * 3 只在 `verify-packed-install` 跑**（相依圖走訪要走完整棵樹，打包當下的暫存樹還沒定形）：
 *
 * 1. {@link collectPayloadViolations}：照 dsh `scripts/publication-payload.ts` 拒收 `src/` 與 `.map`，再加上我們自己的必備檔、
 *    不該進閉包的開發工具、相對符號連結要解得開、目標平台的 `node-addon-system` 二進位、內附 ripgrep（#1502 刀 4）與 Linux 的沙箱 spawner（#1946，`spawner.ts`）在。
 * 2. {@link collectClosureViolations}：照 dsh `scripts/verify-runtime-closure.ts`，`cordis.yml`／`cordis.serve.yml` 每一列的
 *    `name:` 都要能從產物根解析到。
 * 3. {@link walkInstalledGraph}：照 dsh `scripts/release/installed-product-isolation.ts:23-57`，從產物根沿 `dependencies`／
 *    `optionalDependencies` 走完整張圖，每個非 optional 的相依都要裝在。
 *
 * **vendor 的 `src/` 放行**（`vendor/cordis`、`include`、`loader`）：dsh 的 vendor `files` 也帶 `src`
 * （`scripts/verify-lib-manifests.ts` 同一條豁免，PR #1641），這裡沿用同一份名單，不另立一份。
 *
 * @module
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { ROOT } from '../workspace-packages.js';
import { spawnerProblems } from './spawner.js';

/** 一條違規：哪個路徑、為什麼。 */
export interface PayloadViolation {
  /** 相對於產物根的路徑。 */
  readonly path: string;
  readonly message: string;
}

/** 檢查的設定。 */
export interface PayloadOptions {
  /**
   * 目標平台的後綴：`node-addon-system` 的二進位套件（例如 `linux-x64-gnu`，用 `includes` 比）與內附 ripgrep 的平台套件
   * `@vscode/ripgrep-<後綴>`（`pack.ts` 傳的是 `${process.platform}-${process.arch}`，要完全相等）都用它查。
   * 注意執行期 `@vscode/ripgrep` 自己挑平台套件看的是 `process.env.npm_config_arch || process.arch`（`lib/index.js:5`）：啟動 serve 的環境若設了
   * `npm_config_arch`，它會去找別的架構的套件、找不到就讓 grep 不可用（啟動日誌那一行會說「不可用」）；打包這一側不看那個變數。`undefined` 代表不查（單元測試用）。
   */
  readonly nativeSuffix?: string;
  /** 允許帶 `src/` 的 vendor 套件名；省略即從 repo 的 `vendor/*` 讀。 */
  readonly vendorNames?: readonly string[];
  /** web 的 `dist` 一定要在；`false` 代表不查（#1653 之前的過渡，與單元測試用）。預設 `true`。 */
  readonly requireWebDist?: boolean;
}

/** 閉包裡不該出現的開發工具（`pnpm deploy --prod` 不會裝；出現就是 `dependencies` 被誤放）。 */
const DEV_TOOLS = /^(tsx|vitest|eslint|typescript|tsdown|vite|prettier|playwright-core)@/u;

/** 產物根的 SBOM 檔名（`sbom.ts` 產生、`verify-packed-install` 核對，#1545 步驟 4）。 */
export const SBOM_FILE = 'sbom.cdx.json';

/**
 * 產物 manifest（產物根的 `package.json`，即 `apps/harness/package.json`）的 `license` 該是什麼，照 dsh
 * `scripts/build-python-release.py:256-259`（`687f282e`）驗 `License-Expression == "MIT"`。
 */
const PRODUCT_LICENSE = 'MIT';

/**
 * 產物根一定要有的檔。授權檔照 dsh `scripts/build-python-release.py`（`687f282e`）的三件事：
 *
 * 1. **複製**（`:180`、`:183`）：`LICENSE` 與 `THIRD_PARTY_NOTICES.md` 複製進產物，我們在 `pack.ts`。
 * 2. **宣告**（`:185-195`）：把 `license-files` 寫進 pyproject。**偏離，理由 1**：npm 的 manifest 沒有對應 `license-files`
 *    的欄位。退到：manifest 的 `license` 欄位（{@link PRODUCT_LICENSE}）加上這裡的必備檔檢查。撤除條件：產物改經 package
 *    manager 安裝、有對應欄位時。
 * 3. **驗證**：`:256-259` 驗 `License-Expression == "MIT"`，我們驗產物 manifest 的 `license`（{@link collectPayloadViolations}）；
 *    `:260-265` 驗 `License-File` 清單，我們驗兩份都在產物根（這份清單）。
 */
const REQUIRED_FILES = [
  'package.json',
  'build-stamp.json',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  SBOM_FILE,
  'cordis.yml',
  'cordis.serve.yml',
  'lib/serve.js',
  'lib/cli.js',
  'lib/plugin-cli.js',
] as const;

/**
 * 產物內附 LGPL 的原生函式庫（sharp 的 `@img/sharp-libvips-*`，`LGPL-3.0-or-later`），那個套件本身不帶授權檔。
 * LGPL-3.0 第 4 節 b) 要求 Combined Work 附上 GPL 與 LGPL 兩份全文，所以兩份都從 repo 複製進產物（`pack.ts`），
 * 少一份就是散布條件沒做到（[#2033](https://github.com/DemianLi/nexus-agent/issues/2033)）。
 */
export const BUNDLED_LICENSE_TEXTS = ['licenses/LGPL-3.0.txt', 'licenses/GPL-3.0.txt'] as const;

/**
 * 網頁打包進去的三顆字型（OFL-1.1）的授權全文，web 的建置放在 `dist/assets/fonts/`（#1713，PR #1717）。
 * OFL 要求散布時附上授權全文，少一份就是散布條件沒做到。
 */
export const WEB_FONT_LICENSES = [
  'Geist-OFL.txt',
  'GeistMono-OFL.txt',
  'NotoSansTC-OFL.txt',
] as const;

/**
 * 刪掉第三方套件自帶的 `.map`（照 dsh `build-exe-for-python-sdk.ts` 的 deployStaging，它也在 staging 刪 `node_modules/**\/*.map`）。
 * 只動 `.pnpm` 裡**不是** workspace 的項目：我們自己的套件帶 `.map` 要讓 {@link collectPayloadViolations} 抓得到，不能被順手掃掉。
 *
 * @param root - 產物根。
 * @returns 刪掉幾個檔。
 */
export function pruneThirdPartyMaps(root: string): number {
  const store = join(root, 'node_modules/.pnpm');
  if (!existsSync(store)) return 0;
  let removed = 0;
  for (const entry of readdirSync(store, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('@nexus+') || entry.name === 'node_modules')
      continue;
    for (const item of walk(join(store, entry.name))) {
      if (!item.directory && !item.link && item.path.endsWith('.map')) {
        rmSync(item.path);
        removed += 1;
      }
    }
  }
  return removed;
}

/**
 * 拿掉 `pnpm deploy` 在私有 hoist 目錄留下的、指回**原始碼樹**的自我連結（`node_modules/.pnpm/node_modules/@nexus/harness`
 * → `<repo>/apps/harness`）。產物根本身就是 harness，沒有人會從這條連結找它；留著它搬到別台機器就是一條斷的絕對路徑，
 * 還洩漏打包機的路徑。只拿這一條，其餘跑出產物外的連結仍由 {@link collectPayloadViolations} 擋。
 *
 * @param root - 產物根。
 * @returns 有沒有拿掉。
 */
export function removeSelfLink(root: string): boolean {
  const link = join(root, 'node_modules/.pnpm/node_modules/@nexus/harness');
  if (!existsSync(link) && !isLinkPath(link)) return false;
  if (!lstatSync(link).isSymbolicLink()) return false;
  rmSync(link);
  return true;
}

/**
 * 拿掉 `node_modules/.pnpm` 底下沒有任何符號連結指進去的項目，回拿掉的項目名（[#2033](https://github.com/DemianLi/nexus-agent/issues/2033)）。
 *
 * isolated 佈局裡套件只能經連結被解析到：沒有連結指進去的項目，Node 從產物的任何位置都解析不到它。`pnpm deploy` 會留下這種項目：
 * 一顆在 workspace lockfile 沒標 `optional` 的套件，只被已經跳過的選用相依引用（sharp 的 wasm 選用鏈帶到的 `tslib`）。
 * 判準只看連結，所以只剪 Node 解析不到的項目：`walkClosure` 漏走的套件仍有連結指著、不會被剪，`sbomProblems` 照樣抓得到。
 * 拿掉一個項目之後，它裡面的連結不再算數，所以重算到沒有新的可拿為止。
 *
 * @param root - 產物根。
 * @returns 拿掉的項目名，依名字排序。
 */
export function pruneUnlinkedStoreEntries(root: string): string[] {
  const store = join(root, 'node_modules/.pnpm');
  if (!existsSync(store)) return [];
  const removed: string[] = [];
  for (;;) {
    const targets: string[] = [];
    for (const item of walk(root)) {
      if (item.link) targets.push(resolve(dirname(item.path), readlinkSync(item.path)));
    }
    const orphans = readdirSync(store, { withFileTypes: true }).filter((entry) => {
      if (!entry.isDirectory() || entry.name === 'node_modules') return false;
      const prefix = join(store, entry.name) + sep;
      return !targets.some((target) => target.startsWith(prefix));
    });
    if (orphans.length === 0) return removed.sort();
    for (const entry of orphans) {
      rmSync(join(store, entry.name), { recursive: true, force: true });
      removed.push(entry.name);
    }
  }
}

function isLinkPath(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** 從 repo 的 `vendor/*` 讀出它們的套件名。 */
export function vendorPackageNames(root: string = ROOT): string[] {
  const base = join(root, 'vendor');
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(base, entry.name, 'package.json')))
    .map(
      (entry) =>
        (
          JSON.parse(readFileSync(join(base, entry.name, 'package.json'), 'utf8')) as {
            name: string;
          }
        ).name,
    );
}

/** 遞迴走一棵樹，不跟符號連結；回每個項目的絕對路徑與型別。 */
function* walk(dir: string): Generator<{ path: string; link: boolean; directory: boolean }> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const link = entry.isSymbolicLink();
    yield { path, link, directory: entry.isDirectory() };
    if (entry.isDirectory()) yield* walk(path);
  }
}

/**
 * 產物樹的靜態內容檢查。
 *
 * @param root - 產物根（`pnpm deploy` 的目標，或解開後的安裝樹）。
 * @param options - 見 {@link PayloadOptions}。
 * @returns 違規清單；空代表全部通過。
 */
export function collectPayloadViolations(
  root: string,
  options: PayloadOptions = {},
): PayloadViolation[] {
  const violations: PayloadViolation[] = [];
  const rel = (path: string): string => relative(root, path).split(sep).join('/');
  const vendor = new Set(options.vendorNames ?? vendorPackageNames());

  for (const file of [...REQUIRED_FILES, ...BUNDLED_LICENSE_TEXTS]) {
    if (!existsSync(join(root, file))) violations.push({ path: file, message: '產物缺這個檔' });
  }
  // 照 dsh `build-python-release.py:256-259` 的 `License-Expression == "MIT"`，見 {@link REQUIRED_FILES} 的三件事。
  const manifestPath = join(root, 'package.json');
  if (existsSync(manifestPath)) {
    const { license } = JSON.parse(readFileSync(manifestPath, 'utf8')) as { license?: unknown };
    if (license !== PRODUCT_LICENSE) {
      violations.push({
        path: 'package.json',
        message: `產物 manifest 的 license 是 ${JSON.stringify(license)}，應為 ${PRODUCT_LICENSE}`,
      });
    }
  }
  if (existsSync(join(root, 'src'))) {
    violations.push({ path: 'src', message: '產物根不收 src/（只收編好的 lib/）' });
  }
  if (options.requireWebDist !== false) {
    const index = join(root, 'node_modules/@nexus/web/dist/index.html');
    if (!existsSync(index)) {
      violations.push({
        path: 'node_modules/@nexus/web/dist/index.html',
        message:
          '網頁 dist 不在產物裡：開網址會是空白頁或 404（先 build，且 apps/web 的 files 要收 dist）',
      });
    }
    for (const file of WEB_FONT_LICENSES) {
      const path = `node_modules/@nexus/web/dist/assets/fonts/${file}`;
      if (!existsSync(join(root, path))) {
        violations.push({
          path,
          message: '網頁打包的字型缺 OFL 授權全文（OFL 要求散布時附上全文，#1713）',
        });
      }
    }
  }

  // 閉包裡有哪些套件（.pnpm 虛擬庫的項目）：開發工具不該在、workspace 套件不收 src。
  const store = join(root, 'node_modules/.pnpm');
  if (existsSync(store)) {
    for (const entry of readdirSync(store)) {
      if (DEV_TOOLS.test(entry)) {
        violations.push({
          path: `node_modules/.pnpm/${entry}`,
          message: '開發工具進了正式閉包（--prod 不該裝它）',
        });
      }
      if (!entry.startsWith('@nexus+')) continue;
      const scoped = join(store, entry, 'node_modules/@nexus');
      if (!existsSync(scoped)) continue;
      for (const name of readdirSync(scoped)) {
        const pkgDir = join(scoped, name);
        if (vendor.has(`@nexus/${name}`)) continue;
        if (existsSync(join(pkgDir, 'src'))) {
          violations.push({
            path: rel(join(pkgDir, 'src')),
            message: `@nexus/${name} 帶了 src/（產物只收 lib/；vendor 之外都不收）`,
          });
        }
      }
    }
  }

  // 目標平台的原生二進位。
  if (options.nativeSuffix !== undefined) {
    const expected = `node-addon-system-${options.nativeSuffix}`;
    const found = existsSync(store)
      ? readdirSync(store).filter((entry) => entry.includes('node-addon-system-'))
      : [];
    if (!found.some((entry) => entry.includes(expected))) {
      violations.push({
        path: 'node_modules/.pnpm',
        message: `缺目標平台的 @deepseek-ai/node-addon-system-${options.nativeSuffix}（找到：${found.join('、') || '無'}）`,
      });
    }
  }

  // 目標平台的內附 ripgrep（#1502 刀 4）：`@vscode/ripgrep` 本體加上它的平台套件，而且那支 `rg` 真的在、有執行權限。
  // 平台套件名是 `@vscode/ripgrep-${platform}-${arch}`（`@vscode/ripgrep/lib/index.js`），跟 `nativeSuffix`（`${platform}-${arch}`）同形。
  // 缺了的話安裝樹裡每一次 grep 都會 SEARCH_FAILED、沒有退路（#1532 的 ENOENT 退路同批拿掉了），所以在打包當下就擋。
  if (options.nativeSuffix !== undefined) {
    const entries = existsSync(store) ? readdirSync(store) : [];
    if (!entries.some((entry) => entry.startsWith('@vscode+ripgrep@'))) {
      violations.push({
        path: 'node_modules/.pnpm',
        message: '缺 @vscode/ripgrep（grep 內附的 ripgrep 不在產物裡）',
      });
    }
    const packageName = `@vscode/ripgrep-${options.nativeSuffix}`;
    const platformEntry = entries.find((entry) =>
      entry.startsWith(`${packageName.replace('/', '+')}@`),
    );
    if (platformEntry === undefined) {
      violations.push({
        path: 'node_modules/.pnpm',
        message: `缺目標平台的 ${packageName}（找到：${entries.filter((entry) => entry.startsWith('@vscode+ripgrep-')).join('、') || '無'}）`,
      });
    } else {
      const binary = join(
        store,
        platformEntry,
        'node_modules',
        packageName,
        'bin',
        options.nativeSuffix.startsWith('win32-') ? 'rg.exe' : 'rg',
      );
      if (!existsSync(binary)) {
        violations.push({ path: rel(binary), message: '內附的 rg 執行檔不在' });
      } else if (
        !options.nativeSuffix.startsWith('win32-') &&
        (lstatSync(binary).mode & 0o111) === 0
      ) {
        violations.push({ path: rel(binary), message: '內附的 rg 沒有執行權限' });
      }
    }
  }

  // 沙箱 spawner（#1946）只在 Linux 上跑，所以只有 Linux 的產物要帶。
  if (options.nativeSuffix?.startsWith('linux-') === true) {
    violations.push(...spawnerProblems(root, options.nativeSuffix.slice('linux-'.length)));
  }

  // 整棵樹：.map、符號連結。
  const realRoot = realpathSync(root);
  for (const item of walk(root)) {
    if (item.path.endsWith('.map') && !item.directory) {
      violations.push({ path: rel(item.path), message: '產物不收 .map' });
    }
    if (!item.link) continue;
    const target = readlinkSync(item.path);
    if (isAbsolute(target)) {
      violations.push({
        path: rel(item.path),
        message: `符號連結是絕對路徑：${target}（搬到別處就斷）`,
      });
      continue;
    }
    const resolved = resolve(dirname(item.path), target);
    if (!existsSync(resolved)) {
      violations.push({ path: rel(item.path), message: `符號連結解不開：${target}` });
    } else if (!(realpathSync(resolved) + sep).startsWith(realRoot + sep)) {
      violations.push({ path: rel(item.path), message: `符號連結跑到產物外面：${target}` });
    }
  }
  return violations;
}

/** `yaml` 是 apps/harness 的相依，不在根 `node_modules`：從 harness 的位置解。 */
const parseYaml = (
  createRequire(join(ROOT, 'apps/harness/package.json'))('yaml') as {
    parse: (text: string) => unknown;
  }
).parse;

/**
 * 出貨清單要載入的列，其 `name:` 取出來。
 *
 * 照 dsh `scripts/verify-runtime-closure.ts:158-174` 的 `activeBarePluginPackages`：真的解析 YAML，逐列看 `disabled`——停用的列
 * 不載入，不要求它解得到。**遇到認不得的結構就報錯，不准跳過**（今天 `cordis.yml` 沒有 group、也沒有停用的列；以後加了，這裡
 * 不能靜靜漏查）：
 *
 * - 根不是陣列、列不是物件、`name` 不是非空字串；
 * - `disabled` 不是布林（我們只收字面布林，不接 dsh 的 `__jsExpr`，見 `cordis.yml` 檔頭 #104 的偏離標註）；
 * - 列帶了 `group`、或 `config` 是陣列（dsh 的 group 形狀：`isCordisGroupEntry` 在 `scripts/cordis-yaml.ts:48-54`；我們沒有 group，
 *   見 `plugin-config.ts` 的註解）。
 *
 * @param text - `cordis.yml` 或 `cordis.serve.yml` 的原文。
 * @returns 依序的名字（`@nexus/...`、子路徑、`#settings/...` 都原樣）。
 * @throws 結構認不得。
 */
export function shippedNames(text: string): string[] {
  const document = parseYaml(text);
  // 空檔（或只有註解）是空清單；兩份合起來一列都沒有，{@link collectClosureViolations} 會報。
  if (document === null || document === undefined) return [];
  if (!Array.isArray(document)) throw new Error('出貨清單的根不是陣列，認不得這個結構');
  const names: string[] = [];
  for (const [index, row] of (document as unknown[]).entries()) {
    const where = `第 ${String(index + 1)} 列`;
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      throw new Error(`出貨清單${where}不是物件，認不得這個結構`);
    }
    const entry = row as Record<string, unknown>;
    if ('group' in entry || Array.isArray(entry.config)) {
      throw new Error(
        `出貨清單${where}（id: ${String(entry.id)}）是 group 形狀；這裡沒有 group，要先讓 shippedNames 認得它，不准跳過`,
      );
    }
    if (typeof entry.name !== 'string' || entry.name === '') {
      throw new Error(`出貨清單${where}（id: ${String(entry.id)}）沒有字串 name`);
    }
    if (entry.disabled !== undefined && typeof entry.disabled !== 'boolean') {
      throw new Error(
        `出貨清單${where}（id: ${String(entry.id)}）的 disabled 不是字面布林：${JSON.stringify(entry.disabled)}`,
      );
    }
    if (entry.disabled === true) continue;
    names.push(entry.name);
  }
  return names;
}

/**
 * 出貨清單每一列都要能從產物根解析到。
 *
 * 在產物根開一個純 `node`（`cwd` 是產物根）用 `import.meta.resolve` 解，所以走的是真的 Node 解析（`exports` 條件、`imports` 的
 * `#settings/*`），不是自己猜檔案在哪。
 *
 * @param root - 產物根。
 * @returns 違規清單。
 */
export function collectClosureViolations(root: string): PayloadViolation[] {
  const names: string[] = [];
  for (const file of ['cordis.yml', 'cordis.serve.yml']) {
    const path = join(root, file);
    if (existsSync(path)) names.push(...shippedNames(readFileSync(path, 'utf8')));
  }
  if (names.length === 0) {
    return [{ path: 'cordis.yml', message: '讀不到任何一列的 name:（解析規則壞了或檔案空了）' }];
  }
  // `import.meta.resolve` 對 `exports`／`imports` 指到的檔不查存在，所以解出來的 URL 還要自己確認檔在。
  const script =
    "import { existsSync } from 'node:fs';\n" +
    "import { fileURLToPath } from 'node:url';\n" +
    `const names = ${JSON.stringify(names)};\n` +
    'const bad = [];\n' +
    'for (const name of names) {\n' +
    '  try {\n' +
    '    const url = import.meta.resolve(name);\n' +
    "    if (url.startsWith('file:') && !existsSync(fileURLToPath(url))) bad.push(name + ': 檔不在 ' + url);\n" +
    '  } catch (error) { bad.push(name + ": " + error.code); }\n' +
    '}\n' +
    'console.log(JSON.stringify(bad));\n';
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  const out = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
  const bad = JSON.parse(out) as string[];
  return bad.map((entry) => ({
    path: 'cordis.yml',
    message: `出貨清單的 ${entry}：產物裡解析不到`,
  }));
}

interface InstalledManifest {
  readonly name: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly peerDependenciesMeta?: Readonly<Record<string, { optional?: boolean }>>;
}

/** 沿 `from` 的祖先 `node_modules` 找一個套件的目錄。 */
export function installedPackage(from: string, name: string): string | undefined {
  const resolver = createRequire(join(from, 'package.json'));
  for (const directory of resolver.resolve.paths(name) ?? []) {
    const candidate = join(directory, name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  }
  return undefined;
}

/**
 * 從產物根走完整張相依圖，每個必要的相依都要在。
 *
 * 缺的只有三種可以略過：`optionalDependencies`、`dependencies` 裡同時列在 `optionalDependencies` 的、標了 optional 的 peer。
 * 平台二進位套件就是 optional：非目標平台的不裝是對的。
 *
 * @param root - 產物根。
 * @returns 缺的相依，每條帶著從根走過來的鏈；空代表圖是完整的。另外回走過幾個不同的套件。
 */
export function walkInstalledGraph(root: string): { missing: string[]; visited: number } {
  const visited = new Set<string>();
  const missing: string[] = [];
  const queue = [{ directory: root, chain: [] as string[] }];
  for (const item of queue) {
    const canonical = realpathSync(item.directory);
    if (visited.has(canonical)) continue;
    visited.add(canonical);
    const manifest = JSON.parse(
      readFileSync(join(canonical, 'package.json'), 'utf8'),
    ) as InstalledManifest;
    const chain = [...item.chain, manifest.name];
    for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
      for (const name of Object.keys(manifest[section] ?? {})) {
        const dependency = installedPackage(canonical, name);
        if (dependency === undefined) {
          const optional =
            section === 'optionalDependencies' ||
            Object.hasOwn(manifest.optionalDependencies ?? {}, name) ||
            (section === 'peerDependencies' &&
              manifest.peerDependenciesMeta?.[name]?.optional === true);
          if (!optional) missing.push([...chain, name].join(' -> '));
          continue;
        }
        queue.push({ directory: dependency, chain });
      }
    }
  }
  return { missing, visited: visited.size };
}

/** 供 CLI 與測試判斷：`lstat` 是否為符號連結。 */
export function isSymlink(path: string): boolean {
  return lstatSync(path).isSymbolicLink();
}

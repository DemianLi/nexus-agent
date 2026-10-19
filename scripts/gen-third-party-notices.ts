/**
 * 從 workspace 的 manifest 產生 `THIRD_PARTY_NOTICES.md`（[#1545](https://github.com/DemianLi/nexus-agent/issues/1545)），
 * 照 dsh（687f282e）`scripts/gen-third-party-notices.ts`：
 *
 * - 列每個 workspace `package.json` **直接**宣告的外部套件，分兩層：執行期（`dependencies`／`optionalDependencies`，或被網頁
 *   build 打包進去）與只在開發時用的（dsh `:23-42` 的 `RUNTIME_KINDS`、`DEV_ONLY_AREAS`、`:416-436` 的 `tierExternalDeps`）。
 *   完整的遞移閉包在 `pnpm-lock.yaml`，這裡刻意不列（dsh 的決策筆記 `2026-07-30-generated-third-party-notices.zh.md`）。
 * - 網頁打包進去的第三方套件用真的 vite build（`write: false`）收：first-party 檔案直接 import 到哪個第三方套件，那個套件就是
 *   執行期的（dsh `scripts/browser-bundled-externals.ts:35-59`、`:127-161`）。
 * - 授權 allowlist 照 dsh `:652-699`（`PERMISSIVE_LICENSES`、`isPermissive`、`assertRuntimeLicenses`）：執行期那層的授權
 *   不在清單上就硬失敗；開發那層只標註。
 * - vendor 的原始碼另列一段（dsh `:438-493`）：`vendor/` 的 Cordis，以及網頁的 solid-glass。
 *
 * 套件的 license 與 repository 讀安裝好的 store，所以要先 `pnpm install`。`--check` 只比對、不寫檔。
 *
 * 跟 dsh 不同、但不是偏離的地方（nexus 沒有那些東西）：沒有 Python、沒有 Claude SDK 與 LibreOffice 的授權例外（字型的 OFL 例外照 LibreOffice 那一條的形狀，見 `OFL_FONT_PACKAGES`）、沒有
 * `patchedDependencies`。dsh 的「web 不是 private 才收」換成「網頁 dist 會進 tarball」：nexus 的 `apps/web` 是 private，
 * 但它的 `dist` 由 `scripts/release/payload.ts` 確認一定在產物裡。dsh `:420-421` 把 `tsx` 硬標成執行期（它的根腳本經 tsx 的
 * ESM hook 跑）；nexus 的產物不帶 tsx（`scripts/release/payload.ts` 的 `DEV_TOOLS` 把它當開發工具擋），所以不抄。dsh `:44-50`
 * 的 `FIRST_PARTY`（`:404` 過濾掉）列的是 dsh 自己發布的原生套件；nexus 自己的套件全在 workspace 裡，`names` 已經排除，沒有要另列的。
 *
 * SPDX 運算式用 dsh 同一顆 `spdx-expression-parse` 解（dsh 根 `package.json` 的 devDependencies）。
 */

import {
  existsSync,
  globSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import parseSpdx from 'spdx-expression-parse';

import { ROOT } from './workspace-packages.js';

export const OUT = 'THIRD_PARTY_NOTICES.md';

/** 消費端執行期會解析的宣告種類。 */
const RUNTIME_KINDS = ['dependencies', 'optionalDependencies'] as const;
/** 這個檔要揭露的所有宣告種類。 */
const ALL_KINDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

/** 不會交到使用者手上的 workspace 區域：根 manifest 只放 repo 的工具與 gate。 */
const DEV_ONLY_AREAS = ['package.json'] as const;

/**
 * 網頁打包的字型套件，宣告 OFL-1.1。OFL 不在 `PERMISSIVE_LICENSES` 上，這裡只對**這三個套件名、而且授權剛好是 `OFL-1.1`**
 * 放行，不把 OFL 加進清單（形狀照 dsh 對 LibreOffice 的 `LIBREOFFICE_PACKAGES`，`:57-65`、`:695`）。
 * 裁決見 [#1545 issuecomment-6254467463](https://github.com/DemianLi/nexus-agent/issues/1545#issuecomment-6254467463)。
 */
const OFL_FONT_PACKAGES: ReadonlySet<string> = new Set([
  '@fontsource-variable/geist',
  '@fontsource-variable/geist-mono',
  '@fontsource-variable/noto-sans-tc',
]);
const OFL_LICENSE = 'OFL-1.1';

/** store 答不出來時的補值。每一條寫為什麼。 */
const OVERRIDES: Record<string, { license?: string; repo?: string }> = {
  // 發布的 manifest 沒有 repository 也沒有 homepage（0.0.18），照 dsh `:89-90` 對 node-addon-require-builtin 的做法指 npm 頁面。
  '@langchain/protocol': { repo: 'https://www.npmjs.com/package/@langchain/protocol' },
};

export interface Manifest {
  name?: string;
  version?: string;
  private?: boolean;
  license?: string;
  repository?: string | { url?: string };
  homepage?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

interface ExternalDep {
  name: string;
  license: string;
  repo: string;
  runtime: boolean;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** `yaml` 是 apps/harness 的相依，不在根 `node_modules`：從 harness 的位置解（同 `scripts/release/payload.ts`）。 */
const parseYaml = (
  createRequire(join(ROOT, 'apps/harness/package.json'))('yaml') as {
    parse: (text: string) => unknown;
  }
).parse;

/** `pnpm-workspace.yaml` 宣告的成員 glob：新增一個區域那天就會被讀到，不在這裡另列。 */
function workspaceMembers(): string[] {
  const declared = (
    parseYaml(readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8')) as { packages?: unknown }
  ).packages;
  if (!Array.isArray(declared) || declared.length === 0) {
    throw new Error(
      'gen-third-party-notices：pnpm-workspace.yaml 沒有宣告成員，推不出 manifest 集合。',
    );
  }
  return declared.map(String);
}

/** 每一份 workspace manifest（以 repo 相對路徑為鍵，分隔符一律 `/`）與所有 workspace 套件名。 */
function loadWorkspaceManifests(): { manifests: Map<string, Manifest>; names: Set<string> } {
  const manifests = new Map<string, Manifest>();
  const names = new Set<string>();
  for (const pattern of [
    'package.json',
    ...workspaceMembers().map((member) => `${member}/package.json`),
  ]) {
    for (const path of globSync(pattern, { cwd: ROOT }).sort()) {
      const normalized = path.replaceAll('\\', '/');
      const manifest = readJson<Manifest>(join(ROOT, normalized));
      manifests.set(normalized, manifest);
      if (manifest.name !== undefined) names.add(manifest.name);
    }
  }
  if (manifests.size < 10) {
    throw new Error(
      `gen-third-party-notices：只找到 ${manifests.size} 份 workspace manifest，glob 過期了。`,
    );
  }
  return { manifests, names };
}

/**
 * 把每一個外部相依分層。
 * @param manifests - workspace manifest，以 repo 相對路徑為鍵。
 * @param names - workspace 套件名，不算外部。
 * @param browser - 網頁 build 直接打包的第三方套件。
 * @returns 套件名 → 是不是執行期相依。
 */
export function tierExternalDeps(
  manifests: Map<string, Manifest>,
  names: ReadonlySet<string>,
  browser: ReadonlySet<string> = new Set(),
): Map<string, boolean> {
  const tiers = new Map<string, boolean>();
  for (const [path, manifest] of manifests) {
    const devOnly = DEV_ONLY_AREAS.some((area) =>
      area.endsWith('/') ? path.startsWith(area) : path === area,
    );
    for (const kind of ALL_KINDS) {
      for (const [dep, range] of Object.entries(manifest[kind] ?? {})) {
        if (names.has(dep) || range.startsWith('workspace:')) continue;
        const runtime =
          browser.has(dep) || (!devOnly && (RUNTIME_KINDS as readonly string[]).includes(kind));
        tiers.set(dep, (tiers.get(dep) ?? false) || runtime);
      }
    }
  }
  for (const name of browser) {
    if (!names.has(name) && !tiers.has(name)) {
      throw new Error(
        `gen-third-party-notices：網頁打包了 ${name}，但沒有任何 workspace manifest 宣告它`,
      );
    }
  }
  return tiers;
}

/** 宣告它的 workspace 底下連結的那一份（不是 store 裡別的歷史版本）。 */
function installedManifest(name: string, manifests: Map<string, Manifest>): Manifest | undefined {
  for (const [path, manifest] of manifests) {
    if (!ALL_KINDS.some((kind) => name in (manifest[kind] ?? {}))) continue;
    const linked = join(ROOT, dirname(path), 'node_modules', name, 'package.json');
    if (existsSync(linked)) return readJson<Manifest>(linked);
  }
  const direct = join(ROOT, 'node_modules', name, 'package.json');
  if (existsSync(direct)) return readJson<Manifest>(direct);
  const virtual = join(ROOT, 'node_modules/.pnpm');
  if (!existsSync(virtual)) return undefined;
  const prefix = `${name.replace('/', '+')}@`;
  for (const entry of readdirSync(virtual).filter((dir) => dir.startsWith(prefix))) {
    const candidate = join(virtual, entry, 'node_modules', name, 'package.json');
    if (existsSync(candidate)) return readJson<Manifest>(candidate);
  }
  return undefined;
}

/**
 * manifest 的 repository／homepage 正規化成可瀏覽的 https 網址（dsh `:385-396`）。
 *
 * **偏離 dsh**（理由 1，dsh 在這一格有同一個洞、沒有正確行為可抄，口徑同 #1518）：dsh 沒處理 scp 形式的 `git@host:org/repo`，
 * 會產出 `https://github.com/git@github.com:…`；這裡多一條 replace 補上，其餘照 dsh。
 */
export function normalizeRepo(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === '') return undefined;
  let url = raw
    .replace(/^git\+ssh:\/\/git@/, 'https://')
    // scp 形式的 `git@github.com:org/repo`：偏離，見上。
    .replace(/^(?:git\+)?git@([^:/]+):/, 'https://$1/')
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^github:/, 'https://github.com/')
    .replace(/\.git$/, '');
  if (!url.startsWith('http')) url = `https://github.com/${url}`;
  return url;
}

function installedMetadata(
  name: string,
  manifests: Map<string, Manifest>,
): { license: string; repo: string } {
  const override = OVERRIDES[name];
  const manifest = installedManifest(name, manifests);
  const license = override?.license ?? manifest?.license;
  const rawRepo =
    typeof manifest?.repository === 'string'
      ? manifest.repository
      : (manifest?.repository?.url ?? manifest?.homepage);
  const repo = override?.repo ?? normalizeRepo(rawRepo);
  if (license === undefined || repo === undefined) {
    throw new Error(
      `gen-third-party-notices：讀不到 ${name} 的 ${license === undefined ? 'license' : 'repository'}；先 \`pnpm install\`，或在 OVERRIDES 補一條並寫理由。`,
    );
  }
  return { license, repo };
}

/** SPDX identifiers 這個專案不必另外審就能出貨的授權（dsh `:653`，原樣）。 */
export const PERMISSIVE_LICENSES: ReadonlySet<string> = new Set([
  'MIT',
  'MIT-CMU',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  '0BSD',
  'Unlicense',
  'CC0-1.0',
  'BlueOak-1.0.0',
  'Python-2.0',
  'PSF-2.0',
]);

/** 剖析後的 SPDX 運算式照這個專案的授權政策判（dsh `:655-665`，原樣）。 */
function isPermissiveSpdx(expression: ReturnType<typeof parseSpdx>): boolean {
  if ('conjunction' in expression) {
    return expression.conjunction === 'and'
      ? isPermissiveSpdx(expression.left) && isPermissiveSpdx(expression.right)
      : isPermissiveSpdx(expression.left) || isPermissiveSpdx(expression.right);
  }
  return (
    expression.plus !== true &&
    expression.exception === undefined &&
    PERMISSIVE_LICENSES.has(expression.license)
  );
}

/**
 * SPDX 運算式給的條件這個專案能不能出貨（dsh `:667-685`）。`OR` 有一支合格就合格（消費端自己選），`AND` 每一支都要合格
 * （每一項義務都成立）。copyleft、帶例外條款、清單上沒見過的授權都是 false：認不得就不放行。
 * @param license - 套件 manifest 的 SPDX 運算式。
 * @returns 每一項義務都是寬鬆授權時為 true。
 */
export function isPermissive(license: string): boolean {
  // 有些 npm manifest 用斜線表示二選一，SPDX 的寫法是 `OR`。
  const normalized = license.replace(/\s*\/\s*/g, ' OR ').trim();
  try {
    return isPermissiveSpdx(parseSpdx(normalized));
  } catch {
    return false;
  }
}

/**
 * 執行期相依的授權不是寬鬆授權就擋下（dsh `:687-699`）。例外只有 `OFL_FONT_PACKAGES` 宣告 `OFL-1.1` 的那三顆。
 * @throws 有任何一顆不合格時。
 */
export function assertRuntimeLicenses(
  dependencies: readonly { name: string; license: string }[],
): void {
  const rejected = dependencies.filter(
    (dep) =>
      !isPermissive(dep.license) &&
      !(OFL_FONT_PACKAGES.has(dep.name) && dep.license === OFL_LICENSE),
  );
  if (rejected.length > 0) {
    throw new Error(
      `gen-third-party-notices：執行期相依 ${rejected.map((dep) => `${dep.name}（${dep.license}）`).join('、')} 不是寬鬆授權；先審過發佈條件並記下決定，再重新產生。`,
    );
  }
}

/** bundler 解析出來的檔案屬於哪個安裝的套件；workspace 與虛擬模組回 undefined（dsh `browser-bundled-externals.ts:27-33`）。 */
export function browserPackageOfFile(file: string): string | undefined {
  const normalized = file.replaceAll('\\', '/');
  const marker = normalized.lastIndexOf('/node_modules/');
  if (marker < 0) return undefined;
  const parts = normalized.slice(marker + '/node_modules/'.length).split('/');
  return parts[0]?.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

interface ResolveContext {
  resolve(
    source: string,
    importer: string,
    options: { skipSelf: boolean },
  ): Promise<{ id: string } | null>;
}

/**
 * 記下 first-party 檔案直接 import 的第三方套件，並把它們標成 external：揭露的是直接相依，上游自己的 import 留在 lockfile
 * （dsh `browser-bundled-externals.ts:35-59`，`followWorkspace` 為 true 的那一支：workspace 套件照常解析、往裡面走）。
 */
function recorder(seen: Set<string>) {
  return {
    name: 'nexus-browser-direct-dependencies',
    enforce: 'pre' as const,
    resolveId: {
      order: 'pre' as const,
      async handler(this: ResolveContext, source: string, importer: string | undefined) {
        if (
          importer === undefined ||
          source.startsWith('.') ||
          source.startsWith('/') ||
          source.startsWith('\0') ||
          source.startsWith('node:')
        ) {
          return null;
        }
        const resolved = await this.resolve(source, importer, { skipSelf: true });
        if (resolved === null) throw new Error(`browser notices：從 ${importer} 解不開 ${source}`);
        const owner = browserPackageOfFile(resolved.id);
        if (owner === undefined) return resolved;
        if (browserPackageOfFile(importer) === undefined) seen.add(owner);
        return { id: source, external: true };
      },
    },
  };
}

/** 裸 specifier 的套件名：`@scope/name/sub` → `@scope/name`、`name/sub` → `name`。 */
function packageOfSpecifier(specifier: string): string {
  const parts = specifier.split('/');
  return (specifier.startsWith('@') ? parts.slice(0, 2) : parts.slice(0, 1)).join('/');
}

/**
 * 一段 CSS 引用的套件。兩種：
 * - `@import`／`@plugin` 的裸 specifier：一定是套件；
 * - `url(…)` 裡的路徑：CSS 的 `url(foo.png)` 本來就是相對路徑，所以只有 `installed(套件名)` 為真的才算
 *   （`url('@fontsource-variable/geist/files/…woff2')` 這種）。
 * 相對路徑、絕對路徑、網址與 `data:` 都不算；註解先拿掉。
 * @param css - 樣式表全文。
 * @param installed - 這個名字是不是已安裝的套件。
 * @returns 套件名。
 */
export function cssBareImportsIn(css: string, installed: (name: string) => boolean): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const local = (specifier: string): boolean => /^(\.|\/|#|[a-z][a-z0-9+.-]*:)/i.test(specifier);
  const found: string[] = [];
  for (const match of text.matchAll(/^\s*@(?:import|plugin)\s+(?:url\()?\s*['"]([^'"]+)['"]/gm)) {
    const specifier = match[1];
    if (specifier !== undefined && !local(specifier)) found.push(packageOfSpecifier(specifier));
  }
  for (const match of text.matchAll(/url\(\s*['"]?([^'")\s]+)/g)) {
    const specifier = match[1];
    if (specifier === undefined || local(specifier)) continue;
    const name = packageOfSpecifier(specifier);
    if (installed(name)) found.push(name);
  }
  return found;
}

/**
 * **偏離 dsh，理由 1（基座表達不出來）。** dsh 只靠上面的 `recorder` 掛在 vite 的 `resolveId` 上收集。nexus 的樣式走 Tailwind 4
 * 的 `@tailwindcss/vite`：它用自己的解析器處理 CSS 的 `@import`／`@plugin`，vite 解 CSS 的 `url()` 也走內部解析器，兩者都不經
 * 使用者外掛的 `resolveId`，所以 `tailwindcss`、`tw-animate-css`、`@fontsource-variable/*` 這些整份打包進 `dist` 的套件 recorder
 * 一個都收不到，會被歸進開發用的那一層（實測：補這一段之前，字型被寫成「只在開發時當工具跑」）。退到：另外掃 `apps/web/src`
 * 底下每一份 `.css` 的裸 `@import`／`@plugin` 與指到已安裝套件的 `url()`。
 * 掃全部 `.css` 而不是跟著 `@import` 圖走，寧可多列，不可漏列。
 */
function cssBareImports(webDir: string): Set<string> {
  const names = new Set<string>();
  const installed = (name: string): boolean =>
    existsSync(join(webDir, 'node_modules', name, 'package.json'));
  for (const path of globSync('src/**/*.css', { cwd: webDir })) {
    for (const name of cssBareImportsIn(readFileSync(join(webDir, path), 'utf8'), installed))
      names.add(name);
  }
  return names;
}

interface ViteApi {
  build(config: Record<string, unknown>): Promise<unknown>;
}

/** 網頁 build 直接打包的第三方套件：用 `apps/web` 自己的 vite 設定真的 build 一次，不寫檔（dsh `:127-161`）。 */
export async function browserBundledExternals(): Promise<Set<string>> {
  // vite 經原生 realpath 解析 HTML，root 先 realpath，路徑比對才一致（dsh `:169-170`）。
  const dir = realpathSync.native(join(ROOT, 'apps/web'));
  const vitePath = createRequire(join(dir, 'package.json')).resolve('vite');
  const vite = (await import(pathToFileURL(vitePath).href)) as ViteApi;
  const seen = new Set<string>(cssBareImports(dir));
  await vite.build({
    root: dir,
    logLevel: 'error',
    plugins: [recorder(seen)],
    build: {
      write: false,
      minify: false,
      sourcemap: false,
      reportCompressedSize: false,
      rollupOptions: { output: { manualChunks: () => undefined } },
    },
  });
  return seen;
}

/** 一列 vendor 的原始碼。 */
export interface VendoredRow {
  npmName: string;
  upstreamName: string;
  upstream: string;
  sourceDirectory: string;
}

/**
 * 讀 `vendor/README.md` 的清單表（`| 目錄 | 套件名 | 上游套件名 | 版本 | 上游 | commit |`）。
 * @returns 表裡每一列，照表的順序。
 */
export function parseVendoredRows(text: string): Omit<VendoredRow, 'sourceDirectory'>[] {
  const rows: Omit<VendoredRow, 'sourceDirectory'>[] = [];
  const pattern =
    /^\| `(\S+)\/` \| `([^`]+)` \| `([^`]+)` \| \S+ \| (https:\/\/\S+?)(?:（[^）]*）)? \| `[0-9a-f]+` \|$/;
  for (const line of text.split('\n')) {
    const match = pattern.exec(line);
    if (match === null) continue;
    const [, , npmName, upstreamName, upstream] = match;
    if (npmName === undefined || upstreamName === undefined || upstream === undefined) continue;
    rows.push({ npmName, upstreamName, upstream });
  }
  return rows;
}

/**
 * 解析清單表並確認 `vendor/` 底下每個目錄都有一列：要揭露的是目錄，不是表，所以表的格式變了要當場錯，不能讓套件
 * 靜靜從清單上消失（dsh `:464-493`）。
 */
function collectVendored(): VendoredRow[] {
  const rows = parseVendoredRows(readFileSync(join(ROOT, 'vendor/README.md'), 'utf8'));
  const onDisk = new Map<string, string>();
  for (const entry of readdirSync(join(ROOT, 'vendor'), { withFileTypes: true })) {
    if (!entry.isDirectory() || !existsSync(join(ROOT, 'vendor', entry.name, 'package.json')))
      continue;
    const manifest = readJson<Manifest>(join(ROOT, 'vendor', entry.name, 'package.json'));
    if (manifest.name !== undefined) onDisk.set(manifest.name, entry.name);
  }
  const parsed = new Set(rows.map((row) => row.npmName));
  const missing = [...onDisk.keys()].filter((name) => !parsed.has(name));
  if (missing.length > 0) {
    throw new Error(
      `gen-third-party-notices：vendor/README.md 的清單表沒有 ${missing.join('、')}；表的格式變了，或同步沒做完。`,
    );
  }
  return rows.map((row) => {
    const dir = onDisk.get(row.npmName);
    if (dir === undefined)
      throw new Error(
        `gen-third-party-notices：vendor/README.md 列的 ${row.npmName} 沒有 vendor/ 目錄。`,
      );
    const license = readJson<Manifest>(join(ROOT, 'vendor', dir, 'package.json')).license;
    if (license !== 'MIT') {
      throw new Error(
        `gen-third-party-notices：vendor 的 ${row.npmName} 宣告 ${JSON.stringify(license)}；這一段假設全部是 MIT。`,
      );
    }
    return { ...row, sourceDirectory: `vendor/${dir}` };
  });
}

const SOLID_GLASS_DIR = 'apps/web/src/vendor/solid-glass';

/** 網頁 vendor 的 solid-glass 與 shadcn 的 tailwind.css：上游與版本只記在 `manifest.json` 的 `sources`。 */
function collectWebVendored(): { name: string; upstream: string; pin: string; license: string }[] {
  const { sources } = readJson<{
    sources: Record<string, { upstream: string; commit?: string; version?: string }>;
  }>(join(ROOT, SOLID_GLASS_DIR, 'manifest.json'));
  const licenseOf = (file: string): string => {
    const first = readFileSync(join(ROOT, file), 'utf8').split('\n')[0]?.trim();
    if (first !== 'MIT License')
      throw new Error(`gen-third-party-notices：${file} 不是 MIT 授權全文（第一行是 ${first}）。`);
    return 'MIT';
  };
  const licenseFiles: Record<string, string> = {
    'solid-glass': `${SOLID_GLASS_DIR}/LICENSE`,
    shadcn: `${SOLID_GLASS_DIR}/shadcn/LICENSE.md`,
  };
  return Object.entries(sources).map(([name, source]) => {
    const file = licenseFiles[name];
    if (file === undefined)
      throw new Error(
        `gen-third-party-notices：solid-glass 的 manifest 多了來源 ${name}，這裡不知道它的授權檔。`,
      );
    const pin =
      source.commit !== undefined ? `\`${source.commit.slice(0, 12)}\`` : `${source.version}`;
    return { name, upstream: source.upstream, pin, license: licenseOf(file) };
  });
}

function renderNpmTable(deps: ExternalDep[]): string {
  const lines = ['| 套件 | 授權 |', '| --- | --- |'];
  for (const dep of deps) lines.push(`| [\`${dep.name}\`](${dep.repo}) | ${dep.license} |`);
  return lines.join('\n');
}

/** 字型那一段：只在 `OFL_FONT_PACKAGES` 有出現在執行期那層時才產生（照 dsh `:805-811` 的 LibreOffice 段落）。 */
function renderOflFonts(runtimeDeps: readonly ExternalDep[]): string {
  const fonts = runtimeDeps.filter((dep) => OFL_FONT_PACKAGES.has(dep.name));
  if (fonts.length === 0) return '';
  return `
## 網頁的字型

${fonts.map((dep) => `\`${dep.name}\``).join('、')} 宣告 SIL Open Font License 1.1（\`OFL-1.1\`），不在寬鬆授權的清單上；檢查只對這幾個套件名、而且授權剛好是 \`OFL-1.1\` 時放行。字型檔（\`.woff2\`）打包進網頁的 \`dist\`。

OFL 允許字型跟著軟體一起散布、也允許內嵌，條件是：不能單獨販售字型本身；散布時要附上原本的著作權聲明與 OFL 全文；修改過的字型不能沿用保留的字型名稱。

這個例外的決議記錄：[#1545 issuecomment-6254467463](https://github.com/DemianLi/nexus-agent/issues/1545#issuecomment-6254467463)。
`;
}

function renderNonPermissiveNote(deps: ExternalDep[]): string {
  if (deps.length === 0) return '';
  const named = deps.map((dep) => `\`${dep.name}\`（${dep.license}）`).join('、');
  return `\n${named} 只在開發時當工具跑，程式碼不會連結進、也不會隨 nexus 的任何產物發出去。\n`;
}

/**
 * 組出完整的清單。
 * @returns `THIRD_PARTY_NOTICES.md` 應有的內容。
 */
export async function render(): Promise<string> {
  const browser = await browserBundledExternals();
  const { manifests, names } = loadWorkspaceManifests();
  const npm: ExternalDep[] = [];
  const unresolved: string[] = [];
  for (const [name, runtime] of [...tierExternalDeps(manifests, names, browser)].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    try {
      npm.push({ name, ...installedMetadata(name, manifests), runtime });
    } catch (error) {
      unresolved.push((error as Error).message);
    }
  }
  // 一次列完，不要補一條、重跑、再撞下一條。
  if (unresolved.length > 0) throw new Error(unresolved.join('\n'));
  const runtimeDeps = npm.filter((dep) => dep.runtime);
  const devDeps = npm.filter((dep) => !dep.runtime);
  assertRuntimeLicenses(runtimeDeps);
  const vendored = collectVendored();
  const webVendored = collectWebVendored();

  return `<!-- 由 scripts/gen-third-party-notices.ts 產生，不要手改。
     改了相依之後跑 \`pnpm run gen-third-party-notices\` 重新產生。 -->

# 第三方元件

nexus-agent 用到下列第三方軟體。每個專案各自適用自己的授權，這個檔不改變任何授權條件。

這裡列的是 workspace **直接**宣告的相依。檔案由 \`scripts/gen-third-party-notices.ts\` 產生，\`apps/harness/src/third-party-notices.test.ts\` 在測試裡斷言進版控的內容跟重新產生的一致。改了相依跑 \`pnpm run gen-third-party-notices\`；只想檢查就跑 \`pnpm run verify-third-party-notices\`。

完整的遞移閉包連同精確版本記在 [\`pnpm-lock.yaml\`](pnpm-lock.yaml)，可以用 \`pnpm licenses list\` 查看。

## vendor 的原始碼

### \`vendor/\`

Cordis 框架與它的 Loader、Include 以原始碼複製進 repo，不經 npm 安裝，改名放在 \`@nexus\` scope 底下。三個都是 MIT，每個目錄保留上游的 \`LICENSE\`。上游 commit 與本地修改記在 [\`vendor/README.md\`](vendor/README.md)。

| 套件 | 上游套件名 | 來源 | 授權 |
| --- | --- | --- | --- |
${vendored.map((row) => `| \`${row.npmName}\` | \`${row.upstreamName}\` | [${row.sourceDirectory}](${row.sourceDirectory}/) | MIT |`).join('\n')}

### 網頁的 solid-glass

網頁的外觀與元件原樣複製自下列上游，打包進網頁的 \`dist\`。版本與本地修改記在 [\`${SOLID_GLASS_DIR}/README.md\`](${SOLID_GLASS_DIR}/README.md)。

| 上游 | 固定在 | 授權 |
| --- | --- | --- |
${webVendored.map((row) => `| [${row.name}](${row.upstream}) | ${row.pin} | ${row.license} |`).join('\n')}

## 執行期的 npm 相依

安裝來在執行期使用，或打包進網頁 \`dist\` 的外部套件。網頁打包了哪些，是用 \`apps/web\` 自己的 vite 設定真的 build 一次收集的，不看它宣告在哪一段。這一層涵蓋每一顆可以從 \`cordis.yml\` 掛上的插件，不只預設載入的那些。

${renderNpmTable(runtimeDeps)}
${renderOflFonts(runtimeDeps)}
## 只在開發時用的 npm 相依

只為開發、測試、型別或工具**直接**宣告的外部套件，不在執行期安裝，也沒有打包進網頁。這裡的套件仍可能被某個執行期相依遞移帶進來，那以 \`pnpm-lock.yaml\` 為準。

${renderNpmTable(devDeps)}
${renderNonPermissiveNote(devDeps.filter((dep) => !isPermissive(dep.license)))}`;
}

/** CLI：預設寫檔，`--check` 比對進版控的那份。import 這個模組做測試時不會寫檔、也不會 `process.exit`。 */
async function main(): Promise<void> {
  const content = await render();
  if (process.argv.includes('--check')) {
    const committed = existsSync(resolve(ROOT, OUT))
      ? readFileSync(resolve(ROOT, OUT), 'utf8')
      : null;
    if (committed === content) {
      console.log(`gen-third-party-notices：${OUT} 是最新的。`);
      process.exit(0);
    }
    console.error(
      `gen-third-party-notices：${OUT} 過期了。跑 \`pnpm run gen-third-party-notices\` 並把 ${OUT} 一起 commit。`,
    );
    process.exit(1);
  }
  writeFileSync(resolve(ROOT, OUT), content);
  console.log(`gen-third-party-notices：寫好 ${OUT}。`);
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  await main();
}

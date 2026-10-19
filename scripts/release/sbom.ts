/**
 * 發版產物的 SBOM：CycloneDX JSON（[#1545](https://github.com/DemianLi/nexus-agent/issues/1545) 步驟 4，Q2 (a)）。
 *
 * 從 `pnpm deploy --prod` 的閉包產生：每一顆的 name、version、license、lockfile integrity。資料只取自閉包裡已安裝的 manifest
 * 與閉包自己的 lockfile（`node_modules/.pnpm/lock.yaml`，`pnpm deploy` 寫的，跟著 tarball 出貨），產生時不連網。
 *
 * **偏離 dsh，理由 2（產品需求超出 dsh 的射程）。** dsh 沒有 SBOM（`687f282e` 的整棵樹 `grep -rliE 'sbom|cyclonedx'`，排除 `node_modules`，0 個檔），它的
 * `THIRD_PARTY_NOTICES.md` 刻意只列直接相依。nexus 的交付物是完整閉包，部署在完全內網、多人共用的主機上，客戶的資安稽核要的是
 * 閉包裡每一顆的清冊，管理者拿去對機關的弱點資料庫（卡上的失敗情境）。補的是這一份清冊，格式照 CycloneDX 1.6。
 *
 * 兩種列閉包的方法刻意分開（#1545 驗收 6）：
 * - 產生用 {@link walkClosure}：從產物根沿 `dependencies`／`optionalDependencies`／`peerDependencies` 走相依圖。
 * - 核對用 {@link listInstalledPackages}：直接列 `node_modules/.pnpm` 底下實際裝了的套件目錄。
 *
 * 產生那一支漏了哪一段（例如拿掉 `optionalDependencies`，平台二進位套件就會漏），核對那一支照樣列得到，`sbomProblems` 就會紅。
 *
 * **我們自己的套件**（`@nexus/*`，含 `vendor/*`）：lockfile 不記 workspace 套件的 integrity，所以不帶 `hashes`。版本與 tarball
 * 一起由 `.sha256` 釘住。`apps/*`、`packages/*` 的 manifest 沒有 `license` 欄位，授權取 repo 根 `LICENSE`（MIT，見
 * {@link repoLicense}）。`vendor/*` 自己宣告 MIT，照它的 manifest。
 *
 * @module
 */

import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import parseSpdx from 'spdx-expression-parse';

import { ROOT } from '../workspace-packages.js';
import { SBOM_FILE, installedPackage } from './payload.js';

/** `yaml` 是 apps/harness 的相依，不在根 `node_modules`：從 harness 的位置解（同 `payload.ts`）。 */
const parseYaml = (
  createRequire(join(ROOT, 'apps/harness/package.json'))('yaml') as {
    parse: (text: string) => unknown;
  }
).parse;

/** 閉包自己的 lockfile：`pnpm deploy` 寫在虛擬庫裡，跟著產物出貨。 */
export const CLOSURE_LOCKFILE = 'node_modules/.pnpm/lock.yaml';

/** 我們自己的套件：名字在這個 scope 底下。 */
const FIRST_PARTY_SCOPE = '@nexus/';

/** 產生 SBOM 時沿這幾段走相依圖。平台二進位套件只掛在 `optionalDependencies`。 */
const GRAPH_SECTIONS = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const;

interface Manifest {
  readonly name: string;
  readonly version: string;
  readonly license?: unknown;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
}

/** 閉包裡的一顆套件。 */
export interface ClosurePackage {
  readonly name: string;
  readonly version: string;
  readonly license?: unknown;
}

function readManifest(directory: string): Manifest {
  return JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as Manifest;
}

/**
 * 產生用：從產物根沿相依圖走，回閉包裡每一顆（含根）。缺席的相依略過；缺不缺由 `walkInstalledGraph` 管。
 *
 * @param root - 產物根。
 * @returns 依走到的順序，同一個目錄只回一次。
 */
export function walkClosure(root: string): ClosurePackage[] {
  const seen = new Set<string>();
  const packages: ClosurePackage[] = [];
  const queue = [root];
  for (const directory of queue) {
    const canonical = realpathSync(directory);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    const manifest = readManifest(canonical);
    packages.push({ name: manifest.name, version: manifest.version, license: manifest.license });
    for (const section of GRAPH_SECTIONS) {
      for (const name of Object.keys(manifest[section] ?? {})) {
        const dependency = installedPackage(canonical, name);
        if (dependency !== undefined) queue.push(dependency);
      }
    }
  }
  return packages;
}

/**
 * 核對用：列 `node_modules/.pnpm/<項目>/node_modules` 底下**不是**符號連結的套件目錄（那就是這個項目自己裝的套件；其餘是指向
 * 相依的連結），再加上產物根。不走相依圖，所以跟 {@link walkClosure} 是兩種獨立的列法。
 *
 * @param root - 產物根。
 * @returns `name@version` 的集合。
 */
export function listInstalledPackages(root: string): Set<string> {
  const rootManifest = readManifest(root);
  const ids = new Set([`${rootManifest.name}@${rootManifest.version}`]);
  const store = join(root, 'node_modules/.pnpm');
  if (!existsSync(store)) return ids;
  for (const entry of readdirSync(store, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue;
    const modules = join(store, entry.name, 'node_modules');
    if (!existsSync(modules)) continue;
    for (const first of readdirSync(modules)) {
      if (first.startsWith('.')) continue;
      const names = first.startsWith('@')
        ? readdirSync(join(modules, first)).map((second) => `${first}/${second}`)
        : [first];
      for (const name of names) {
        const directory = join(modules, name);
        if (lstatSync(directory).isSymbolicLink()) continue;
        const manifest = readManifest(directory);
        ids.add(`${manifest.name}@${manifest.version}`);
      }
    }
  }
  return ids;
}

/**
 * lockfile `packages:` 區段裡每一顆的 integrity，鍵是 `name@version`。
 *
 * @param text - `lock.yaml`（或 `pnpm-lock.yaml`）的原文。
 */
export function lockfileIntegrities(text: string): Map<string, string> {
  const document = parseYaml(text) as {
    packages?: Record<string, { resolution?: { integrity?: unknown } }>;
  } | null;
  const integrities = new Map<string, string>();
  for (const [key, value] of Object.entries(document?.packages ?? {})) {
    const integrity = value.resolution?.integrity;
    if (typeof integrity === 'string') integrities.set(key, integrity);
  }
  return integrities;
}

const HASH_ALGORITHMS: Readonly<Record<string, string>> = {
  sha1: 'SHA-1',
  sha256: 'SHA-256',
  sha384: 'SHA-384',
  sha512: 'SHA-512',
};

/** CycloneDX 的一筆雜湊。 */
export interface CycloneDxHash {
  readonly alg: string;
  readonly content: string;
}

/**
 * SRI 字串（`sha512-<base64>`，可能以空白分隔多筆）轉成 CycloneDX 的雜湊（十六進位）。
 *
 * @throws 認不得的演算法或格式。
 */
export function integrityToHashes(integrity: string): CycloneDxHash[] {
  return integrity
    .trim()
    .split(/\s+/u)
    .map((token) => {
      const match = /^([a-z0-9]+)-([A-Za-z0-9+/]+={0,2})$/u.exec(token);
      const alg = match === null ? undefined : HASH_ALGORITHMS[match[1] ?? ''];
      if (match === null || alg === undefined) {
        throw new Error(`認不得的 integrity：${token}`);
      }
      return { alg, content: Buffer.from(match[2] ?? '', 'base64').toString('hex') };
    });
}

/** CycloneDX 的授權欄位：單一 SPDX id 用 `license.id`，運算式用 `expression`。 */
export type CycloneDxLicense = { license: { id: string } } | { expression: string };

/**
 * manifest 的 `license` 轉成 CycloneDX 的授權。
 *
 * @throws 不是字串、或不是合法的 SPDX 運算式（不猜；要補就在這裡加一條並寫理由）。
 */
export function cycloneDxLicense(license: unknown, name: string): CycloneDxLicense {
  if (typeof license !== 'string' || license.trim() === '') {
    throw new Error(`SBOM：${name} 的 manifest 沒有字串 license`);
  }
  let parsed: ReturnType<typeof parseSpdx>;
  try {
    parsed = parseSpdx(license);
  } catch {
    throw new Error(`SBOM：${name} 的 license 不是合法的 SPDX 運算式：${JSON.stringify(license)}`);
  }
  if ('license' in parsed && parsed.exception === undefined && parsed.plus !== true) {
    return { license: { id: parsed.license } };
  }
  return { expression: license };
}

/**
 * repo 根 `LICENSE` 的 SPDX id：今天只認得 MIT 的標頭。換了授權要先在這裡加一條，不讓 SBOM 靜靜寫錯。
 *
 * @param text - `LICENSE` 原文。
 * @throws 認不得的標頭。
 */
export function repoLicense(text: string): string {
  if (text.split('\n', 1)[0]?.trim() === 'MIT License') return 'MIT';
  throw new Error('SBOM：認不得 repo 根 LICENSE 的授權（今天只認得 MIT License 標頭）');
}

/** `name@version` 的 npm purl（scope 的 `@` 編成 `%40`）。 */
export function npmPurl(name: string, version: string): string {
  return `pkg:npm/${name.replace(/^@/u, '%40')}@${version}`;
}

/** CycloneDX 的一個元件。 */
export interface CycloneDxComponent {
  readonly type: 'application' | 'library';
  readonly 'bom-ref': string;
  readonly group?: string;
  readonly name: string;
  readonly version: string;
  readonly purl: string;
  readonly licenses: readonly CycloneDxLicense[];
  readonly hashes?: readonly CycloneDxHash[];
}

/** 產生的 SBOM。 */
export interface CycloneDxBom {
  readonly bomFormat: 'CycloneDX';
  readonly specVersion: '1.6';
  readonly version: 1;
  readonly metadata: { readonly component: CycloneDxComponent };
  readonly components: readonly CycloneDxComponent[];
}

function component(
  type: CycloneDxComponent['type'],
  pkg: ClosurePackage,
  integrities: ReadonlyMap<string, string>,
  firstPartyLicense: string,
): CycloneDxComponent {
  const id = `${pkg.name}@${pkg.version}`;
  const slash = pkg.name.startsWith('@') ? pkg.name.indexOf('/') : -1;
  const purl = npmPurl(pkg.name, pkg.version);
  const firstParty = pkg.name.startsWith(FIRST_PARTY_SCOPE);
  const base = {
    type,
    'bom-ref': purl,
    ...(slash > 0 ? { group: pkg.name.slice(0, slash) } : {}),
    name: slash > 0 ? pkg.name.slice(slash + 1) : pkg.name,
    version: pkg.version,
    purl,
    licenses: [
      cycloneDxLicense(
        firstParty && pkg.license === undefined ? firstPartyLicense : pkg.license,
        id,
      ),
    ],
  };
  if (firstParty) return base;
  const integrity = integrities.get(id);
  if (integrity === undefined) {
    throw new Error(`SBOM：${id} 在閉包的 lockfile 裡查不到 integrity`);
  }
  return { ...base, hashes: integrityToHashes(integrity) };
}

/**
 * 對產物根產生 SBOM。根套件放 `metadata.component`，其餘照 purl 排序放 `components`；不放 `serialNumber`、時間戳，同一個閉包
 * 產兩次位元組相同。
 *
 * @param root - 產物根（`pnpm deploy` 的暫存樹）。
 * @param options - `lockfile`：閉包 lockfile 的原文（省略即讀 {@link CLOSURE_LOCKFILE}）；`firstPartyLicense`：我們自己的
 *   套件沒宣告 license 時用的 SPDX id（省略即讀 repo 根 `LICENSE`）。
 * @throws 第三方套件查不到 integrity、或沒有合法的 license。
 */
export function buildSbom(
  root: string,
  options: { lockfile?: string; firstPartyLicense?: string } = {},
): CycloneDxBom {
  const integrities = lockfileIntegrities(
    options.lockfile ?? readFileSync(join(root, CLOSURE_LOCKFILE), 'utf8'),
  );
  const firstPartyLicense =
    options.firstPartyLicense ?? repoLicense(readFileSync(join(ROOT, 'LICENSE'), 'utf8'));
  const [rootPackage, ...rest] = walkClosure(root);
  if (rootPackage === undefined) throw new Error('SBOM：產物根讀不到 package.json');
  const components = rest
    .map((pkg) => component('library', pkg, integrities, firstPartyLicense))
    .sort((a, b) => (a.purl < b.purl ? -1 : a.purl > b.purl ? 1 : 0));
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    metadata: {
      component: component('application', rootPackage, integrities, firstPartyLicense),
    },
    components,
  };
}

/** 寫檔的格式：兩格縮排、結尾換行。 */
export function renderSbom(bom: CycloneDxBom): string {
  return `${JSON.stringify(bom, null, 2)}\n`;
}

/** SBOM 元件的 `name@version`（`group` 接回名字前面）。 */
function componentId(entry: { group?: unknown; name?: unknown; version?: unknown }): string {
  const name =
    typeof entry.group === 'string' ? `${entry.group}/${String(entry.name)}` : String(entry.name);
  return `${name}@${String(entry.version)}`;
}

/**
 * 核對產物根的 SBOM 與實際裝了的閉包：每一顆都要在 SBOM 裡，SBOM 裡也不能有閉包外的（#1545 驗收 6）。
 *
 * @param root - 產物根（解開後的安裝樹）。
 * @returns 問題清單；空代表兩邊相同。
 */
export function sbomProblems(root: string): string[] {
  const path = join(root, SBOM_FILE);
  if (!existsSync(path)) return [`缺 ${SBOM_FILE}`];
  let bom: {
    metadata?: { component?: Record<string, unknown> };
    components?: Record<string, unknown>[];
  };
  try {
    bom = JSON.parse(readFileSync(path, 'utf8')) as typeof bom;
  } catch (error) {
    return [`${SBOM_FILE} 不是合法的 JSON：${(error as Error).message}`];
  }
  const listed = new Set(
    [bom.metadata?.component, ...(bom.components ?? [])]
      .filter((entry) => entry !== undefined)
      .map(componentId),
  );
  const installed = listInstalledPackages(root);
  const problems: string[] = [];
  for (const id of [...installed].sort()) {
    if (!listed.has(id)) problems.push(`SBOM 漏了閉包裡的 ${id}`);
  }
  for (const id of [...listed].sort()) {
    if (!installed.has(id)) problems.push(`SBOM 列了閉包裡沒有的 ${id}`);
  }
  return problems;
}

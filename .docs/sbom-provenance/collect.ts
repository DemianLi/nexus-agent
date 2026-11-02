/**
 * 重產 `../sbom-provenance.md` 的表（#2254）。查 npm、crates.io、GitHub 的公開中繼資料，不下載套件本體。
 *
 * 用法見 `../sbom-provenance.md`〈重跑〉。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import {
  SPAWNER_CRATES,
  SPAWNER_NATIVE_LIBS,
  lockedCrates,
  rustChannel,
} from '../../scripts/release/spawner.js';

const ROOT = resolve(import.meta.dirname, '../..');
const parseYaml = (
  createRequire(join(ROOT, 'apps/harness/package.json'))('yaml') as {
    parse: (text: string) => unknown;
  }
).parse;

interface Platform {
  readonly os: string;
  readonly cpu: string;
  readonly libc?: string;
}
const PLATFORMS: Readonly<Record<string, Platform>> = {
  'linux-x64': { os: 'linux', cpu: 'x64', libc: 'glibc' },
  'darwin-arm64': { os: 'darwin', cpu: 'arm64' },
};

interface LockDeps {
  readonly dependencies?: Readonly<Record<string, string | { version: string }>>;
  readonly optionalDependencies?: Readonly<Record<string, string | { version: string }>>;
}
interface PackageEntry {
  readonly os?: readonly string[];
  readonly cpu?: readonly string[];
  readonly libc?: readonly string[];
}
interface Lockfile {
  readonly importers: Readonly<Record<string, LockDeps>>;
  readonly packages: Readonly<Record<string, PackageEntry>>;
  readonly snapshots: Readonly<Record<string, LockDeps>>;
}

function allows(wanted: string | undefined, listed: readonly string[] | undefined): boolean {
  if (listed === undefined || wanted === undefined) return true;
  if (listed.includes(`!${wanted}`)) return false;
  return listed.some((item) => !item.startsWith('!')) ? listed.includes(wanted) : true;
}

function matchesPlatform(entry: PackageEntry | undefined, platform: Platform): boolean {
  return (
    allows(platform.os, entry?.os) &&
    allows(platform.cpu, entry?.cpu) &&
    allows(platform.libc, entry?.libc)
  );
}

const stripPeers = (key: string): string => key.replace(/\(.*$/u, '');
const versionOf = (value: string | { version: string }): string =>
  typeof value === 'string' ? value : value.version;

/** 從 `apps/harness` 走正式相依：回第三方的 `name@version` 與第一方的 `name@version`。 */
function closure(lock: Lockfile, platform: Platform): { third: Set<string>; first: Set<string> } {
  const third = new Set<string>();
  const first = new Set<string>();
  const seenImporters = new Set<string>();
  const seenSnapshots = new Set<string>();
  const visit = (name: string, value: string, importer: string | undefined): void => {
    if (value.startsWith('link:')) {
      if (importer === undefined) throw new Error(`快照裡的 link：${name} ${value}`);
      visitImporter(relative(ROOT, resolve(ROOT, importer, value.slice('link:'.length))));
      return;
    }
    const key = /^@?[a-zA-Z][^@(]*@\d/u.test(value) ? value : `${name}@${value}`;
    if (!matchesPlatform(lock.packages[stripPeers(key)], platform)) return;
    if (seenSnapshots.has(key)) return;
    seenSnapshots.add(key);
    third.add(stripPeers(key));
    walk(lock.snapshots[key] ?? {}, undefined);
  };
  const walk = (deps: LockDeps, importer: string | undefined): void => {
    for (const section of [deps.dependencies, deps.optionalDependencies]) {
      for (const [name, value] of Object.entries(section ?? {})) {
        visit(name, versionOf(value), importer);
      }
    }
  };
  const visitImporter = (path: string): void => {
    if (seenImporters.has(path)) return;
    seenImporters.add(path);
    const manifest = JSON.parse(readFileSync(join(ROOT, path, 'package.json'), 'utf8')) as {
      name: string;
      version: string;
    };
    first.add(`${manifest.name}@${manifest.version}`);
    walk(lock.importers[path] ?? {}, path);
  };
  visitImporter('apps/harness');
  return { third, first };
}

/** `vite build --sourcemap` 產物裡每一顆 `node_modules` 套件的 `name@version`。 */
function bundledByWeb(distDir: string): Set<string> {
  const found = new Set<string>();
  const scan = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) scan(path);
      else if (entry.endsWith('.map')) {
        const map = JSON.parse(readFileSync(path, 'utf8')) as { sources: readonly string[] };
        for (const source of map.sources) {
          const match = /\.pnpm\/((?:@[^/+]+\+)?[^/@]+)@([^/_(]+)[^/]*\/node_modules\//u.exec(
            source,
          );
          if (match !== null) {
            found.add(`${(match[1] ?? '').replace('+', '/')}@${match[2] ?? ''}`);
          }
        }
      }
    }
  };
  scan(distDir);
  return found;
}

/** web 的 CSS 用 `@import`／`@plugin` 帶進來的套件：不經 JS，sourcemap 看不到。 */
function importedByWebCss(lock: Lockfile): Set<string> {
  const direct = lock.importers['apps/web'];
  const found = new Set<string>();
  const scan = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) scan(path);
      else if (entry.endsWith('.css')) {
        const text = readFileSync(path, 'utf8');
        for (const match of text.matchAll(/@(?:import|plugin)\s+['"]([^.'"][^'"]*)['"]/gu)) {
          const parts = (match[1] ?? '').split('/');
          const name = parts[0]?.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? '');
          const value =
            direct?.dependencies?.[name] ??
            (
              direct as
                { devDependencies?: Record<string, string | { version: string }> } | undefined
            )?.devDependencies?.[name];
          if (value !== undefined) found.add(`${name}@${stripPeers(versionOf(value))}`);
        }
      }
    }
  };
  scan(join(ROOT, 'apps/web/src'));
  return found;
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

async function getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, { headers });
    if (response.ok) return response.json();
    if (response.status === 404) return undefined;
    if (attempt === 3) throw new Error(`${url}：HTTP ${String(response.status)}`);
    await sleep(2000 * (attempt + 1));
  }
}

function normalizeRepo(raw: unknown): string | undefined {
  const url = typeof raw === 'string' ? raw : (raw as { url?: unknown } | undefined)?.url;
  if (typeof url !== 'string' || url === '') return undefined;
  const short = /^(?:github:)?([\w.-]+\/[\w.-]+)$/u.exec(url);
  if (short !== null) return `https://github.com/${short[1] ?? ''}`;
  return url
    .replace(/^git\+/u, '')
    .replace(/^git:\/\//u, 'https://')
    .replace(/^ssh:\/\/git@/u, 'https://')
    .replace(/^git@github\.com:/u, 'https://github.com/')
    .replace(/^https:\/\/git@/u, 'https://')
    .replace(/#.*$/u, '')
    .replace(/\.git$/u, '');
}

export interface Row {
  readonly name: string;
  readonly version: string;
  readonly origin: string;
  readonly repo: string | undefined;
  readonly maintainers: readonly string[];
  readonly publisher: string | undefined;
  readonly license: string | undefined;
  readonly note?: string;
}

async function npmRow(id: string, origin: string, note?: string): Promise<Row> {
  const at = id.lastIndexOf('@');
  const name = id.slice(0, at);
  const version = id.slice(at + 1);
  const doc = (await getJson(
    `https://registry.npmjs.org/${name.replace('/', '%2F')}/${version}`,
  )) as
    | {
        repository?: unknown;
        license?: unknown;
        maintainers?: readonly { name?: string }[];
        _npmUser?: { name?: string };
      }
    | undefined;
  return {
    name,
    version,
    origin,
    repo: normalizeRepo(doc?.repository),
    maintainers: (doc?.maintainers ?? []).flatMap((item) => (item.name ? [item.name] : [])),
    publisher: doc?._npmUser?.name,
    license: typeof doc?.license === 'string' ? doc.license : undefined,
    ...(note === undefined ? {} : { note }),
  };
}

async function crateRow(name: string, version: string, origin: string, note: string): Promise<Row> {
  const headers = { 'User-Agent': 'nexus-agent-sbom-provenance (issue 2254)' };
  await sleep(1100);
  const meta = (await getJson(`https://crates.io/api/v1/crates/${name}/${version}`, headers)) as
    { version?: { license?: string; published_by?: { login?: string } } } | undefined;
  await sleep(1100);
  const crate = (await getJson(`https://crates.io/api/v1/crates/${name}`, headers)) as
    { crate?: { repository?: string } } | undefined;
  await sleep(1100);
  const owners = (await getJson(`https://crates.io/api/v1/crates/${name}/owners`, headers)) as
    { users?: readonly { login?: string }[] } | undefined;
  return {
    name,
    version,
    origin,
    repo: normalizeRepo(crate?.crate?.repository),
    maintainers: (owners?.users ?? []).flatMap((item) => (item.login ? [item.login] : [])),
    publisher: meta?.version?.published_by?.login,
    license: meta?.version?.license,
    note,
  };
}

async function inBatches<T, R>(
  items: readonly T[],
  size: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += size) {
    results.push(...(await Promise.all(items.slice(start, start + size).map(run))));
  }
  return results;
}

function githubOwner(repo: string | undefined): string {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)/u.exec(repo ?? '');
  if (match === null) return '';
  try {
    return execFileSync(
      'gh',
      [
        'api',
        `repos/${match[1] ?? ''}/${match[2] ?? ''}`,
        '--jq',
        '"\\(.owner.login)（\\(.owner.type)）"',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
  } catch {
    return '查不到';
  }
}

const cell = (value: string | undefined): string =>
  value === undefined || value === '' ? '查不到' : value.replaceAll('|', '\\|');

function render(rows: readonly Row[], owners: ReadonlyMap<string, string>): string {
  const lines = [
    '| 套件 | 版本 | 來源 | repo | repo 擁有者 | 維護者 | 最後發布者 | 授權 | 備註 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const row of rows) {
    lines.push(
      `| ${[
        row.name,
        row.version,
        row.origin,
        cell(row.repo),
        cell(owners.get(row.repo ?? '')),
        cell(row.maintainers.join('、')),
        cell(row.publisher),
        cell(row.license),
        row.note ?? '',
      ].join(' | ')} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      platform: { type: 'string', default: 'linux-x64' },
      'web-dist': { type: 'string' },
      'check-sbom': { type: 'string' },
      out: { type: 'string' },
    },
  });
  const platform = PLATFORMS[values.platform];
  if (platform === undefined) throw new Error(`不認得的平台：${values.platform}`);
  const lock = parseYaml(readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8')) as Lockfile;
  const { third, first } = closure(lock, platform);

  if (values['check-sbom'] !== undefined) {
    const bom = JSON.parse(readFileSync(values['check-sbom'], 'utf8')) as {
      components: readonly { group?: string; name: string; version: string; purl: string }[];
    };
    const listed = new Set(
      bom.components
        .filter((item) => item.purl.startsWith('pkg:npm/'))
        .map((item) => `${item.group ? `${item.group}/` : ''}${item.name}@${item.version}`),
    );
    const walked = new Set([...third, ...first]);
    console.log(`算出 ${String(walked.size)}，SBOM ${String(listed.size)}（SBOM 不含根）`);
    console.log(
      'SBOM 有、算的沒有：',
      [...listed].filter((id) => !walked.has(id)),
    );
    console.log(
      '算的有、SBOM 沒有：',
      [...walked].filter((id) => !listed.has(id)),
    );
    return;
  }
  if (values['web-dist'] === undefined || values.out === undefined) {
    throw new Error('要帶 --web-dist 與 --out');
  }

  const web = new Set([...bundledByWeb(values['web-dist']), ...importedByWebCss(lock)]);
  const npmIds = [...new Set([...third, ...web])].sort();
  const npmRows = await inBatches(npmIds, 8, (id) =>
    npmRow(id, third.has(id) ? (web.has(id) ? 'npm 閉包＋web' : 'npm 閉包') : 'web 打包'),
  );

  const vendorRows: Row[] = [];
  const vendorTable = readFileSync(join(ROOT, 'vendor/README.md'), 'utf8');
  for (const match of vendorTable.matchAll(
    /^\| `[^`]+\/` \| `(@nexus\/[^`]+)` \| `([^`]+)` \| (\S+) \| (https:\/\/\S+)（[^）]*） \| `([0-9a-f]{40})` \|$/gmu,
  )) {
    const upstream = await npmRow(`${match[2] ?? ''}@latest`, 'vendor');
    vendorRows.push({
      ...upstream,
      name: match[1] ?? '',
      version: match[3] ?? '',
      repo: match[4],
      note: `上游 ${match[2] ?? ''}，commit ${(match[5] ?? '').slice(0, 12)}；維護者取上游 npm 最新版`,
    });
  }

  const webVendor = JSON.parse(
    readFileSync(join(ROOT, 'apps/web/src/vendor/solid-glass/manifest.json'), 'utf8'),
  ) as {
    sources: { 'solid-glass': { upstream: string; commit: string }; shadcn: { version: string } };
  };
  const shadcn = await npmRow(
    `shadcn@${webVendor.sources.shadcn.version}`,
    'web vendor',
    '只取 tailwind.css',
  );

  const lockText = readFileSync(join(ROOT, 'native/sandbox-spawner/Cargo.lock'), 'utf8');
  const runtime = new Map(SPAWNER_CRATES.map((item) => [item.name, item.runtime]));
  const crateRows: Row[] = [];
  for (const item of lockedCrates(lockText)) {
    if (item.checksum === undefined) continue;
    crateRows.push(
      await crateRow(
        item.name,
        item.version,
        'crate',
        runtime.get(item.name) ? '連進執行檔' : '只在建置時',
      ),
    );
  }

  const nativeRows: Row[] = SPAWNER_NATIVE_LIBS.map((item) => ({
    name: item.name,
    version: item.version,
    origin: '工具鏈',
    repo: item.repo,
    maintainers: [],
    publisher: undefined,
    license: item.license,
  }));

  nativeRows.push({
    name: 'rust-std',
    version: rustChannel(),
    origin: '工具鏈',
    repo: 'https://github.com/rust-lang/rust',
    maintainers: [],
    publisher: undefined,
    license: 'MIT OR Apache-2.0',
  });

  const solid = webVendor.sources['solid-glass'];
  const contributors = execFileSync(
    'gh',
    ['api', 'repos/deeplethe/solid-glass/contributors?per_page=5', '--jq', '.[].login'],
    { encoding: 'utf8' },
  )
    .trim()
    .split('\n');
  const solidRow: Row = {
    name: 'solid-glass',
    version: solid.commit.slice(0, 12),
    origin: 'web vendor',
    repo: solid.upstream,
    maintainers: contributors,
    publisher: undefined,
    license: 'MIT',
    note: '維護者欄是 commit 作者；組織成員不公開',
  };

  const rows = [...npmRows, shadcn, solidRow, ...vendorRows, ...crateRows, ...nativeRows];
  const owners = new Map(
    [...new Set(rows.flatMap((row) => (row.repo ? [row.repo] : [])))].map((repo) => [
      repo,
      githubOwner(repo),
    ]),
  );
  const firstParty = [...first].filter(
    (id) => !vendorRows.some((row) => id.startsWith(`${row.name}@`)),
  );
  writeFileSync(
    values.out,
    JSON.stringify({ rows, firstParty, ownerOf: Object.fromEntries(owners) }, null, 2),
  );
  writeFileSync(`${values.out}.table.md`, render(rows, owners));
  console.log(`共 ${String(rows.length)} 列，第一方 ${String(firstParty.length)} 顆`);
}

await main();

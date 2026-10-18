/**
 * 盤點「要編成 `lib/` 的 workspace 套件」，給 tsdown 設定、tsconfig 路徑產生器與 manifest 驗證共用
 * （[#1502](https://github.com/DemianLi/nexus-agent/issues/1502)，照 dsh `tsdown.config.ts` 的 `workspacePackageGlobs`）。
 *
 * **manifest 是唯一的來源。** 每個套件的 `main`、`exports`、`bin`、`imports` 都直接指 `lib/`，開發時由 `tsconfig.base.json`
 * 的 `paths` 對回 `src/`。這個檔從 manifest 推兩件事：
 *
 * - **要編哪些入口**：`./lib/<路徑>.js` 對應 `./src/<路徑>.ts`，路徑原樣保留（`lib/settings/live-model.js` 來自
 *   `src/settings/live-model.ts`），所以 `import.meta.url` 相對來源位置算的路徑（`../cordis.yml`）在 `src/` 與 `lib/` 同一深度時兩邊都對。
 * - **開發時每個說法對到哪個來源檔**：一個套件名與它的每個 subpath。`<套件>/src/*` 這種深路徑由 manifest 的 `./src/*` export 直接指到 `src/`（仍在原本的 manifest 裡），不產生別名。
 *
 * `apps/web` 不在這裡：它由 vite 建成 `dist`，不是 Node 載入的套件。
 */

import { existsSync, globSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** manifest 裡 `exports` 的一個值：字串，或條件物件（取 `default`）。 */
type ExportValue = string | { readonly default?: string; readonly [condition: string]: unknown };

export interface Manifest {
  readonly name: string;
  readonly main?: string;
  readonly bin?: string | Readonly<Record<string, string>>;
  readonly exports?: Readonly<Record<string, ExportValue>>;
  readonly imports?: Readonly<Record<string, string>>;
  readonly files?: readonly string[];
  readonly [key: string]: unknown;
}

/** 開發時一個說法（套件名、subpath、`#` 開頭的 imports）對到哪個來源檔。 */
export interface Alias {
  /** 例：`@nexus/core`、`@nexus/core/invariant`、`#settings/*`。 */
  readonly specifier: string;
  /** 相對 repo 根的來源檔，可含一個 `*`。例：`./packages/nexus-core/src/index.ts`。 */
  readonly source: string;
}

export interface WorkspacePackage {
  readonly name: string;
  /** 相對 repo 根的目錄，例：`packages/nexus-core`。 */
  readonly dir: string;
  /**
   * 是不是 `vendor/*`（上游原始碼）。vendor 的原始碼用自己較寬鬆的 tsconfig 檢查（NodeNext、`noImplicitAny: false`），
   * 放進 repo 的嚴格設定會噴出一整批與本專案無關的錯，所以型別檢查那份 `paths` 不含它（型別來自各自 `prepare` 產的
   * `lib/types/*.d.ts`，維持今天的做法）；執行期（tsx、vitest）那份才含，載進來的是 `src/`。
   */
  readonly vendor: boolean;
  readonly manifest: Manifest;
  /** tsdown 的入口：輸出名（不含 `.js`，可含目錄）→ 相對套件目錄的來源檔。 */
  readonly entries: Readonly<Record<string, string>>;
  readonly aliases: readonly Alias[];
}

/** 掃描的位置。順序決定輸出順序。 */
const GROUPS = ['apps/harness', 'packages/*', 'vendor/*'] as const;

function readManifest(dir: string): Manifest | undefined {
  const file = join(ROOT, dir, 'package.json');
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, 'utf8')) as Manifest;
}

function groupDirs(): string[] {
  const dirs: string[] = [];
  for (const group of GROUPS) {
    if (!group.endsWith('/*')) {
      dirs.push(group);
      continue;
    }
    const parent = group.slice(0, -2);
    for (const name of readdirSync(join(ROOT, parent)).sort()) {
      if (statSync(join(ROOT, parent, name)).isDirectory()) dirs.push(`${parent}/${name}`);
    }
  }
  return dirs;
}

/** `./lib/a/b.js` → `a/b`；不是 `./lib/*.js` 的回 `undefined`。 */
export function libToName(target: string): string | undefined {
  const match = /^\.\/lib\/(.+)\.js$/.exec(target);
  return match?.[1];
}

function exportTarget(value: ExportValue | undefined): string | undefined {
  if (typeof value === 'string') return value;
  return typeof value?.default === 'string' ? value.default : undefined;
}

/** `lib/x.js`（`main`、`bin` 的寫法，沒有 `./`）也認。 */
function normalize(target: string): string {
  return target.startsWith('./') ? target : `./${target}`;
}

function describePackage(dir: string, manifest: Manifest): WorkspacePackage {
  const entries: Record<string, string> = {};
  const aliases: Alias[] = [];
  const addEntry = (name: string): void => {
    entries[name] = `src/${name}.ts`;
  };

  if (manifest.main !== undefined) {
    const name = libToName(normalize(manifest.main));
    if (name !== undefined) addEntry(name);
  }
  for (const [subpath, value] of Object.entries(manifest.exports ?? {})) {
    const target = exportTarget(value);
    if (target === undefined) continue;
    const name = libToName(target);
    if (name === undefined) continue;
    addEntry(name);
    const specifier = subpath === '.' ? manifest.name : `${manifest.name}/${subpath.slice(2)}`;
    aliases.push({ specifier, source: `./${dir}/src/${name}.ts` });
  }
  const bins =
    typeof manifest.bin === 'string' ? [manifest.bin] : Object.values(manifest.bin ?? {});
  for (const bin of bins) {
    const name = libToName(normalize(bin));
    if (name !== undefined) addEntry(name);
  }
  for (const [pattern, target] of Object.entries(manifest.imports ?? {})) {
    const match = /^\.\/lib\/(.+)\*\.js$/.exec(target);
    if (match?.[1] === undefined) continue;
    const prefix = match[1];
    aliases.push({ specifier: pattern, source: `./${dir}/src/${prefix}*.ts` });
    const found = globSync(`src/${prefix}*.ts`, { cwd: join(ROOT, dir) })
      .filter((file) => !/\.(test|fixture)\.ts$/.test(file))
      .sort();
    for (const file of found) addEntry(file.slice('src/'.length, -'.ts'.length));
  }
  return {
    name: manifest.name,
    dir,
    vendor: dir.startsWith('vendor/'),
    manifest,
    entries,
    aliases,
  };
}

/**
 * 每個要編成 `lib/` 的 workspace 套件。有 `src/` 與 `name` 才算。
 *
 * @returns 依 {@link GROUPS} 與目錄名排序。
 */
export function workspacePackages(): WorkspacePackage[] {
  const found: WorkspacePackage[] = [];
  for (const dir of groupDirs()) {
    const manifest = readManifest(dir);
    if (manifest === undefined || !existsSync(join(ROOT, dir, 'src'))) continue;
    found.push(describePackage(dir, manifest));
  }
  return found;
}

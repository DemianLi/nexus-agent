/**
 * 替型別檢查產生 project references（[#2096](https://github.com/DemianLi/nexus-agent/issues/2096)），給 `.github/scripts/typecheck.sh`
 * 交給一次 `tsc -b`。
 *
 * 每個套件經 `tsconfig.base.json` 的 `paths` 讀別的套件的 `src/`，各自 `tsc --noEmit` 的話，core 的原始碼要在每個下游重查一遍。
 * 這裡替每個非 vendor 的 workspace 套件在自己的 `node_modules/.cache/nexus-typecheck/` 產生一份 tsconfig：
 *
 * - `extends` 套件自己的 `tsconfig.json`，沿用它的 `include` 與選項；
 * - `references` 指它在 `package.json` 宣告的非 vendor workspace 相依（四種 dependencies 都算）；vendor 的型別來自各自
 *   `prepare` 產的宣告檔，不進 references；
 * - 被別人引用的開 `composite`，只輸出宣告檔到 `out/`，下游讀那份宣告檔；沒人引用的只開 `incremental`。
 *
 * 被引用的套件要輸出宣告檔，所以會擋只有輸出宣告檔才有的錯：推斷的型別無法命名（TS2742、TS4058 這類）、匯出匿名 class 的
 * private／protected 成員（TS4094）、程式拉進 `include` 以外的檔（TS6307，例如 import 了沒宣告的 workspace 套件）、
 * references 繞成圈（TS6202）。沒人引用的套件只開 incremental，不擋這幾類。
 *
 * `apps/web` 不在這裡，`typecheck.sh` 對它單獨 `tsc --noEmit`。`packages/*`、`apps/*` 底下其餘有 `package.json` 的目錄
 * 都要有一份，漏了就丟錯：少查一個套件，CI 不會紅。
 *
 * 內容沒變不重寫：設定檔比 buildinfo 新，`tsc -b` 會判成過期。
 *
 * @module
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { ROOT, workspacePackages } from './workspace-packages.js';

/** 每個套件放產生物的位置，相對套件目錄。 */
export const CACHE_DIR = 'node_modules/.cache/nexus-typecheck';

/**
 * 單獨檢查、不進 project references 的套件。沒有套件引用 web，放進 references 也省不到重查；單獨跑能跟單執行緒的
 * `tsc -b` 同時用到另一顆核心。`typecheck.sh` 寫死同一份清單，harness 的測試核對兩邊一致。
 */
export const STANDALONE = ['apps/web'] as const;

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

export interface TypecheckProject {
  /** 相對 repo 根，例：`packages/nexus-core`。 */
  readonly dir: string;
  /** 被別的套件引用，要輸出宣告檔。 */
  readonly composite: boolean;
  /** 引用的套件目錄，排序過。 */
  readonly references: readonly string[];
}

/** 每個非 vendor 的 workspace 套件與它引用的套件。 */
export function typecheckProjects(): TypecheckProject[] {
  const packages = workspacePackages().filter((pkg) => !pkg.vendor);
  const dirOf = new Map(packages.map((pkg) => [pkg.name, pkg.dir]));
  const referencesOf = new Map(
    packages.map((pkg) => {
      const names = DEPENDENCY_FIELDS.flatMap((field) => {
        const deps = pkg.manifest[field];
        return typeof deps === 'object' && deps !== null ? Object.keys(deps) : [];
      });
      const dirs = names.flatMap((name) => {
        const dir = name === pkg.name ? undefined : dirOf.get(name);
        return dir === undefined ? [] : [dir];
      });
      return [pkg.dir, [...new Set(dirs)].sort()];
    }),
  );
  const referenced = new Set([...referencesOf.values()].flat());
  return packages.map((pkg) => ({
    dir: pkg.dir,
    composite: referenced.has(pkg.dir),
    references: referencesOf.get(pkg.dir) ?? [],
  }));
}

/** `packages/*`、`apps/*` 底下有 `package.json`、卻沒有產生設定也不是 {@link STANDALONE} 的目錄。 */
export function uncoveredDirs(projects: readonly TypecheckProject[]): string[] {
  const covered = new Set<string>([...projects.map((project) => project.dir), ...STANDALONE]);
  return ['packages', 'apps']
    .flatMap((parent) => readdirSync(join(ROOT, parent)).map((name) => `${parent}/${name}`))
    .filter((dir) => existsSync(join(ROOT, dir, 'package.json')) && !covered.has(dir))
    .sort();
}

/** 一個套件產生的 tsconfig 內容。 */
export function renderProject(project: TypecheckProject): string {
  const from = join(ROOT, project.dir, CACHE_DIR);
  const rel = (path: string): string => relative(from, path).split('\\').join('/');
  const compilerOptions = project.composite
    ? {
        composite: true,
        noEmit: false,
        emitDeclarationOnly: true,
        // composite 的 rootDir 預設是設定檔所在的快取目錄，套件的 src 不在裡面，所以要設。取 repo 根：import 了沒宣告的
        // 套件時，那些檔的宣告檔也落在 out/ 底下；rootDir 以外的檔，宣告檔會寫到原始檔旁邊。
        rootDir: rel(ROOT),
        outDir: 'out',
        // 跟宣告檔放同一個目錄，一起在、一起不在：只剩 buildinfo 時，tsc -b 判上游不必重出，下游讀不到宣告檔就紅。
        tsBuildInfoFile: 'out/tsconfig.tsbuildinfo',
      }
    : { incremental: true, tsBuildInfoFile: 'tsconfig.tsbuildinfo' };
  const config = {
    extends: rel(join(ROOT, project.dir, 'tsconfig.json')),
    compilerOptions,
    references: project.references.map((dir) => ({
      path: rel(join(ROOT, dir, CACHE_DIR, 'tsconfig.json')),
    })),
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

/**
 * 寫出每個套件的 tsconfig。
 *
 * @returns 寫了幾份（內容沒變的不算）。
 * @throws 有套件沒被涵蓋（見 {@link uncoveredDirs}）。
 */
export function writeTypecheckProjects(): number {
  const projects = typecheckProjects();
  const missing = uncoveredDirs(projects);
  if (missing.length > 0) {
    throw new Error(`這些目錄沒有型別檢查設定：${missing.join('、')}`);
  }
  let written = 0;
  for (const project of projects) {
    const dir = join(ROOT, project.dir, CACHE_DIR);
    const file = join(dir, 'tsconfig.json');
    const content = renderProject(project);
    if (existsSync(file) && readFileSync(file, 'utf8') === content) continue;
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, content);
    written += 1;
  }
  return written;
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  writeTypecheckProjects();
}

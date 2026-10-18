/**
 * 每個 workspace 套件的 manifest 是不是「出貨的是 `lib/`」的形狀（[#1502](https://github.com/DemianLi/nexus-agent/issues/1502)，
 * 照 dsh `tool-fs-search/package.json:14-29` 與 `publication-payload.ts` 拒收 `src/`）：
 *
 * - `main`、`bin`、`imports` 與 `exports` 的每個入口都指 `./lib/…js`；唯二的例外是 `./package.json` 與 `./src/*`
 *   （後者只給 workspace 內的深路徑與型別用，裝出去的樹因為 `files` 沒有 `src/` 而不存在）；
 * - `files` 收 `lib`，不收 `src` 與 `.map`（`vendor/*` 照 dsh 豁免 `src`：dsh 的 vendor `files` 帶 `src`，`.map` 仍不收）；
 * - 每個 `lib/<路徑>.js` 都有對應的 `src/<路徑>.ts` 可編。
 *
 * 跟 `gen-tsconfig-paths.ts --check` 一起接在 gate：新增套件忘了改成 `lib/`，或手滑把 `src/` 放進 `files`，合併前就紅。
 *
 * @module
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { ROOT, workspacePackages } from './workspace-packages.js';
import type { WorkspacePackage } from './workspace-packages.js';

export interface ManifestViolation {
  readonly dir: string;
  readonly message: string;
}

/** `exports` 裡不必指 `lib/` 的 key。 */
const EXEMPT_EXPORT_KEYS = new Set(['./package.json', './src/*']);

const LIB_FILE = /^\.?\/?lib\/(.+)\.js$/;

function targetsOf(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (typeof value === 'object' && value !== null) {
    return (
      Object.entries(value as Record<string, unknown>)
        // `types` 條件指 `.d.ts`（vendor 由各自的 prepare 產），不是執行期入口。
        .filter(([condition]) => condition !== 'types')
        .flatMap(([, nested]) => targetsOf(nested))
    );
  }
  return [];
}

function checkTarget(
  pkg: WorkspacePackage,
  where: string,
  target: string,
  violations: ManifestViolation[],
): void {
  const match = LIB_FILE.exec(target);
  if (match?.[1] === undefined) {
    violations.push({
      dir: pkg.dir,
      message: `${where} 是 ${JSON.stringify(target)}，要指 ./lib/…js（出貨的是編好的 JS）`,
    });
    return;
  }
  // `imports` 的 `*`、`exports` 的 `*` 對到一群檔，逐檔存在與否由 tsdown 入口推導去管。
  if (match[1].includes('*')) return;
  if (!existsSync(join(ROOT, pkg.dir, 'src', `${match[1]}.ts`))) {
    violations.push({
      dir: pkg.dir,
      message: `${where} 指 ${target}，但 src/${match[1]}.ts 不存在，編不出來`,
    });
  }
}

/**
 * @param packages - 要檢的套件，省略即 repo 裡全部。
 * @returns 違規清單；空代表全部合格。
 */
export function collectManifestViolations(
  packages: readonly WorkspacePackage[] = workspacePackages(),
): ManifestViolation[] {
  const violations: ManifestViolation[] = [];
  for (const pkg of packages) {
    const { manifest } = pkg;
    if (manifest.main !== undefined) checkTarget(pkg, 'main', manifest.main, violations);
    const bin = typeof manifest.bin === 'string' ? { [manifest.name]: manifest.bin } : manifest.bin;
    for (const [name, target] of Object.entries(bin ?? {})) {
      checkTarget(pkg, `bin.${name}`, target, violations);
    }
    for (const [key, target] of Object.entries(manifest.imports ?? {})) {
      checkTarget(pkg, `imports[${JSON.stringify(key)}]`, target, violations);
    }
    for (const [key, value] of Object.entries(manifest.exports ?? {})) {
      if (EXEMPT_EXPORT_KEYS.has(key)) continue;
      for (const target of targetsOf(value)) {
        checkTarget(pkg, `exports[${JSON.stringify(key)}]`, target, violations);
      }
    }
    const files = manifest.files ?? [];
    if (!files.some((entry) => entry === 'lib' || entry.startsWith('lib/'))) {
      violations.push({ dir: pkg.dir, message: 'files 沒有收 lib，裝出去的樹會是空的' });
    }
    for (const entry of files) {
      // vendor 照 dsh `scripts/check-workspace-constraints.ts:481-483`：vendored 套件提早 return，不套「產物不帶 src」；
      // dsh 的 vendor `files` 帶 `src`（`vendor/cordis/package.json:26-32`）。`.map` 仍不收（vendor 的 tsconfig 沒開 declarationMap）。
      const isSource = entry === 'src' || entry.startsWith('src/');
      if ((isSource && !pkg.vendor) || entry.endsWith('.map')) {
        violations.push({
          dir: pkg.dir,
          message: `files 收了 ${JSON.stringify(entry)}：產物不帶 src/ 與 .map`,
        });
      }
    }
  }
  return violations;
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  const violations = collectManifestViolations();
  for (const violation of violations) {
    console.error(`verify-lib-manifests：${violation.dir}/package.json ${violation.message}`);
  }
  if (violations.length > 0) process.exitCode = 1;
  else console.log('verify-lib-manifests：所有套件的 manifest 都指 lib/。');
}

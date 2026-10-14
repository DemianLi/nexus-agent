/**
 * **遷出的插件套件的 gate**（[#1420](https://github.com/DemianLi/nexus-agent/issues/1420)）：插件規範四層強制
 * （決議 §3-4 第 12 條）的後兩層之一，保證「每顆遷出的插件都套了 lint、都有一條跑一致性套件的測試」。
 *
 * 形狀照 dsh 的 verify gate（`AGENTS.md:171`：可機械檢查的規則進一道執行的 gate），nexus 的前例是
 * `package-invariants.ts`：純函式、由 `migrated-plugin-gate.test.ts` 在 `pnpm -r run test` 裡跑，CI 不必多一個 step。
 *
 * ## 什麼叫「遷出的」
 *
 * 模組有 `manifest` 具名匯出，**判別就是 `plugin-tree.ts` 的 {@link isFunctionPluginModule}**，不另外寫 grep 或
 * 名單（#1416 PM 決策 Q-A／Q-B）。所以這裡要真的 import 每顆插件的入口：判別吃的是模組命名空間。入口**依檔案路徑**
 * 載入，不依 specifier：新插件不一定在 harness 的相依裡。入口載不進來是違規，指名套件，**不跳過**。
 *
 * ## 查什麼（遷出的每一顆）
 *
 * 1. **lint 設定生效**：量**解析後的設定**，不 grep `eslint.config.js` 的字串。對 `<pkg>/src/index.ts` 問 ESLint
 *    它最後的規則是什麼，逐條比對 SDK 匯出的 {@link pluginLintRules}。這樣也抓得到 `files` 範圍寫錯、以及後面又寫了
 *    一份 `no-restricted-syntax` 把整份蓋掉（flat config 的規則不合併）。
 * 2. **有一條測試呼叫 `checkConformance`**：用 TS AST 找從 `@nexus/sdk` import 進來的那個識別字的呼叫，註解與字串
 *    裡提到不算。**不看結果有沒有被斷言**——跟 `package-invariants` 一樣，這裡只量機械判得出來的東西。
 * 3. **`scripts.lint` 與 `scripts.test` 在場**：少了它們，`pnpm -r run` 會靜靜跳過這個套件，上面兩項在 CI 上就沒
 *    跑。這一項是 (1)(2) 為了讓「兩道檢查真的在 CI 上跑」成立的一部分。
 *
 * **不管**：沒有 `manifest` 匯出的舊插件。Q1 (a)：舊插件這張一行不動，遷出時才受管。
 *
 * @module
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { pluginLintRules } from '@nexus/sdk/lint';
import { ESLint } from 'eslint';
import ts from 'typescript';

import { isFunctionPluginModule } from './plugin-tree.js';

/** 插件套件的目錄前綴：`packages/nexus-plugin-*`。 */
const PLUGIN_DIR_PREFIX = 'nexus-plugin-';

/** 一顆插件套件。路徑一律是 repo 相對的 POSIX 路徑。 */
export interface PluginPackage {
  /** repo 相對的套件目錄，例如 `packages/nexus-plugin-echo`。 */
  readonly dir: string;
  /** `package.json` 的 `name`。 */
  readonly name: string;
  /** 入口檔的絕對路徑；`exports["."]` 優先，其次 `main`。 */
  readonly entry: string;
  /** `package.json` 的 `scripts`。 */
  readonly scripts: Readonly<Record<string, string>>;
}

/** 一條違規。 */
export interface MigratedPluginViolation {
  /** 套件名。 */
  readonly name: string;
  /** repo 相對的套件目錄。 */
  readonly dir: string;
  readonly check: 'entry' | 'scripts' | 'lint' | 'conformance';
  readonly message: string;
}

/** 載入結果：命名空間，或載入失敗的原因。 */
export type LoadedNamespace =
  | { readonly kind: 'loaded'; readonly namespace: unknown }
  | { readonly kind: 'failed'; readonly reason: string };

interface RawPackageJson {
  name?: unknown;
  main?: unknown;
  exports?: unknown;
  scripts?: unknown;
}

function entryOf(manifest: RawPackageJson): string | undefined {
  const exported = manifest.exports;
  if (typeof exported === 'object' && exported !== null) {
    const root = (exported as Record<string, unknown>)['.'];
    if (typeof root === 'string') return root;
  }
  return typeof manifest.main === 'string' ? manifest.main : undefined;
}

/**
 * 掃出 `packages/nexus-plugin-*` 每一顆。
 *
 * **找不到入口就拋，不回退**：入口是判別「遷出與否」的唯一依據，沒有它就沒辦法說這顆管不管，靜靜跳過的 gate
 * 比沒有 gate 更糟。
 *
 * @param root - repo 根（絕對路徑）。
 * @returns 依目錄名排序的套件。
 * @throws 某個套件的 `package.json` 沒有 `name`，或沒有入口。
 */
export function pluginPackages(root: string): PluginPackage[] {
  const packagesRoot = resolve(root, 'packages');
  return readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(PLUGIN_DIR_PREFIX))
    .map((entry) => entry.name)
    .sort()
    .flatMap((directory) => {
      const manifestPath = join(packagesRoot, directory, 'package.json');
      if (!existsSync(manifestPath)) return [];
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as RawPackageJson;
      const dir = `packages/${directory}`;
      if (typeof manifest.name !== 'string') throw new Error(`${dir}/package.json 沒有 name`);
      const entry = entryOf(manifest);
      if (entry === undefined) {
        throw new Error(`${dir}/package.json 沒有入口（exports["."] 或 main），無法判別它遷出與否`);
      }
      const scripts =
        typeof manifest.scripts === 'object' && manifest.scripts !== null
          ? (manifest.scripts as Record<string, string>)
          : {};
      return [
        { dir, name: manifest.name, entry: resolve(packagesRoot, directory, entry), scripts },
      ];
    });
}

/**
 * 依檔案路徑載入每一顆的入口。載入失敗的記成 `failed`，不拋：一顆壞了不該讓其他顆的結果消失。
 *
 * @param packages - {@link pluginPackages} 的結果。
 * @returns 套件目錄到載入結果。
 */
export async function loadPluginNamespaces(
  packages: readonly PluginPackage[],
): Promise<Map<string, LoadedNamespace>> {
  const loaded = new Map<string, LoadedNamespace>();
  for (const pkg of packages) {
    try {
      const namespace: unknown = await import(pathToFileURL(pkg.entry).href);
      loaded.set(pkg.dir, { kind: 'loaded', namespace });
    } catch (error) {
      loaded.set(pkg.dir, {
        kind: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return loaded;
}

/**
 * 哪些是遷出的：載得進來、而且 {@link isFunctionPluginModule} 為真。
 *
 * @param packages - {@link pluginPackages} 的結果。
 * @param loaded - {@link loadPluginNamespaces} 的結果。
 */
export function migratedPackages(
  packages: readonly PluginPackage[],
  loaded: ReadonlyMap<string, LoadedNamespace>,
): PluginPackage[] {
  return packages.filter((pkg) => {
    const result = loaded.get(pkg.dir);
    return result?.kind === 'loaded' && isFunctionPluginModule(result.namespace);
  });
}

/** `ESLint` 解析後的嚴重度是數字，SDK 匯出的是字串；比對前先對齊。 */
const SEVERITY: Record<string, number> = { off: 0, warn: 1, error: 2 };

function expectedRule(value: readonly unknown[]): unknown[] {
  const [severity, ...options] = value;
  return [typeof severity === 'string' ? SEVERITY[severity] : severity, ...options];
}

/**
 * 這一顆的 lint 設定有沒有生效：回違規訊息，沒有就回空陣列。
 *
 * 量的是 ESLint 對 `<pkg>/src/index.ts` 解析出的最後設定。
 */
async function lintViolations(root: string, pkg: PluginPackage): Promise<string[]> {
  const packageDir = resolve(root, pkg.dir);
  const probe = join(packageDir, 'src', 'index.ts');
  let resolved: { rules?: Record<string, unknown> } | undefined;
  try {
    resolved = (await new ESLint({ cwd: packageDir }).calculateConfigForFile(probe)) as
      { rules?: Record<string, unknown> } | undefined;
  } catch (error) {
    return [
      `載入 ESLint 設定失敗（${error instanceof Error ? error.message : String(error)}）：` +
        '`eslint.config.js` 要套用 `@nexus/sdk/lint`',
    ];
  }
  if (resolved === undefined) {
    return [`ESLint 把 \`${pkg.dir}/src/index.ts\` 當成被忽略的檔：lint 設定管不到插件的 src`];
  }
  const problems: string[] = [];
  for (const [ruleId, value] of Object.entries(pluginLintRules)) {
    const actual = resolved.rules?.[ruleId];
    if (!isDeepStrictEqual(actual, expectedRule(value))) {
      problems.push(
        `\`${ruleId}\` 在 \`src/index.ts\` 上沒有生效成 \`@nexus/sdk/lint\` 給的值：` +
          '`eslint.config.js` 要展開 `pluginLintConfig`，而且後面不能再寫一份蓋掉它',
      );
    }
  }
  return problems;
}

/** 套件裡的測試檔：`*.test.ts(x)`，不進 `node_modules`。 */
function testFilesOf(directory: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      if (name === 'node_modules' || name === 'dist') continue;
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.test\.tsx?$/.test(name)) found.push(path);
    }
  };
  if (existsSync(directory)) walk(directory);
  return found.sort();
}

const SDK_SPECIFIER = /^@nexus\/sdk(\/|$)/;
const CONFORMANCE = 'checkConformance';

/**
 * 這個檔有沒有呼叫從 `@nexus/sdk` 來的 `checkConformance`。
 *
 * 認三種拿到它的方式：具名 import（含 `as` 別名）、命名空間 import 後 `ns.checkConformance(...)`。
 * 註解、字串、沒有呼叫的 import 都不算。
 */
export function callsCheckConformance(sourceText: string, fileName = 'file.test.ts'): boolean {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const direct = new Set<string>();
  const namespaces = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!SDK_SPECIFIER.test(statement.moduleSpecifier.text)) continue;
    if (statement.importClause?.isTypeOnly === true) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
      continue;
    }
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      const imported = (element.propertyName ?? element.name).text;
      if (imported === CONFORMANCE) direct.add(element.name.text);
    }
  }
  if (direct.size === 0 && namespaces.size === 0) return false;
  let called = false;
  const visit = (node: ts.Node): void => {
    if (called) return;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && direct.has(callee.text)) called = true;
      else if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        namespaces.has(callee.expression.text) &&
        callee.name.text === CONFORMANCE
      ) {
        called = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return called;
}

function conformanceViolations(root: string, pkg: PluginPackage): string[] {
  const packageDir = resolve(root, pkg.dir);
  const files = testFilesOf(packageDir);
  const has = files.some((file) => callsCheckConformance(readFileSync(file, 'utf8'), file));
  if (has) return [];
  return [
    files.length === 0
      ? '沒有任何測試檔：要有一條測試呼叫從 `@nexus/sdk` 來的 `checkConformance`'
      : `${files.length} 個測試檔裡沒有一條呼叫從 \`@nexus/sdk\` import 的 \`checkConformance\`` +
        `（${files.map((file) => relative(packageDir, file)).join('、')}）`,
  ];
}

function scriptViolations(pkg: PluginPackage): string[] {
  return ['lint', 'test']
    .filter((name) => typeof pkg.scripts[name] !== 'string' || pkg.scripts[name] === '')
    .map(
      (name) =>
        `\`scripts.${name}\` 不在：少了它，\`pnpm -r run ${name}\` 會靜靜跳過這個套件，這一道檢查在 CI 上就沒跑`,
    );
}

/**
 * 對一份載入結果做檢查。載入與檢查拆開，好讓測試直接餵命名空間。
 *
 * @param root - repo 根（絕對路徑）。
 * @param packages - {@link pluginPackages} 的結果。
 * @param loaded - {@link loadPluginNamespaces} 的結果。
 * @returns 違規；空陣列代表合格。
 */
export async function collectMigratedPluginViolations(
  root: string,
  packages: readonly PluginPackage[],
  loaded: ReadonlyMap<string, LoadedNamespace>,
): Promise<MigratedPluginViolation[]> {
  const violations: MigratedPluginViolation[] = [];
  const push = (
    pkg: PluginPackage,
    check: MigratedPluginViolation['check'],
    messages: string[],
  ) => {
    for (const message of messages)
      violations.push({ name: pkg.name, dir: pkg.dir, check, message });
  };
  for (const pkg of packages) {
    const result = loaded.get(pkg.dir);
    if (result === undefined || result.kind === 'failed') {
      push(pkg, 'entry', [
        `入口載不進來，判別不了它遷出與否（${result?.kind === 'failed' ? result.reason : '沒有載入結果'}）`,
      ]);
    }
  }
  for (const pkg of migratedPackages(packages, loaded)) {
    push(pkg, 'scripts', scriptViolations(pkg));
    push(pkg, 'lint', await lintViolations(root, pkg));
    push(pkg, 'conformance', conformanceViolations(root, pkg));
  }
  return violations;
}

/** 一行一條，指名套件與哪一項。 */
export function formatMigratedPluginViolation(violation: MigratedPluginViolation): string {
  return `${violation.name}（${violation.dir}）[${violation.check}]：${violation.message}`;
}

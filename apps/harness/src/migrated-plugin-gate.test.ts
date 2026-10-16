/**
 * 遷出的插件 gate 的測試（[#1420](https://github.com/DemianLi/nexus-agent/issues/1420) 驗收 C、D、E）。
 *
 * 照 `package-invariants.test.ts` 的兩半：
 *
 * 1. **對著真的 repo 跑**：掃得到的套件數與遷出的集合**寫死成實數**。掃描根寫壞、入口讀錯、判別式換了——這幾種
 *    缺陷會讓 gate 掃到空集合然後回報零違規，也就是永遠綠。一個永遠綠的 gate 比沒有 gate 更糟。
 * 2. **對著臨時目錄裡的假套件跑**：每一項檢查配一個真的會紅的樣本。檢查沒接上去的話，樣本會綠。
 *
 * 假套件的 `eslint.config.js` 用 SDK lint 的**絕對檔案 URL** import：臨時目錄解析不到 `@nexus/sdk`。
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  callsCheckConformance,
  collectMigratedPluginViolations,
  formatMigratedPluginViolation,
  loadPluginNamespaces,
  migratedPackages,
  pluginPackages,
} from './migrated-plugin-gate.js';
import type { LoadedNamespace, PluginPackage } from './migrated-plugin-gate.js';
import { repositoryRoot } from './package-invariants.js';

const ROOT = repositoryRoot();

/** 這個 repo 現在有的插件套件數。**寫死**：拿掃描的結果自己比自己驗不出東西。舊插件 18 顆，加上 echo、token-meter 與 trajectory。agent-instructions、skills、feedback、ask-user、todo、submit-record 與 present 本來就是一個套件，遷出不改總數；`@nexus/skills`、`@nexus/commands`、`@nexus/feedback`、`@nexus/agent-loop`、`@nexus/approval-channel`、`@nexus/tool-result`、`@nexus/session` 與 `@nexus/fs` 一樣是定義套件、不在 `nexus-plugin-*` 底下。`@nexus/session` 不是插件（目錄是 `packages/nexus-session`，不在 `nexus-plugin-*` 底下），掃描器的定義就是目錄前綴，所以總數不因它而動。 */
const EXPECTED_PLUGIN_PACKAGES = 21;
const EXPECTED_MIGRATED = [
  '@nexus/plugin-agent-instructions',
  '@nexus/plugin-ask-user',
  '@nexus/plugin-echo',
  '@nexus/plugin-feedback',
  '@nexus/plugin-present',
  '@nexus/plugin-skills',
  '@nexus/plugin-submit-record',
  '@nexus/plugin-todo',
  '@nexus/plugin-token-meter',
  '@nexus/plugin-trajectory',
];

describe('對著真的 repo：掃得到、判得對、零違規', () => {
  let packages: PluginPackage[];
  let loaded: Map<string, LoadedNamespace>;

  beforeAll(async () => {
    packages = pluginPackages(ROOT);
    loaded = await loadPluginNamespaces(packages);
  }, 120_000);

  it('掃到的插件套件數是實數；每一顆的入口都載得進來', () => {
    expect(packages).toHaveLength(EXPECTED_PLUGIN_PACKAGES);
    const failed = [...loaded.entries()].filter(([, result]) => result.kind === 'failed');
    expect(failed.map(([dir]) => dir)).toEqual([]);
  });

  it('遷出的集合正好是 agent-instructions、ask-user、echo、feedback、present、skills、submit-record、todo、token-meter 與 trajectory；舊插件不在裡面', () => {
    expect(migratedPackages(packages, loaded).map((pkg) => pkg.name)).toEqual(EXPECTED_MIGRATED);
    const older = packages
      .map((pkg) => pkg.name)
      .filter((name) => !EXPECTED_MIGRATED.includes(name));
    expect(older).toHaveLength(EXPECTED_PLUGIN_PACKAGES - EXPECTED_MIGRATED.length);
    expect(older).toContain('@nexus/plugin-goal');
    expect(older).not.toContain('@nexus/plugin-present');
  });

  it('現在零違規（驗收 C：agent-instructions、ask-user、echo、feedback、present、skills、submit-record、todo、token-meter 與 trajectory 套用 SDK lint 設定、有一致性測試）', async () => {
    const violations = await collectMigratedPluginViolations(ROOT, packages, loaded);
    expect(violations.map(formatMigratedPluginViolation)).toEqual([]);
  });
});

/** 一顆假套件的各個零件；省略的用合格的預設值。 */
interface FakeOptions {
  readonly entry?: string;
  readonly scripts?: Record<string, string>;
  readonly eslintConfig?: string;
  readonly testSource?: string | null;
}

const SDK_LINT_URL = pathToFileURL(join(ROOT, 'packages/nexus-sdk/src/lint.ts')).href;

const CONFIG_WITH_SDK_LINT = `import { pluginLintConfig } from '${SDK_LINT_URL}';
export default [{ files: ['**/*.ts'] }, ...pluginLintConfig];
`;

const CONFORMANCE_TEST = `import { checkConformance } from '@nexus/sdk';
import { expect, it } from 'vitest';
it('一致性套件', async () => {
  expect(await checkConformance({} as never)).toEqual([]);
});
`;

const temporaryRoots: string[] = [];

afterAll(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** 在一個臨時 repo 根底下造一顆插件套件，回根目錄與那一顆。 */
function fakeRepo(options: FakeOptions = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'nexus-plugin-gate-'));
  temporaryRoots.push(root);
  const dir = join(root, 'packages', 'nexus-plugin-fake');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: '@nexus/plugin-fake',
      type: 'module',
      exports: { '.': './src/index.js' },
      scripts: options.scripts ?? { lint: 'eslint .', test: 'vitest run' },
    }),
  );
  writeFileSync(join(dir, 'src', 'index.js'), options.entry ?? 'export const manifest = {};\n');
  writeFileSync(join(dir, 'eslint.config.js'), options.eslintConfig ?? CONFIG_WITH_SDK_LINT);
  if (options.testSource !== null) {
    writeFileSync(join(dir, 'src', 'index.test.ts'), options.testSource ?? CONFORMANCE_TEST);
  }
  return root;
}

async function gate(root: string) {
  const packages = pluginPackages(root);
  const loaded = await loadPluginNamespaces(packages);
  const violations = await collectMigratedPluginViolations(root, packages, loaded);
  return { packages, loaded, violations };
}

describe('驗收 D：gate 的四種情況', () => {
  it('兩件都有：綠', async () => {
    const { packages, loaded, violations } = await gate(fakeRepo());
    expect(migratedPackages(packages, loaded)).toHaveLength(1);
    expect(violations).toEqual([]);
  });

  it('有 manifest 匯出、缺一致性測試：紅，指名套件與那一項', async () => {
    const { violations } = await gate(
      fakeRepo({ testSource: "import { it } from 'vitest'; it('別的', () => {});\n" }),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ name: '@nexus/plugin-fake', check: 'conformance' });
    expect(formatMigratedPluginViolation(violations[0]!)).toContain('@nexus/plugin-fake');
  });

  it('有 manifest 匯出、沒套 SDK lint 設定：紅，指名套件', async () => {
    const { violations } = await gate(
      fakeRepo({ eslintConfig: "export default [{ files: ['**/*.ts'], rules: {} }];\n" }),
    );
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.every((v) => v.name === '@nexus/plugin-fake' && v.check === 'lint')).toBe(
      true,
    );
    // 四個內建規則逐條報，不是只報一條。
    expect(violations).toHaveLength(4);
  });

  it('沒有 manifest 匯出的舊插件：gate 不管（沒 lint 設定、沒測試也一樣）', async () => {
    const root = fakeRepo({
      entry: "export default { name: 'old', apply() {} };\n",
      eslintConfig: 'export default [];\n',
      testSource: null,
    });
    const { packages, loaded, violations } = await gate(root);
    expect(packages).toHaveLength(1);
    expect(migratedPackages(packages, loaded)).toEqual([]);
    expect(violations).toEqual([]);
  });
});

describe('驗收 G：gate 的每一項檢查各有一個會紅的樣本', () => {
  it('lint：後面又寫一份 `no-restricted-syntax` 把整份蓋掉', async () => {
    const config = `import { pluginLintConfig } from '${SDK_LINT_URL}';
export default [{ files: ['**/*.ts'] }, ...pluginLintConfig, { files: ['**/*.ts'], rules: { 'no-restricted-syntax': 'off' } }];
`;
    const { violations } = await gate(fakeRepo({ eslintConfig: config }));
    expect(violations.map((v) => v.check)).toEqual(['lint']);
    expect(violations[0]!.message).toContain('no-restricted-syntax');
  });

  it('lint：`files` 範圍寫錯，管不到 src', async () => {
    const config = `import { pluginLintConfig } from '${SDK_LINT_URL}';
export default [{ files: ['**/*.ts'] }, ...pluginLintConfig.map((c) => ({ ...c, files: ['lib/**/*.ts'] }))];
`;
    const { violations } = await gate(fakeRepo({ eslintConfig: config }));
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.every((v) => v.check === 'lint')).toBe(true);
  });

  it('lint：找不到設定也算沒生效（臨時目錄往上沒有任何 eslint.config.js，ESLint 拋錯、被接成違規）', async () => {
    const root = fakeRepo();
    rmSync(join(root, 'packages', 'nexus-plugin-fake', 'eslint.config.js'));
    const { violations } = await gate(root);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.every((v) => v.check === 'lint')).toBe(true);
  });

  it('scripts：缺 `lint` 或缺 `test` 各紅一條，指名是哪一個', async () => {
    const noLint = await gate(fakeRepo({ scripts: { test: 'vitest run' } }));
    expect(noLint.violations.map((v) => v.check)).toEqual(['scripts']);
    expect(noLint.violations[0]!.message).toContain('scripts.lint');
    const noTest = await gate(fakeRepo({ scripts: { lint: 'eslint .' } }));
    expect(noTest.violations.map((v) => v.check)).toEqual(['scripts']);
    expect(noTest.violations[0]!.message).toContain('scripts.test');
  });

  it('conformance：只在註解或字串裡提到、或 import 了沒呼叫、或呼叫的是別處的同名函式：都紅', async () => {
    const samples = [
      "// checkConformance(...)\nimport { it } from 'vitest'; it('x', () => {});\n",
      "import { it } from 'vitest'; it('checkConformance', () => { void 'checkConformance(x)'; });\n",
      "import { checkConformance } from '@nexus/sdk';\nvoid checkConformance;\n",
      "import { checkConformance } from './mine.js';\nawait checkConformance({});\n",
      "import type { checkConformance } from '@nexus/sdk';\nvoid 0;\n",
    ];
    for (const testSource of samples) {
      const { violations } = await gate(fakeRepo({ testSource }));
      expect(
        violations.map((v) => v.check),
        testSource,
      ).toEqual(['conformance']);
    }
  });

  it('entry：入口載不進來是違規，指名套件，不是跳過', async () => {
    const { violations } = await gate(fakeRepo({ entry: "throw new Error('壞掉的入口');\n" }));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ name: '@nexus/plugin-fake', check: 'entry' });
    expect(violations[0]!.message).toContain('壞掉的入口');
  });

  it('沒有入口宣告就拋，不回退成「不管它」', () => {
    const root = fakeRepo();
    writeFileSync(
      join(root, 'packages', 'nexus-plugin-fake', 'package.json'),
      JSON.stringify({ name: '@nexus/plugin-fake' }),
    );
    expect(() => pluginPackages(root)).toThrow(/沒有入口/);
  });
});

describe('callsCheckConformance：看的是 import 進來的識別字的呼叫', () => {
  it('具名、別名、命名空間三種拿法都算', () => {
    expect(
      callsCheckConformance("import { checkConformance } from '@nexus/sdk'; checkConformance({});"),
    ).toBe(true);
    expect(
      callsCheckConformance("import { checkConformance as run } from '@nexus/sdk'; run({});"),
    ).toBe(true);
    expect(
      callsCheckConformance("import * as sdk from '@nexus/sdk'; sdk.checkConformance({});"),
    ).toBe(true);
    expect(
      callsCheckConformance(
        "import { checkConformance } from '@nexus/sdk/src/conformance.ts'; checkConformance({});",
      ),
    ).toBe(true);
  });

  it('沒有 import、別的套件的同名函式、只有型別 import：不算', () => {
    expect(callsCheckConformance('checkConformance({});')).toBe(false);
    expect(
      callsCheckConformance("import { checkConformance } from 'other'; checkConformance({});"),
    ).toBe(false);
    expect(
      callsCheckConformance("import * as other from 'other'; other.checkConformance({});"),
    ).toBe(false);
  });
});

/** apps/harness/src 底下的非測試原始碼（遞迴）。 */
function harnessSources(): string[] {
  const base = join(ROOT, 'apps/harness/src');
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(path);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        found.push(path);
      }
    }
  };
  walk(base);
  return found.sort();
}

describe('驗收 E：「遷出的」判別只有一個出處', () => {
  const DEFINITION = 'apps/harness/src/plugin-tree.ts';
  const CALLERS = [
    'apps/harness/src/plugin-config.ts', // `resolveEntryModule`：Include 的 allow-list 從它算
    'apps/harness/src/tool-catalog.ts',
    'apps/harness/src/migrated-plugin-gate.ts', // 這一道 gate
  ];

  /** 一個檔裡：有沒有從 `./plugin-tree.js` import `isFunctionPluginModule`、有沒有呼叫它。 */
  function importsAndCalls(path: string): { imported: boolean; called: boolean } {
    const text = readFileSync(join(ROOT, path), 'utf8');
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    let imported = false;
    let called = false;
    const visit = (node: ts.Node): void => {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === './plugin-tree.js'
      ) {
        const bindings = node.importClause?.namedBindings;
        if (
          bindings !== undefined &&
          ts.isNamedImports(bindings) &&
          bindings.elements.some(
            (element) => (element.propertyName ?? element.name).text === 'isFunctionPluginModule',
          )
        ) {
          imported = true;
        }
      }
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'isFunctionPluginModule'
      ) {
        called = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return { imported, called };
  }

  it('定義只有一份，在 plugin-tree.ts', () => {
    const definitions = harnessSources().filter((path) =>
      /export function isFunctionPluginModule\b/.test(readFileSync(path, 'utf8')),
    );
    expect(definitions.map((path) => relative(ROOT, path))).toEqual([DEFINITION]);
  });

  it('gate、Include 的 allow-list（plugin-config）與 tool-catalog 三處都 import 並呼叫同一支', () => {
    for (const path of CALLERS) {
      expect(importsAndCalls(path), path).toEqual({ imported: true, called: true });
    }
  });

  it('apps/harness/src 沒有第二份手寫的「有沒有 manifest」判別', () => {
    const pattern =
      /\bmanifest\b\s*\)?\s*(?:!==|===|!=|==)\s*undefined|['"]manifest['"]\s+in\b|\.\s*hasOwn\w*\([^)]*['"]manifest['"]/;
    const hits = harnessSources()
      .filter((path) => pattern.test(readFileSync(path, 'utf8')))
      .map((path) => relative(ROOT, path));
    expect(hits).toEqual([DEFINITION]);
  });
});

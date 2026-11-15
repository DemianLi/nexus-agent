// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * 前端的 import 方向（`src/` 底下的產品碼；測試檔 `*.test.ts(x)` 與 `src/test/**` 不受限，可以深層 import 與 mock 內部檔）。
 *
 * 三層：**組裝層**（`app/**`、`main.tsx`）→ **切片**（`features/<名>/**`）→ **共用層**（其餘：`shared/**`、`components/ui/**`、
 * `lib/**`、`hooks/**`、`styles/**`、`vendor/**`）。
 *
 * 1. **方向只往下**：共用層不 import 切片或組裝層，切片不 import 組裝層。`import type` 也算。
 * 2. **切片外面只走公開入口**：切片外的產品碼要用切片 X 的東西，指定字只能是 `@/features/X`，不能是 `@/features/X/某檔`。
 * 3. **切片裡面不 import 自己的 `index.ts`**：同一個切片內用 `./某檔`，否則入口與內部互相拉扯成環。
 * 4. **切片之間不循環**：以切片為節點、產品碼的 import 為邊。
 * 5. **每個切片都有 `index.ts`，內容只有具名的 re-export**（`export { a } from './x'`、`export type { T } from './x'`）：
 *    不用 `export *`、不放任何邏輯，讀入口就知道切片對外給了什麼，載入入口不會多跑任何東西。
 * 6. **例外只能變短**：{@link EXCEPTIONS} 列的檔對規則 1、2 有明文豁免；列了卻沒命中（檔不見了、import 改走別的路）就紅，
 *    逼清單跟著現況收斂。
 *
 * 判不出來的：入口多匯出了沒人用的名字、名字取得好不好、切片切得對不對。
 */

const SRC = fileURLToPath(new URL('.', import.meta.url));

type Sources = Readonly<Record<string, string>>;
type Violation = { rule: number; file: string; line: number; spec: string; message: string };
type Exception = { file: string; targets: readonly string[]; why: string };

/** 對規則 1、2 的明文豁免：`file` 允許深層 import `targets`（路徑相對 `src/`，不含副檔名）。要等的卡寫在 `why`。 */
const EXCEPTIONS: readonly Exception[] = [
  {
    file: 'shared/connection/use-conversation.ts',
    targets: ['features/attachments/send', 'features/goal/bar-view'],
    why: '連線核心還拉著兩個切片的錯誤文案（送出被拒、暫停目標失敗）；走入口會把整個切片的元件帶進連線核心的載入圖。等 #2883 的下行錯誤碼轉文案收成一個 module',
  },
  {
    file: 'shared/right-sidebar/api.ts',
    targets: [
      'features/changes/diff',
      'features/cost/subagent-usage',
      'features/deliverable/download',
      'features/deliverable/file',
      'features/deliverable/view',
      'features/trace/trajectory-pull',
    ],
    why: '右側欄的契約型別直接指向各分頁的資料型別；走入口會讓契約檔跟著載入各切片的元件。等 #2883 的右側欄分頁登記',
  },
  {
    file: 'shared/right-sidebar/layout.ts',
    targets: ['features/deliverable/view', 'features/plan/review-view'],
    why: '右側欄的版面推導直接讀分頁的檢視模型。等 #2883 的右側欄分頁登記',
  },
];

type Zone = { kind: 'slice'; name: string } | { kind: 'app' } | { kind: 'shared' };

function zoneOf(path: string): Zone {
  const slice = /^features\/([^/]+)\//.exec(path);
  if (slice?.[1] !== undefined) return { kind: 'slice', name: slice[1] };
  return path.startsWith('app/') || path === 'main.tsx' ? { kind: 'app' } : { kind: 'shared' };
}

/** 一份原始碼裡所有的指定字與行號：`import`、`export … from`、`import type`、動態 `import()`、型別位置的 `import('x')`。 */
function specifiersOf(file: string, source: string): { spec: string; line: number }[] {
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: { spec: string; line: number }[] = [];
  const add = (node: ts.Node, literal: ts.Node | undefined) => {
    if (literal !== undefined && ts.isStringLiteralLike(literal)) {
      found.push({
        spec: literal.text,
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      });
    }
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      add(node, node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference)) {
        add(node, node.moduleReference.expression);
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      add(node, node.arguments[0]);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node, node.argument.literal);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** 指定字解析成 `src/` 底下的實際檔（不含副檔名的字尾也找）；套件、資源檔、找不到的回 `null`。 */
function resolveSpec(from: string, spec: string, files: ReadonlySet<string>): string | null {
  const bare = spec.replace(/[?#].*$/, '');
  let base: string;
  if (bare.startsWith('@/')) base = bare.slice(2);
  else if (bare === '.' || bare === '..' || bare.startsWith('./') || bare.startsWith('../')) {
    base = posix.normalize(posix.join(posix.dirname(from), bare));
  } else return null;
  base = base.replace(/\/$/, '');
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ]) {
    if (files.has(candidate)) return candidate;
  }
  return null;
}

const stripExt = (path: string) => path.replace(/\.tsx?$/, '');
const isIndexOf = (path: string, slice: string) =>
  path === `features/${slice}/index.ts` || path === `features/${slice}/index.tsx`;

/** 切片入口的內容：只准具名的 re-export。回傳不合格的語句（行號與原因）。 */
function entryProblems(file: string, source: string): { line: number; message: string }[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  return sf.statements.flatMap((st) => {
    const line = sf.getLineAndCharacterOfPosition(st.getStart(sf)).line + 1;
    if (!ts.isExportDeclaration(st) || st.moduleSpecifier === undefined) {
      return [{ line, message: '入口只准 `export { … } from`，不放邏輯、不放 import 或本地宣告' }];
    }
    if (st.exportClause === undefined || !ts.isNamedExports(st.exportClause)) {
      return [{ line, message: '入口要具名 re-export，不用 `export *`' }];
    }
    const spec = ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : '';
    return spec.startsWith('./')
      ? []
      : [{ line, message: '入口只 re-export 自己切片裡的檔（`./x`）' }];
  });
}

/** 以切片為節點找循環；回一條環上的切片名（首尾相同），沒有就 `null`。 */
function findCycle(edges: ReadonlyMap<string, ReadonlySet<string>>): string[] | null {
  const state = new Map<string, 'open' | 'done'>();
  const stack: string[] = [];
  const dfs = (node: string): string[] | null => {
    state.set(node, 'open');
    stack.push(node);
    for (const next of [...(edges.get(node) ?? [])].sort()) {
      if (state.get(next) === 'open') return [...stack.slice(stack.indexOf(next)), next];
      if (state.get(next) === undefined) {
        const cycle = dfs(next);
        if (cycle !== null) return cycle;
      }
    }
    stack.pop();
    state.set(node, 'done');
    return null;
  };
  for (const node of [...edges.keys()].sort()) {
    if (state.get(node) === undefined) {
      const cycle = dfs(node);
      if (cycle !== null) return cycle;
    }
  }
  return null;
}

/** 整套規則。`sources` 是 `{相對 src/ 的路徑: 原始碼}`，只含產品碼；`slices` 是切片名單。 */
function check(
  sources: Sources,
  slices: readonly string[],
  exceptions: readonly Exception[] = EXCEPTIONS,
): Violation[] {
  const files = new Set(Object.keys(sources));
  const violations: Violation[] = [];
  const edges = new Map<string, Set<string>>();
  const hit = new Set<string>();
  const report = (rule: number, file: string, line: number, spec: string, message: string) =>
    violations.push({ rule, file, line, spec, message });

  for (const file of Object.keys(sources).sort()) {
    const from = zoneOf(file);
    for (const { spec, line } of specifiersOf(file, sources[file] ?? '')) {
      const target = resolveSpec(file, spec, files);
      if (target === null) continue;
      const to = zoneOf(target);

      if (to.kind === 'app' && from.kind !== 'app') {
        report(1, file, line, spec, '方向只往下：切片與共用層不能 import 組裝層');
        continue;
      }
      if (to.kind !== 'slice') continue;
      if (from.kind === 'slice' && from.name === to.name) {
        if (isIndexOf(target, to.name)) {
          report(
            3,
            file,
            line,
            spec,
            `切片裡面不 import 自己的入口，改用 \`./某檔\`（${to.name}）`,
          );
        }
        continue;
      }

      const excepted = exceptions.find(
        (e) => e.file === file && e.targets.includes(stripExt(target)),
      );
      if (excepted !== undefined) {
        hit.add(`${file} -> ${stripExt(target)}`);
      } else if (from.kind === 'shared') {
        report(1, file, line, spec, `方向只往下：共用層不能 import 切片（${to.name}）`);
      } else if (!isIndexOf(target, to.name)) {
        report(2, file, line, spec, `切片外面只走公開入口，改成 \`@/features/${to.name}\``);
      }
      if (from.kind === 'slice') {
        const out = edges.get(from.name) ?? new Set<string>();
        out.add(to.name);
        edges.set(from.name, out);
      }
    }
  }

  const cycle = findCycle(edges);
  if (cycle !== null) {
    report(
      4,
      `features/${cycle[0]}`,
      0,
      cycle.join(' -> '),
      `切片之間不循環：${cycle.join(' -> ')}`,
    );
  }

  for (const slice of slices) {
    const entry = [`features/${slice}/index.ts`, `features/${slice}/index.tsx`].find((p) =>
      files.has(p),
    );
    if (entry === undefined) {
      report(5, `features/${slice}`, 0, '', `切片缺 \`index.ts\`（${slice}）`);
      continue;
    }
    for (const problem of entryProblems(entry, sources[entry] ?? '')) {
      report(5, entry, problem.line, '', problem.message);
    }
  }

  for (const e of exceptions) {
    for (const target of e.targets) {
      if (!hit.has(`${e.file} -> ${target}`)) {
        report(6, e.file, 0, target, '例外沒有命中（檔不見了、或已改走公開入口）：從清單刪掉');
      }
    }
  }
  return violations;
}

const SKIP_DIRS = new Set(['node_modules']);
const isTest = (path: string) => /\.test\.tsx?$/.test(path);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return SKIP_DIRS.has(name) ? [] : walk(path);
    return [path];
  });
}

const productSources: Record<string, string> = Object.fromEntries(
  walk(SRC)
    .map((path) => relative(SRC, path).split(sep).join('/'))
    .filter((path) => /\.tsx?$/.test(path) && !isTest(path) && !path.startsWith('test/'))
    .map((path) => [path, readFileSync(join(SRC, path), 'utf8')]),
);
const sliceNames = readdirSync(join(SRC, 'features'))
  .filter((name) => statSync(join(SRC, 'features', name)).isDirectory())
  .sort();

const describeViolations = (violations: readonly Violation[]) =>
  violations.map(
    (v) =>
      `${v.file}${v.line > 0 ? `:${v.line}` : ''}${v.spec === '' ? '' : ` import '${v.spec}'`}：規則 ${v.rule}，${v.message}`,
  );
const ofRule = (rule: number, violations: readonly Violation[]) =>
  describeViolations(violations.filter((v) => v.rule === rule));

describe('前端的 import 方向（真實的 src）', () => {
  const violations = check(productSources, sliceNames);

  it('量具自檢：掃得到產品碼與切片', () => {
    expect(Object.keys(productSources).length).toBeGreaterThan(150);
    expect(sliceNames.length).toBeGreaterThanOrEqual(10);
    expect(Object.keys(productSources).filter((p) => p.startsWith('app/')).length).toBeGreaterThan(
      3,
    );
    expect(Object.keys(productSources).some((p) => p.startsWith('shared/'))).toBe(true);
  });

  it('1. 方向只往下：共用層不 import 切片與組裝層，切片不 import 組裝層', () => {
    expect(ofRule(1, violations)).toEqual([]);
  });

  it('2. 切片外面只走公開入口 `@/features/<名>`', () => {
    expect(ofRule(2, violations)).toEqual([]);
  });

  it('3. 切片裡面不 import 自己的 index.ts', () => {
    expect(ofRule(3, violations)).toEqual([]);
  });

  it('4. 切片之間不循環', () => {
    expect(ofRule(4, violations)).toEqual([]);
  });

  it('5. 每個切片都有 index.ts，內容只有具名的 re-export', () => {
    expect(ofRule(5, violations)).toEqual([]);
  });

  it('6. 例外清單每一條都命中（只能變短）', () => {
    expect(ofRule(6, violations)).toEqual([]);
  });
});

describe('規則會紅：違規的例子抓得到，合規的放行', () => {
  const slices = ['a', 'b'];
  const entries = { 'features/a/index.ts': '', 'features/b/index.ts': '' };
  const rulesOf = (sources: Sources, exceptions: readonly Exception[] = []) =>
    check({ ...entries, ...sources }, slices, exceptions).map((v) => v.rule);

  it('1. 共用層 import 切片（含 import type、動態 import、export from）', () => {
    for (const code of [
      `import { x } from '@/features/a';`,
      `import type { X } from '@/features/a';`,
      `const m = () => import('@/features/a');`,
      `export { x } from '@/features/a';`,
      `type T = typeof import('@/features/a');`,
    ]) {
      expect(rulesOf({ 'shared/lib/f.ts': code, 'features/a/x.ts': '' })).toContain(1);
    }
    expect(
      rulesOf({ 'shared/lib/f.ts': `import { x } from '@/lib/utils';`, 'lib/utils.ts': '' }),
    ).toEqual([]);
  });

  it('1. 切片與共用層 import 組裝層', () => {
    const app = { 'app/App.tsx': '' };
    expect(rulesOf({ ...app, 'features/a/x.ts': `import { App } from '@/app/App';` })).toContain(1);
    expect(rulesOf({ ...app, 'shared/lib/f.ts': `import type { A } from '@/app/App';` })).toContain(
      1,
    );
    expect(rulesOf({ ...app, 'app/other.ts': `import { App } from './App';` })).toEqual([]);
    expect(
      rulesOf({ 'app/App.tsx': `import { x } from '@/features/a';`, 'features/a/x.ts': '' }),
    ).toEqual([]);
  });

  it('2. 切片外面深層 import 別的切片', () => {
    const a = { 'features/a/x.ts': '' };
    expect(rulesOf({ ...a, 'features/b/y.ts': `import { x } from '@/features/a/x';` })).toEqual([
      2,
    ]);
    expect(rulesOf({ ...a, 'app/App.tsx': `import { x } from '@/features/a/x';` })).toEqual([2]);
    expect(rulesOf({ ...a, 'features/b/y.ts': `import { x } from '../a/x';` })).toEqual([2]);
    expect(rulesOf({ ...a, 'features/b/y.ts': `export { x } from '@/features/a';` })).toEqual([]);
    expect(rulesOf({ ...a, 'app/App.tsx': `import type { X } from '@/features/a';` })).toEqual([]);
  });

  it('3. 切片裡面 import 自己的 index.ts', () => {
    for (const spec of ['@/features/a', '.', './index', '..']) {
      const from = spec === '..' ? 'features/a/sub/y.ts' : 'features/a/y.ts';
      expect(rulesOf({ [from]: `import { x } from '${spec}';` })).toContain(3);
    }
    expect(
      rulesOf({ 'features/a/y.ts': `import { x } from './x';`, 'features/a/x.ts': '' }),
    ).toEqual([]);
  });

  it('4. 切片之間循環', () => {
    const a = `import { y } from '@/features/b';`;
    const b = `import { x } from '@/features/a';`;
    expect(rulesOf({ 'features/a/x.ts': a, 'features/b/y.ts': b })).toEqual([4]);
    expect(rulesOf({ 'features/a/x.ts': a, 'features/b/y.ts': '' })).toEqual([]);
    expect(
      check(
        {
          ...entries,
          'features/c/index.ts': '',
          'features/a/x.ts': a,
          'features/b/y.ts': `import { z } from '@/features/c';`,
          'features/c/z.ts': `import { x } from '@/features/a';`,
        },
        ['a', 'b', 'c'],
        [],
      ).map((v) => v.message),
    ).toEqual(['切片之間不循環：a -> b -> c -> a']);
  });

  it('5. 入口缺檔、export *、放邏輯、re-export 別的切片', () => {
    const ok = `export { x } from './x';\nexport type { T } from './x';`;
    expect(check({ 'features/a/index.ts': ok }, ['a'], [])).toEqual([]);
    expect(check({}, ['a'], []).map((v) => v.rule)).toEqual([5]);
    for (const bad of [
      `export * from './x';`,
      `export * as ns from './x';`,
      `export const x = 1;`,
      `import { x } from './x';\nexport { x };`,
      `export { x };`,
      `export { x } from '@/features/b';`,
      `export default 1;`,
    ]) {
      expect(check({ 'features/a/index.ts': bad }, ['a'], []).map((v) => v.rule)).toContain(5);
    }
  });

  it('6. 例外：命中時豁免規則 1、2；沒命中就紅；沒列的邊照常擋', () => {
    const exception = { file: 'shared/lib/f.ts', targets: ['features/a/x'], why: '測試' };
    const sources = {
      'shared/lib/f.ts': `import { x } from '@/features/a/x';`,
      'features/a/x.ts': '',
    };
    expect(rulesOf(sources, [exception])).toEqual([]);
    expect(rulesOf({ ...sources, 'shared/lib/f.ts': '' }, [exception])).toEqual([6]);
    expect(
      rulesOf({ ...sources, 'shared/lib/f.ts': `import { x } from '@/features/a';` }, [exception]),
    ).toEqual([1, 6]);
    expect(
      rulesOf(
        {
          ...sources,
          'shared/lib/f.ts': `import { x } from '@/features/a/x';\nimport { y } from '@/features/b/y';`,
          'features/b/y.ts': '',
        },
        [exception],
      ),
    ).toEqual([1]);
  });

  it('失敗訊息帶檔名、行號、指定字與規則', () => {
    const [v] = check(
      { ...entries, 'features/a/x.ts': '', 'app/App.tsx': `\nimport { x } from '@/features/a/x';` },
      slices,
      [],
    );
    expect(describeViolations([v!])).toEqual([
      "app/App.tsx:2 import '@/features/a/x'：規則 2，切片外面只走公開入口，改成 `@/features/a`",
    ]);
  });
});

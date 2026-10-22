/**
 * **會話的檔名與讀 header 只有一份定義**（[#1857](https://github.com/DemianLi/nexus-agent/issues/1857) 驗收 A，#1594 拆刀 ①）。
 *
 * 一份會話是 `<base>.header.json`＋`<base>.jsonl`＋`<base>.lock`。檔名只在 `@nexus/core` 的 `session-filename.ts`
 * 定義，讀一份會話只走 `jsonl-session-store.ts` 的 `readSessionEntry`（照 dsh `packages/session/session-format/src/filename.ts`
 * 的「檔名只有一份定義」）。#1594 ② 換佈局時只動這兩處；別處自己拼檔名、自己解 header，換佈局那天就會靜靜讀錯。
 *
 * 擋三種寫法（非測試程式；測試的遷移是 ①b）：
 *
 * - 字串字面量或模板片段**以 `.jsonl` 結尾**，或**含 `header.json`**；regex 字面量裡出現這兩個字也算。
 * - 從 `jsonl-session-store` 匯入、轉出或解構 `parseHeader`／`sessionLogPathOf`，或以屬性存取它們。
 *
 * 不是會話的 `.jsonl`（變更紀錄、結果檔……）照 dsh `scripts/verify-no-bare-dispatcher.ts` 的 `proxy-exempt:` 做法：
 * 同一行或上一行的註解寫 `session-file-exempt: <理由>`。**理由空白也紅**：新加的 `.jsonl` 一定要說它為什麼不是會話檔。
 * 不列白名單檔：列了檔，那個檔之後新增的會話檔名就沒人看。
 *
 * 用 TypeScript 的語法樹掃，不用逐行正則：只出現在註解裡的檔名（說明文字）不算，簡寫解構與改名匯入正則會漏。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** 檔名與讀法的擁有者：寫檔名、解 header 是它們的本分。`in-tree/` 複製進舊 tag 的樹裡跑，import 不到新模組。 */
const OWNERS = [
  'packages/nexus-core/src/session-filename.ts',
  'apps/harness/src/jsonl-session-store.ts',
  'scripts/session-format-fixtures/in-tree/',
] as const;

/** 豁免記號；後面要寫理由。 */
const EXEMPT_MARKER = 'session-file-exempt:';

/** 只有後端能用的讀法。 */
const STORE_ONLY = new Set(['parseHeader', 'sessionLogPathOf']);

const isStore = (specifier: string): boolean =>
  /(^|\/)jsonl-session-store(\.[cm]?[jt]s)?$/u.test(specifier);

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly what: string;
}

/**
 * 找出一份原始碼裡自己碰會話檔名或 header 讀法的位置。
 *
 * @param file - 顯示在結果裡的路徑。
 * @param text - 原始碼。
 */
export function findViolations(file: string, text: string): Violation[] {
  // 預篩：建語法樹是這條測試的成本。每一種違規都要有其中一串字，豁免記號本身也要驗理由。
  // 放在這裡而不是掃描迴圈，是為了讓下面的量具自檢每一種寫法都走過這道預篩。
  if (!/jsonl|header\\?\.json|parseHeader|sessionLogPathOf|session-file-exempt/u.test(text)) {
    return [];
  }
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const lineOf = (position: number): number => source.getLineAndCharacterOfPosition(position).line;

  // 先收註解：每個節點前後的 trivia 都看一遍，同一段只算一次。
  const exemptLines = new Set<number>();
  const found: Violation[] = [];
  const seen = new Set<number>();
  const collectComments = (node: ts.Node): void => {
    for (const range of [
      ...(ts.getLeadingCommentRanges(text, node.pos) ?? []),
      ...(ts.getTrailingCommentRanges(text, node.end) ?? []),
    ]) {
      if (seen.has(range.pos)) continue;
      seen.add(range.pos);
      const comment = text.slice(range.pos, range.end);
      const at = comment.indexOf(EXEMPT_MARKER);
      if (at < 0) continue;
      const line = lineOf(range.pos + at);
      const reason = (comment.slice(at + EXEMPT_MARKER.length).split('\n')[0] ?? '')
        .replace(/\*\/\s*$/u, '')
        .trim();
      if (reason.length === 0) {
        found.push({ file, line: line + 1, what: '豁免記號沒寫理由' });
      } else {
        exemptLines.add(line);
        exemptLines.add(line + 1);
      }
    }
    ts.forEachChild(node, collectComments);
  };
  collectComments(source);

  const add = (node: ts.Node, what: string): void => {
    const line = lineOf(node.getStart(source));
    if (!exemptLines.has(line)) found.push({ file, line: line + 1, what });
  };
  const literal = (node: ts.Node, value: string): void => {
    if (value.includes('header.json')) add(node, '字串裡有 header.json');
    else if (value.endsWith('.jsonl')) add(node, '字串以 .jsonl 結尾');
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      literal(node, node.text);
    } else if (ts.isRegularExpressionLiteral(node)) {
      if (/jsonl|header\\?\.json/u.test(node.text)) add(node, 'regex 認會話檔名');
    } else if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      isStore(node.moduleSpecifier.text)
    ) {
      const bindings = ts.isImportDeclaration(node)
        ? node.importClause?.namedBindings
        : node.exportClause;
      if (bindings !== undefined && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings))) {
        for (const element of bindings.elements) {
          if (STORE_ONLY.has((element.propertyName ?? element.name).text)) {
            add(element, `從後端拿 ${(element.propertyName ?? element.name).text}`);
          }
        }
      }
      // 模組字串本身不是會話檔名，不往下看。
      return;
    } else if (ts.isPropertyAccessExpression(node) && STORE_ONLY.has(node.name.text)) {
      add(node.name, `從後端拿 ${node.name.text}`);
    } else if (ts.isBindingElement(node)) {
      const name = node.propertyName ?? node.name;
      if (ts.isIdentifier(name) && STORE_ONLY.has(name.text)) add(name, `從後端拿 ${name.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * 掃哪些原始碼。**`'apps/web/src'` 要寫成字面值出現在這裡**：`.github/scripts/plan_ci.py` 靠檔案裡有這串字面值，
 * 才把它認成「掃整個樹的絆索」而在選擇性測試時也必跑（同 `no-bare-dispatcher.test.ts`）。
 */
const SOURCE_ROOTS = ['apps/harness/src', 'apps/web/src', 'packages', 'scripts'] as const;

/** 原始碼：`.ts`／`.tsx`／`.mts`／`.mjs`，宣告檔與測試檔不算（測試是 ①b）。`.fixture.ts`、`.smoke.ts` 是非測試，要掃。 */
const isSource = (name: string): boolean =>
  /\.(tsx?|mts|cts|mjs|cjs)$/u.test(name) &&
  !/\.d\.[cm]?ts$/u.test(name) &&
  !/\.test\.tsx?$/u.test(name);

/** 遞迴列出原始碼，跳過相依與建置產物（`dist`，與套件根底下的 `lib`）。 */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      if (/^packages\/[^/]+\/lib$/u.test(relative(REPO_ROOT, full))) continue;
      out.push(...sourceFiles(full));
    } else if (isSource(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe('量具自檢：每一種寫法都抓得到，註解與豁免不算', () => {
  const at = (text: string) => findViolations('x.ts', text).map((v) => v.what);

  it.each([
    ["const f = 'runs.jsonl';", '字串以 .jsonl 結尾'],
    ['const f = `${id}.jsonl`;', '字串以 .jsonl 結尾'],
    ['const f = `${a}.jsonl${b}`;', '字串以 .jsonl 結尾'],
    ['const f = `.jsonl${b}`;', '字串以 .jsonl 結尾'],
    ["const h = 'cli.header.json';", '字串裡有 header.json'],
    ['const h = `${id}.header.json.${hex}.tmp`;', '字串裡有 header.json'],
    ['const ok = /cli\\.jsonl$/.test(name);', 'regex 認會話檔名'],
    ['const ok = /\\.header\\.json$/.test(name);', 'regex 認會話檔名'],
    ["import { parseHeader } from './jsonl-session-store.js';", '從後端拿 parseHeader'],
    ["import { parseHeader as p } from '../jsonl-session-store.js';", '從後端拿 parseHeader'],
    ["import { sessionLogPathOf } from '../jsonl-session-store.ts';", '從後端拿 sessionLogPathOf'],
    ["export { parseHeader } from './jsonl-session-store.js';", '從後端拿 parseHeader'],
    ['store.parseHeader(text);', '從後端拿 parseHeader'],
    ["const { parseHeader } = await import('./jsonl-session-store.js');", '從後端拿 parseHeader'],
  ])('%s', (text, what) => {
    expect(at(text)).toEqual([what]);
  });

  it('不相干的寫法不算', () => {
    expect(at("import { projectKey, readSessionEntry } from './jsonl-session-store.js';")).toEqual(
      [],
    );
    // 網頁 trace 面板自己的同名函式（`apps/web/src/components/trace/call.tsx`）。
    expect(at('function parseHeader(json) { return json; }\nparseHeader(x);')).toEqual([]);
    expect(
      at("const a = 'cli.jsonl 不在這裡'; const b = 'x.json'; const c = 'a.jsonl.lock';"),
    ).toEqual([]);
  });

  it('判的是匯入來源，不是識別字：從別的模組匯入同名的 parseHeader 不算', () => {
    expect(at("import { parseHeader } from './other.js';")).toEqual([]);
    expect(at("export { sessionLogPathOf } from '../trace/call.js';")).toEqual([]);
  });

  it('只出現在註解裡的不算', () => {
    expect(at('// 讀 cli.jsonl 與 cli.header.json\nconst x = 1;')).toEqual([]);
    expect(at('/** `<base>.header.json`、`<base>.jsonl` */\nexport const x = 1;')).toEqual([]);
  });

  it('豁免：同一行或上一行的註解寫明理由才算', () => {
    expect(at("// session-file-exempt: 結果檔，不是會話\nconst f = 'runs.jsonl';")).toEqual([]);
    expect(at("const f = 'runs.jsonl'; // session-file-exempt: 結果檔，不是會話")).toEqual([]);
    expect(at("/* session-file-exempt: 結果檔 */ const f = 'runs.jsonl';")).toEqual([]);
    expect(at("// session-file-exempt: 上上行\n\nconst f = 'runs.jsonl';")).toEqual([
      '字串以 .jsonl 結尾',
    ]);
  });

  it('豁免記號理由空白：記號本身紅，底下那行也不豁免', () => {
    expect(at("// session-file-exempt:   \nconst f = 'runs.jsonl';")).toEqual([
      '豁免記號沒寫理由',
      '字串以 .jsonl 結尾',
    ]);
    expect(at('/* session-file-exempt: */ const x = 1;')).toEqual(['豁免記號沒寫理由']);
  });

  it('記號寫在字串裡不是豁免', () => {
    expect(at("const s = 'session-file-exempt: 不是註解'; const f = 'runs.jsonl';")).toEqual([
      '字串以 .jsonl 結尾',
    ]);
  });

  it('副檔名：測試與宣告檔不掃，fixture 與 smoke 要掃', () => {
    expect(isSource('a.test.ts')).toBe(false);
    expect(isSource('a.test.tsx')).toBe(false);
    expect(isSource('a.d.ts')).toBe(false);
    expect(isSource('a.fixture.ts')).toBe(true);
    expect(isSource('a.smoke.ts')).toBe(true);
    expect(isSource('a.mjs')).toBe(true);
  });
});

describe('全樹掃描', () => {
  it('擁有者都還在（改了名，這裡跟著改，不然白名單是空的）', () => {
    for (const owner of OWNERS) expect(existsSync(join(REPO_ROOT, owner))).toBe(true);
  });

  it('擁有者以外，沒有自己寫會話檔名、也沒有自己解 header 的位置', () => {
    const found: string[] = [];
    for (const root of SOURCE_ROOTS) {
      for (const file of sourceFiles(join(REPO_ROOT, root))) {
        const path = relative(REPO_ROOT, file);
        if (
          OWNERS.some((owner) => path === owner || (owner.endsWith('/') && path.startsWith(owner)))
        ) {
          continue;
        }
        for (const v of findViolations(path, readFileSync(file, 'utf8'))) {
          found.push(`${v.file}:${String(v.line)} ${v.what}`);
        }
      }
    }
    expect(found).toEqual([]);
  });
});

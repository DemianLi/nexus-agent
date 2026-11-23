// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * 這幾件事只有 harness 那一側做，web 不准做：每一條掃 web 自己的原始碼，一個都不准有。harness 的測試不讀 web 的原始碼
 * （兩邊要能拆成兩個倉庫，[#3147](https://github.com/DemianLi/nexus-agent/issues/3147)），所以這一半護欄放在 web。
 */

const SRC = fileURLToPath(new URL('.', import.meta.url));

interface Source {
  readonly path: string;
  readonly text: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'dist') walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

const ALL_FILES: readonly Source[] = walk(SRC)
  .filter((file) => /\.(tsx?|mts|cts|[cm]?js)$/u.test(file) && !/\.d\.[cm]?ts$/u.test(file))
  .map((file) => ({
    path: `apps/web/src/${relative(SRC, file).split(sep).join('/')}`,
    text: readFileSync(file, 'utf8'),
  }));

const isTest = (path: string): boolean => /\.test\.([cm]?[jt]sx?)$/u.test(path);
const isFixture = (path: string): boolean => path.endsWith('.fixture.ts');
const productFiles = ALL_FILES.filter(
  (file) => /\.tsx?$/u.test(file.path) && !isTest(file.path) && !isFixture(file.path),
);

function sourceOf(text: string, path = 'x.ts'): ts.SourceFile {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
}

const lineOf = (file: ts.SourceFile, node: ts.Node): number =>
  file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;

function codeLinesMatching(text: string, pattern: RegExp): string[] {
  const found: string[] = [];
  for (const line of text.split('\n')) {
    const code = line.trim();
    if (code.startsWith('*') || code.startsWith('//') || code.startsWith('/*')) continue;
    if (pattern.test(code)) found.push(code);
  }
  return found;
}

export function saverConstructions(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => /new\s+\w*Saver\s*\(/u.test(line))
    .map((line) => line.trim());
}

export function errorPrefixViolations(text: string): string[] {
  return [
    ...codeLinesMatching(text, /status:\s*['"]error['"]/u),
    ...codeLinesMatching(text, /['"`]Error: /u),
    ...codeLinesMatching(text, /\b(?:toolFeedback|errorResultFields)\(/u),
  ];
}

export function dispatcherViolations(text: string): string[] {
  if (!/undici|dispatcher/u.test(text)) return [];
  const file = sourceOf(text);
  const found: string[] = [];
  const isUndici = (specifier: string): boolean =>
    specifier === 'undici' || specifier.startsWith('undici/');
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      isUndici(node.moduleSpecifier.text)
    ) {
      found.push(`${String(lineOf(file, node))} 匯入 undici`);
    } else if (ts.isCallExpression(node)) {
      const [first] = node.arguments;
      const callee = node.expression;
      const dynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const requireCall = ts.isIdentifier(callee) && callee.text === 'require';
      if (
        (dynamicImport || requireCall) &&
        first !== undefined &&
        ts.isStringLiteralLike(first) &&
        isUndici(first.text)
      ) {
        found.push(
          `${String(lineOf(file, node))} ${dynamicImport ? '動態匯入' : 'require'} undici`,
        );
      }
    } else if (
      (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'dispatcher'
    ) {
      found.push(`${String(lineOf(file, node))} 替請求指定 dispatcher`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

const STORE_ONLY = new Set(['parseHeader', 'sessionLogPathOf']);
const isStore = (specifier: string): boolean =>
  /(^|\/)jsonl-session-store(\.[cm]?[jt]s)?$/u.test(specifier);

export function sessionFileViolations(text: string): string[] {
  if (!/jsonl|header\\?\.json|parseHeader|sessionLogPathOf/u.test(text)) return [];
  const file = sourceOf(text);
  const found: string[] = [];
  const add = (node: ts.Node, what: string): void => {
    found.push(`${String(lineOf(file, node))} ${what}`);
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
      if (ts.isExportDeclaration(node) && node.exportClause === undefined) {
        add(node, '整包轉出後端');
        return;
      }
      const bindings = ts.isImportDeclaration(node)
        ? node.importClause?.namedBindings
        : node.exportClause;
      if (bindings !== undefined && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings))) {
        for (const element of bindings.elements) {
          const name = (element.propertyName ?? element.name).text;
          if (STORE_ONLY.has(name)) add(element, `從後端拿 ${name}`);
        }
      }
      return;
    } else if (ts.isPropertyAccessExpression(node) && STORE_ONLY.has(node.name.text)) {
      add(node.name, `從後端拿 ${node.name.text}`);
    } else if (ts.isBindingElement(node)) {
      const name = node.propertyName ?? node.name;
      if (ts.isIdentifier(name) && STORE_ONLY.has(name.text)) add(name, `從後端拿 ${name.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

export function beforeAgentViolations(text: string): string[] {
  return /\bbeforeAgent\s*:/u.test(text) ? ['beforeAgent:'] : [];
}

export function eventMapViolations(text: string): string[] {
  if (!/SessionEventMap|declare\s+module/u.test(text)) return [];
  const file = sourceOf(text);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === 'SessionEventMap') {
      found.push(`${String(lineOf(file, node))} 宣告 SessionEventMap`);
    } else if (
      ts.isModuleDeclaration(node) &&
      ts.isStringLiteral(node.name) &&
      node.name.text === '@nexus/core'
    ) {
      found.push(`${String(lineOf(file, node))} declare module '@nexus/core'`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

describe('量具自檢：每一種寫法都抓得到，註解與不相干的寫法不算', () => {
  it('門 B：建構 checkpointer', () => {
    expect(saverConstructions('const s = new MemorySaver();')).toHaveLength(1);
    expect(saverConstructions('const s = new SqliteSaver ( path );')).toHaveLength(1);
    expect(saverConstructions('const s = createSaver();')).toEqual([]);
  });

  it.each([
    ["const r = { status: 'error', content };"],
    ['const t = "Error: " + reason;'],
    ['const t = `Error: ${reason}`;'],
    ['const m = toolFeedback(text, options);'],
    ['const f = errorResultFields(text, options);'],
  ])('Error: 前綴：%s', (text) => {
    expect(errorPrefixViolations(text)).toHaveLength(1);
  });

  it('Error: 前綴：註解行與不相干的寫法不算', () => {
    expect(
      errorPrefixViolations("// status: 'error' 與 'Error: ' 只在註解裡\nconst x = 1;"),
    ).toEqual([]);
    expect(errorPrefixViolations(' * 手寫 `toolFeedback(` 的說明')).toEqual([]);
    expect(errorPrefixViolations("const x = { status: 'done' };")).toEqual([]);
  });

  it.each([
    ["import { Agent } from 'undici';", '匯入 undici'],
    ["import type { Dispatcher } from 'undici';", '匯入 undici'],
    ["export { fetch } from 'undici';", '匯入 undici'],
    ["const u = await import('undici');", '動態匯入 undici'],
    ["const u = require('undici');", 'require undici'],
    ["import { x } from 'undici/types/x';", '匯入 undici'],
    ['await fetch(url, { dispatcher: agent });', '替請求指定 dispatcher'],
    ['await fetch(url, { dispatcher });', '替請求指定 dispatcher'],
  ])('dispatcher：%s', (text, what) => {
    expect(dispatcherViolations(text).map((v) => v.replace(/^\d+ /u, ''))).toEqual([what]);
  });

  it('dispatcher：不相干的寫法不算', () => {
    expect(dispatcherViolations("import { x } from 'undici-types';")).toEqual([]);
    expect(dispatcherViolations('const agent = new Agent();')).toEqual([]);
  });

  it.each([
    ["const f = 'runs.jsonl';", '字串以 .jsonl 結尾'],
    ['const f = `${id}.jsonl`;', '字串以 .jsonl 結尾'],
    ["const h = 'cli.header.json';", '字串裡有 header.json'],
    ['const ok = /cli\\.jsonl$/.test(name);', 'regex 認會話檔名'],
    ["import { parseHeader } from './jsonl-session-store.js';", '從後端拿 parseHeader'],
    ["export { sessionLogPathOf } from '../jsonl-session-store.ts';", '從後端拿 sessionLogPathOf'],
    ['store.parseHeader(text);', '從後端拿 parseHeader'],
    ["const { parseHeader } = await import('./jsonl-session-store.js');", '從後端拿 parseHeader'],
    ["export * from './jsonl-session-store.js';", '整包轉出後端'],
  ])('會話檔：%s', (text, what) => {
    expect(sessionFileViolations(text).map((v) => v.replace(/^\d+ /u, ''))).toEqual([what]);
  });

  it('會話檔：只在註解裡的、不相干的、同名但來源不同的不算', () => {
    expect(sessionFileViolations('// 讀 cli.jsonl 與 cli.header.json\nconst x = 1;')).toEqual([]);
    expect(sessionFileViolations("const a = 'a.jsonl.lock'; const b = 'x.json';")).toEqual([]);
    expect(sessionFileViolations("import { parseHeader } from './other.js';")).toEqual([]);
    expect(
      sessionFileViolations('function parseHeader(json) { return json; }\nparseHeader(x);'),
    ).toEqual([]);
  });

  it('beforeAgent：', () => {
    expect(beforeAgentViolations('const m = { beforeAgent: () => undefined };')).toHaveLength(1);
    expect(beforeAgentViolations('const m = { beforeModel: () => undefined };')).toEqual([]);
  });

  it('SessionEventMap：頂層與模組補充都抓，不相干的不算', () => {
    expect(eventMapViolations("export interface SessionEventMap { 'a/b': number }")).toHaveLength(
      1,
    );
    expect(
      eventMapViolations(
        "declare module '@nexus/core' { interface SessionEventMap { 'a/b': number } }",
      ),
    ).toHaveLength(2);
    expect(eventMapViolations("declare module './other' { interface Other {} }")).toEqual([]);
    expect(eventMapViolations('// SessionEventMap 只在註解裡\nconst x = 1;')).toEqual([]);
  });
});

describe('全樹掃描：這些事只有 harness 那一側做，web 一個都沒有', () => {
  it('掃得到檔案（掃描沒壞）', () => {
    expect(productFiles.length).toBeGreaterThan(100);
    expect(ALL_FILES.some((file) => isTest(file.path))).toBe(true);
  });

  const scan = (files: readonly Source[], rule: (text: string) => string[]): string[] =>
    files.flatMap((file) => rule(file.text).map((hit) => `${file.path}: ${hit}`));

  it('沒有建構 checkpointer（只掃 `.ts` 產品碼）', () => {
    expect(
      scan(
        productFiles.filter((file) => file.path.endsWith('.ts')),
        saverConstructions,
      ),
    ).toEqual([]);
  });

  it('沒有手寫 error 狀態、`Error: ` 字串，也不走不帶前綴的那條路', () => {
    expect(scan(productFiles, errorPrefixViolations)).toEqual([]);
  });

  it('沒有匯入 undici、沒有替請求指定 dispatcher（測試也掃）', () => {
    expect(
      scan(
        ALL_FILES.filter((file) => /\.tsx?$/u.test(file.path)),
        dispatcherViolations,
      ),
    ).toEqual([]);
  });

  it('沒有自己寫的會話檔名、沒有自己解的 header（產品碼；測試不掃，同原本的範圍）', () => {
    expect(
      scan(
        ALL_FILES.filter((file) => !isTest(file.path)),
        sessionFileViolations,
      ),
    ).toEqual([]);
  });

  it('沒有 `beforeAgent:` 的實作（只掃 `.ts` 產品碼）', () => {
    expect(
      scan(
        productFiles.filter((file) => file.path.endsWith('.ts')),
        beforeAgentViolations,
      ),
    ).toEqual([]);
  });

  it('沒有宣告 SessionEventMap、沒有補 `@nexus/core` 的型別', () => {
    expect(scan(productFiles, eventMapViolations)).toEqual([]);
  });
});

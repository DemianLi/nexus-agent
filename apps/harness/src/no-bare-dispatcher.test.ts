/**
 * **代理模組以外，沒人自己碰 undici、也沒人替請求指定 `dispatcher`**
 * （[#746](https://github.com/DemianLi/nexus-agent/issues/746)，照 dsh 的 `scripts/verify-no-bare-dispatcher.ts`，`477b4f4`）。
 *
 * Node 內建的 `fetch` 走 undici 的全域派送器，而代理就是裝在那個位置上。請求上另外指定的 `dispatcher`
 * 會蓋掉全域那一個，於是這個呼叫點不管使用者設了什麼代理都直連；自己 `new Agent(...)` 也一樣。
 * dsh 的網頁抓取工具曾經就是這樣繞過了所有代理。
 *
 * ## 與 dsh 的差異
 *
 * - dsh 比的是 `Agent`／`ProxyAgent`／`EnvHttpProxyAgent` 這幾個類別的建構。這裡**比匯入**：代理模組以外
 *   任何 `undici` 的匯入（靜態、動態、`require` 三種寫法）都算。理由是我們的樹上到處是 `createCliAgent` 這類名字，
 *   而不匯入 undici 就建不出它的 agent，所以匯入是更早、更不會被改名繞過的那一道。
 * - 另外照 dsh 擋 `dispatcher` 這個屬性（物件字面值的一般寫法與簡寫）。
 * - 逃生口同 dsh：緊貼在上一行或同一行的註解帶 `proxy-exempt:` 並寫明理由。今天沒有任何使用者。
 * - 用 TypeScript 的語法樹掃，不用逐行正則：簡寫 `{ dispatcher }` 與改名的匯入，正則都會漏。
 *
 * **掃測試檔**：測試自己建一個直連 agent 去打 `fetch`，量到的就不是代理了。
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** 擁有派送器的模組；它自己的 agent 就是實作。 */
const DISPATCHER_OWNER = 'packages/nexus-core/src/http-proxy/';

/** 註解帶這個記號並寫明理由，該位置豁免。 */
const ALLOW_MARKER = 'proxy-exempt:';

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly what: string;
}

/**
 * 找出一份原始碼裡會繞過代理的位置。
 *
 * @param file - 顯示在結果裡的路徑。
 * @param text - 原始碼。
 */
export function findViolations(file: string, text: string): Violation[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const lines = text.split('\n');
  const found: Violation[] = [];
  const exempt = (line: number): boolean =>
    [line, line - 1].some((index) => (lines[index] ?? '').includes(ALLOW_MARKER));
  const add = (node: ts.Node, what: string): void => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
    if (!exempt(line)) found.push({ file, line: line + 1, what });
  };
  const isUndici = (specifier: string): boolean =>
    specifier === 'undici' || specifier.startsWith('undici/');
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      isUndici(node.moduleSpecifier.text)
    ) {
      add(node, '匯入 undici');
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
        add(node, dynamicImport ? '動態匯入 undici' : 'require undici');
      }
    } else if (
      (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'dispatcher'
    ) {
      add(node, '替請求指定 dispatcher');
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** 遞迴列出 `.ts`／`.tsx`，跳過相依與建置產物。 */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/u.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe('量具自檢：每一種寫法都抓得到，逃生口與擁有者不算', () => {
  const at = (text: string) => findViolations('x.ts', text).map((v) => v.what);

  it.each([
    ["import { Agent } from 'undici';", '匯入 undici'],
    ["import * as u from 'undici';", '匯入 undici'],
    ["import type { Dispatcher } from 'undici';", '匯入 undici'],
    ["export { fetch } from 'undici';", '匯入 undici'],
    ["const u = await import('undici');", '動態匯入 undici'],
    ["const { Agent: A } = await import('undici');", '動態匯入 undici'],
    ["const u = require('undici');", 'require undici'],
    ["import { x } from 'undici/types/x';", '匯入 undici'],
    ['await fetch(url, { dispatcher: agent });', '替請求指定 dispatcher'],
    ['await fetch(url, { dispatcher });', '替請求指定 dispatcher'],
  ])('%s', (text, what) => {
    expect(at(text)).toEqual([what]);
  });

  it('不相干的寫法不算', () => {
    expect(at("import { createCliAgent } from './cli.js'; const agent = new Agent();")).toEqual([]);
    expect(at("import { x } from 'undici-types';")).toEqual([]);
  });

  it('逃生口：同一行或上一行的 proxy-exempt 註解寫明理由就豁免', () => {
    expect(at("// proxy-exempt: 自己綁位址\nimport { Agent } from 'undici';")).toEqual([]);
    expect(at("import { Agent } from 'undici'; // proxy-exempt: 自己綁位址")).toEqual([]);
    expect(at("// proxy-exempt: 上上行\n\nimport { Agent } from 'undici';")).toEqual([
      '匯入 undici',
    ]);
  });
});

/**
 * 掃哪些原始碼。**`'apps/web/src'` 要寫成字面值出現在這裡**：`.github/scripts/plan_ci.py` 靠檔案裡有這串字面值，
 * 才把它認成「掃整個樹的絆索」而在選擇性測試時也必跑；換成別的寫法，只改 web 的 PR 就跑不到這一道。
 */
const SOURCE_ROOTS = ['apps/harness/src', 'apps/web/src', 'packages'] as const;

describe('全樹掃描', () => {
  it('代理模組以外，沒有任何匯入 undici 或指定 dispatcher 的位置', () => {
    const found: string[] = [];
    for (const root of SOURCE_ROOTS) {
      for (const file of sourceFiles(join(REPO_ROOT, root))) {
        const path = relative(REPO_ROOT, file);
        if (path.startsWith(DISPATCHER_OWNER)) continue;
        for (const v of findViolations(path, readFileSync(file, 'utf8'))) {
          found.push(`${v.file}:${String(v.line)} ${v.what}`);
        }
      }
    }
    expect(found).toEqual([]);
  });
});

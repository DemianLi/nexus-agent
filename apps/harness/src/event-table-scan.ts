/**
 * 掃事件表：整棵樹所有宣告在 `Events` interface 上的成員（[#1217](https://github.com/DemianLi/nexus-agent/issues/1217)）。
 *
 * 事件表是 `@nexus/core` 的 `events.ts` 裡那個空 interface，各套件靠 declaration merging 擴充。「每個事件要有 JSDoc、
 * 標 `@mode`、參數有說明」是 dsh 的規矩（`AGENTS.md`，並有閘門檢查）；這個檔案是我們這側的掃描器，
 * `event-table.test.ts` 拿它當閘門，`interception-index.test.ts` 拿它驗「現在由哪個事件佔住」寫的名字真的存在。
 *
 * **只掃產品碼**（排除 `*.test.ts`）：測試為了驗機制而宣告的 `test/*` 事件不是事件表的一部分。
 *
 * **名字假設**：整棵樹裡任何叫 `Events` 的 interface 都被當成事件表。今天沒有同名的別的東西；哪天（例如 `apps/web`）出現無關的同名
 * interface，這裡會誤報，到時候要把掃描限制在 `@nexus/core` 的宣告與它的 `declare module` 區塊。
 *
 * 掃描看**語法**不看型別：`interface Events` 出現在兩種地方——`events.ts` 自己的宣告，與 `declare module '…' { interface Events {…} }`
 * 區塊。兩者都算。
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

/** 允許的派發方式。`bail`、`parallel` 不做（見 `events.ts` 檔頭）。 */
export const EVENT_MODES = ['emit', 'serial', 'waterfall'] as const;

/** 事件表裡的一個成員，與它不合規矩的地方。 */
export interface DeclaredEvent {
  /** 事件名。 */
  readonly name: string;
  /** 宣告它的檔案，repo 相對路徑。 */
  readonly file: string;
  /** `@mode` 標的值（沒標是 `undefined`）。 */
  readonly mode: string | undefined;
  /** 這個成員違反的規矩，每條一句話。空陣列＝合規。 */
  readonly problems: readonly string[];
}

function isEventsInterface(node: ts.Node): node is ts.InterfaceDeclaration {
  return ts.isInterfaceDeclaration(node) && node.name.text === 'Events';
}

function tagText(tag: ts.JSDocTag): string {
  return ts.getTextOfJSDocComment(tag.comment)?.trim() ?? '';
}

function checkMember(
  member: ts.TypeElement,
  file: string,
  sf: ts.SourceFile,
): DeclaredEvent | undefined {
  if (!ts.isMethodSignature(member) && !ts.isPropertySignature(member)) return undefined;
  const nameNode = member.name;
  const name =
    ts.isStringLiteral(nameNode) || ts.isIdentifier(nameNode)
      ? nameNode.text
      : nameNode.getText(sf);
  const problems: string[] = [];
  const docs = ts.getJSDocCommentsAndTags(member).filter(ts.isJSDoc);
  const tags = docs.flatMap((doc) => doc.tags ?? []);
  const description = docs
    .map((doc) => ts.getTextOfJSDocComment(doc.comment)?.trim() ?? '')
    .join('');
  if (docs.length === 0) problems.push('沒有 JSDoc');
  else if (description === '') problems.push('JSDoc 沒有說明文字');
  const modeTag = tags.find((tag) => tag.tagName.text === 'mode');
  const mode = modeTag === undefined ? undefined : tagText(modeTag);
  if (modeTag === undefined) problems.push('沒標 `@mode`');
  else if (!(EVENT_MODES as readonly string[]).includes(mode ?? '')) {
    problems.push(`\`@mode ${mode ?? ''}\` 不在 ${EVENT_MODES.join('／')} 裡`);
  }
  if (ts.isMethodSignature(member)) {
    const documented = new Set(
      tags.filter(ts.isJSDocParameterTag).map((tag) => tag.name.getText(sf)),
    );
    for (const parameter of member.parameters) {
      const parameterName = parameter.name.getText(sf);
      if (!documented.has(parameterName))
        problems.push(`參數 \`${parameterName}\` 沒有 \`@param\``);
    }
    if (mode === 'waterfall') {
      const last = member.parameters.at(-1);
      if (last === undefined || last.name.getText(sf) !== 'next') {
        problems.push('`@mode waterfall` 的最後一個參數必須叫 `next`（最內層的內建行為）');
      }
    }
  } else {
    problems.push("事件要宣告成方法簽名 `'name'(args): R`，不是屬性");
  }
  return { name, file, mode, problems };
}

/**
 * 掃一份原始碼裡所有 `Events` interface 的成員。
 *
 * @param file - 檔名（報告用）。
 * @param text - 原始碼。
 * @returns 每個成員與它的違規。
 */
export function scanEventTable(file: string, text: string): DeclaredEvent[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: DeclaredEvent[] = [];
  const visit = (node: ts.Node): void => {
    if (isEventsInterface(node)) {
      for (const member of node.members) {
        const declared = checkMember(member, file, sf);
        if (declared !== undefined) found.push(declared);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (
      /\.(ts|tsx)$/.test(entry.name) &&
      !/\.test\.tsx?$/.test(entry.name) &&
      !entry.name.endsWith('.d.ts')
    ) {
      out.push(path);
    }
  }
}

function productFiles(root: string): string[] {
  const files: string[] = [];
  for (const group of ['packages', 'apps']) {
    for (const pkg of readdirSync(join(root, group), { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue;
      const src = join(root, group, pkg.name, 'src');
      try {
        walk(src, files);
      } catch {
        // 沒有 src 的套件不在掃描範圍。
      }
    }
  }
  return files;
}

/**
 * 掃整棵樹的產品碼：`packages/*\/src` 與 `apps/*\/src`。
 *
 * @param root - repo 根。
 * @returns 所有宣告在事件表上的成員。
 */
export function scanEventTableTree(root: string): DeclaredEvent[] {
  return productFiles(root).flatMap((path) =>
    scanEventTable(relative(root, path), readFileSync(path, 'utf8')),
  );
}

/** 派發面的四個方法；第一個參數是事件名。 */
const DISPATCH_METHODS = new Set(['emit', 'serial', 'waterfall', 'observe']);

/**
 * 掃一份原始碼裡的**生產者**：`<任何>.emit|serial|waterfall|observe('事件名', …)` 的呼叫。
 *
 * 看語法不看型別，所以只認事件名是**字串字面量**的呼叫。`observe` 的第一個參數也是事件名（第二個才是 `onError`）。
 *
 * @param text - 原始碼。
 * @returns 派發到的事件名（可重複）。
 */
export function scanEventProducers(text: string): string[] {
  const sf = ts.createSourceFile('probe.ts', text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      DISPATCH_METHODS.has(node.expression.name.text)
    ) {
      const first = node.arguments[0];
      if (first !== undefined && ts.isStringLiteralLike(first)) found.push(first.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/**
 * 整棵樹產品碼裡每個事件名有哪些檔案派發它（排除測試）。
 *
 * @param root - repo 根。
 * @returns 事件名 → 派發它的檔案（repo 相對路徑）。
 */
export function scanEventProducersTree(root: string): Map<string, string[]> {
  const producers = new Map<string, string[]>();
  for (const path of productFiles(root)) {
    for (const name of new Set(scanEventProducers(readFileSync(path, 'utf8')))) {
      producers.set(name, [...(producers.get(name) ?? []), relative(root, path)]);
    }
  }
  return producers;
}

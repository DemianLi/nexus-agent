import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

/**
 * 掃 JSX 屬性的護欄共用的量具（`styles/type-hierarchy.test.ts`、`styles/live-region.test.ts`）。
 *
 * 掃語法樹，不用 regex：開頭標籤常常跨行，class 字串裡有 `has-[>svg]`，props 裡有 `=>`，掃到 `>` 為止會漏也會誤抓。
 * 呼叫端先用字串預篩，只 parse 可能命中的檔，不 parse 整棵樹。
 */

/** `dir` 底下所有元件檔（`.tsx`，不含測試）。 */
export function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsxFiles(path);
    return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [path] : [];
  });
}

/** 一個屬性值裡所有字串字面值的文字（含 `cn(...)` 的參數、樣板字串的固定段、三元的兩邊）。 */
export function literalText(node: ts.Node): string[] {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isTemplateExpression(node)) {
    return [
      node.head.text,
      ...node.templateSpans.flatMap((span) => [...literalText(span.expression), span.literal.text]),
    ];
  }
  const out: string[] = [];
  node.forEachChild((child) => {
    out.push(...literalText(child));
  });
  return out;
}

export interface JsxAttribute {
  /** 元素名，例如 `Button`、`p`。 */
  readonly tag: string;
  /** 屬性所在的行（從 1 起算）。 */
  readonly line: number;
  /** 屬性值裡的字串字面值（見 {@link literalText}）。 */
  readonly texts: readonly string[];
}

/** 原始碼裡每個 JSX 元素上名叫 `name` 的屬性。只看元素自己的屬性，子元素各算各的。 */
export function jsxAttributes(file: string, source: string, name: string): JsxAttribute[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: JsxAttribute[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      for (const attr of node.attributes.properties) {
        if (!ts.isJsxAttribute(attr) || attr.name.getText(sf) !== name) continue;
        if (attr.initializer === undefined) continue;
        const { line } = sf.getLineAndCharacterOfPosition(attr.getStart(sf));
        found.push({
          tag: node.tagName.getText(sf),
          line: line + 1,
          texts: literalText(attr.initializer),
        });
      }
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return found;
}

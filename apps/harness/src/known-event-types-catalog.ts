/**
 * 從原始碼掃出「這個 repo 寫得出來的每一種會話事件」，生成 `@nexus/core` 的 `known-event-types.ts`
 * （[#679](https://github.com/DemianLi/nexus-agent/issues/679) 第 4 步、[#507](https://github.com/DemianLi/nexus-agent/issues/507)）。
 *
 * 照 dsh 的 `scripts/gen-persistence-catalog.ts` 與 `scripts/persistence-catalog-source.ts`（`5badb15`）：掃過每一處
 * `SessionEventMap` 的宣告（核心那一份本體，加上各套件的 `declare module '@nexus/core'` 區塊），用 TypeScript 的
 * 語法樹讀，不用正則；生成的集合是日誌讀方判斷「不認得又沒標 `ignorable` 就拒絕」的唯一依據。**不讓各 plugin 在執行期
 * 登記**：登記只說「有這個名字」，說不出略過它安不安全，而且會讓同一份日誌在不同組裝下讀出不同結果（dsh 的
 * `2026-08-10-session-log-version-mechanism.md`，Alternatives considered）。
 *
 * ## 掃什麼、不掃什麼
 *
 * - **掃** `packages/<pkg>/src` 與 `apps/<app>/src` 底下的 `.ts`／`.tsx`，**排除** `*.test.ts(x)` 與 `*.fixture.ts`：
 *   測試專用的擴充不能讓產品讀方認得一個只有測試會寫的種類。
 * - **核心那一份本體**（頂層的 `interface SessionEventMap`）只能在 `@nexus/core` 的一個檔裡出現一次；別的套件要補種類，走
 *   `declare module '@nexus/core'`。
 * - 每個成員必須是帶明確酬載型別、名字是字串字面量的屬性簽名；宣告不能 `extends`（繼承來的鍵會不經任何一列就進
 *   `keyof SessionEventMap`）；同一個種類只能宣告一次。違反的一律回報成 {@link CatalogViolation}，不靜靜略過。
 *
 * @module
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

/** 核心套件名：頂層的 `SessionEventMap` 本體只能住在這裡。 */
const CORE_MODULE = '@nexus/core';

/** 一個掃出來的事件種類，連同宣告它的位置。 */
export interface CatalogEvent {
  /** `scope/name` 形式的種類，例如 `todo/write`。 */
  readonly name: string;
  /** 宣告所在，`相對路徑:行號`。 */
  readonly source: string;
}

/** 一條違反宣告規則的地方：訊息已經講明哪個檔、哪一行、該怎麼改。 */
export type CatalogViolation = string;

/** {@link collectSessionEventTypes} 的結果。 */
export interface CatalogScan {
  readonly events: readonly CatalogEvent[];
  readonly violations: readonly CatalogViolation[];
}

/** 掃描時略過的目錄。 */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules',
  'lib',
  'dist',
  'coverage',
]);

/** 產品原始碼：`.ts`／`.tsx`，不是測試、不是夾具、不是宣告檔。 */
function isProductSource(path: string): boolean {
  return (
    /\.(ts|tsx)$/u.test(path) &&
    !/\.(test|spec|fixture)\.(ts|tsx)$/u.test(path) &&
    !path.endsWith('.d.ts')
  );
}

/** 一個目錄底下的每個產品原始碼檔（遞迴），排序過，路徑用 `/` 分隔。 */
function productFilesUnder(root: string, directory: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(join(current, entry.name));
      } else if (isProductSource(entry.name)) {
        found.push(relative(root, join(current, entry.name)).split(sep).join('/'));
      }
    }
  };
  walk(join(root, directory));
  return found.sort();
}

/** 這一個原始檔裡每一處 `SessionEventMap` 的宣告，標明是頂層本體還是 `declare module '@nexus/core'` 裡的補充。 */
function eventMapDeclarations(
  file: ts.SourceFile,
): { readonly declaration: ts.InterfaceDeclaration; readonly topLevel: boolean }[] {
  const found: { declaration: ts.InterfaceDeclaration; topLevel: boolean }[] = [];
  for (const statement of file.statements) {
    if (ts.isInterfaceDeclaration(statement) && statement.name.text === 'SessionEventMap') {
      found.push({ declaration: statement, topLevel: true });
    } else if (
      ts.isModuleDeclaration(statement) &&
      ts.isStringLiteral(statement.name) &&
      statement.name.text === CORE_MODULE &&
      statement.body !== undefined &&
      ts.isModuleBlock(statement.body)
    ) {
      for (const inner of statement.body.statements) {
        if (ts.isInterfaceDeclaration(inner) && inner.name.text === 'SessionEventMap') {
          found.push({ declaration: inner, topLevel: false });
        }
      }
    }
  }
  return found;
}

/**
 * 掃 `roots` 底下的每個產品原始碼檔，收集 `SessionEventMap` 宣告的每一種事件。
 *
 * @param repoRoot - repo 根的絕對路徑；回報的位置都相對於它。
 * @param roots - 要掃的目錄（相對於 `repoRoot`），例如 `packages`、`apps/harness/src`、`apps/web/src`。**web 也在內**：
 *   它本來就不該宣告事件，列進來才擋得住有人在那裡補。
 */
export function collectSessionEventTypes(repoRoot: string, roots: readonly string[]): CatalogScan {
  const events: CatalogEvent[] = [];
  const violations: CatalogViolation[] = [];
  const seen = new Map<string, string>();
  let ownerDeclaration: string | undefined;
  for (const root of roots) {
    for (const path of productFilesUnder(repoRoot, root)) {
      const text = readFileSync(join(repoRoot, path), 'utf8');
      if (!text.includes('SessionEventMap')) continue;
      const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
      const where = (node: ts.Node): string =>
        `${path}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`;
      for (const { declaration, topLevel } of eventMapDeclarations(file)) {
        const here = where(declaration);
        if (topLevel) {
          const exported =
            declaration.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
          if (!/^packages\/nexus-core\/src\//u.test(path)) {
            violations.push(
              `頂層的 interface SessionEventMap（${here}）不在 ${CORE_MODULE} 裡。改個名字，或改用 declare module '${CORE_MODULE}' 補種類。`,
            );
            continue;
          }
          if (!exported) {
            violations.push(`頂層的 interface SessionEventMap（${here}）沒有 export。`);
            continue;
          }
          if (ownerDeclaration !== undefined) {
            violations.push(
              `頂層的 interface SessionEventMap（${here}）已經在 ${ownerDeclaration} 宣告過，本體只有一個家。`,
            );
            continue;
          }
          ownerDeclaration = here;
        }
        if (declaration.heritageClauses?.length) {
          violations.push(
            `SessionEventMap 的宣告（${here}）用了 extends：繼承來的鍵會不經任何一列就進 keyof SessionEventMap，成員要直接宣告。`,
          );
        }
        for (const member of declaration.members) {
          const at = where(member);
          if (!ts.isPropertySignature(member) || member.type === undefined) {
            violations.push(
              `SessionEventMap 的成員（${at}）不是帶明確酬載型別的屬性簽名；每個事件寫成 'scope/name': <酬載>。`,
            );
            continue;
          }
          if (!ts.isStringLiteral(member.name)) {
            violations.push(`事件（${at}）的名字不是字串字面量。`);
            continue;
          }
          const name = member.name.text;
          const prior = seen.get(name);
          if (prior !== undefined) {
            violations.push(
              `事件 '${name}'（${at}）已經在 ${prior} 宣告過，一種事件只有一處宣告。`,
            );
            continue;
          }
          seen.set(name, at);
          events.push({ name, source: at });
        }
      }
    }
  }
  if (ownerDeclaration === undefined) {
    violations.push(
      `找不到 ${CORE_MODULE} 的頂層 interface SessionEventMap；掃描的根是 ${roots.join('、')}。`,
    );
  }
  return { events, violations };
}

/** 預設要掃的目錄（相對於 repo 根）。web 也在內：它不該宣告事件，列進來才擋得住有人在那裡補。 */
export const EVENT_CATALOG_ROOTS: readonly string[] = [
  'packages',
  'apps/harness/src',
  'apps/web/src',
];

/** 生成檔的位置，相對於 repo 根。 */
export const KNOWN_EVENT_TYPES_PATH = 'packages/nexus-core/src/known-event-types.ts';

/** 重新生成的指令：新鮮度測試失敗時印出來。 */
export const KNOWN_EVENT_TYPES_REGENERATE =
  'pnpm --filter @nexus/harness run gen-known-event-types';

/**
 * 生成檔的全文。**純函式**：同樣的種類清單永遠得到同樣的字串（排序、去重），新鮮度測試比的是字串。
 *
 * @param names - 掃出來的事件種類。
 */
export function renderKnownEventTypes(names: readonly string[]): string {
  const sorted = [...new Set(names)].sort();
  return [
    '/**',
    ' * GENERATED by `apps/harness/src/gen-known-event-types.ts` — 不要手改；執行',
    ` * \`${KNOWN_EVENT_TYPES_REGENERATE}\` 重新生成（\`apps/harness/src/known-event-types.test.ts\` 驗它沒過期）。`,
    ' *',
    ' * 這個 repo 的套件寫得出來的每一種會話事件：核心的 `SessionEventMap` 加上各套件用 `declare module',
    " * '@nexus/core'` 補的。日誌讀方碰到表外的種類、又沒標 `ignorable` 就拒絕重建（#507，`session-log.ts` 的",
    ' * `isUnreadableSessionEvent`）。比這個 repo 更新的程式寫的種類、或別的東西寫的，自然在表外。',
    ' *',
    ' * @module',
    ' */',
    '',
    '/** 這一版認得的事件種類。 */',
    'export const KNOWN_SESSION_EVENT_TYPES: ReadonlySet<string> = new Set([',
    ...sorted.map((name) => `  ${JSON.stringify(name).replace(/"/gu, "'")},`),
    ']);',
    '',
  ].join('\n');
}

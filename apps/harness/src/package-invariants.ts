/**
 * 配套入口的**結構規則**：誰該有、長什麼樣、接線接完了沒有。
 *
 * 這裡一條產品規則都沒有——它不看檢查寫得對不對，只看**機械判得出來**的東西。這一點是抄
 * dsh 的，而且是它明說的自我約束：門禁不從方法名或 helper 呼叫推斷語意品質
 * （`docs/subsystems/invariants.md:59`）。
 *
 * **它存在的理由是「加第十個 package 的人會被擋下來」。** 在這之前守著九個配套入口的只有
 * [`invariant-companions.test.ts`](./invariant-companions.test.ts) 裡那份手寫的九列表格，
 * 而表格不會提醒任何人補第十列。所以底下**發現 owner 的那一段才是主角**，AST 規則是配菜。
 *
 * 對讀日期 2026-08-30，dsh `cd5ef8148158c3a752a658978873241fdf8e2bbc`
 * （`scripts/package-invariants.ts` 與 `scripts/verify-package-invariants.ts`）。
 * 與 dsh 逐條的異同見 [#108](https://github.com/DemianLi/nexus-agent/issues/108)。
 *
 * @module
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

/**
 * 空 installer 必須帶的說明標記。
 *
 * **半形冒號**。九個檔案原本寫的是全形的 `：`，那是無意的不一致，#108 的拍板選了「標記統一
 * 到半形、其餘照我們的約定」，所以動的是原始檔不是這個常數。
 */
const NO_RUNTIME_INVARIANT_MARKER = 'No runtime invariant:';

/**
 * owner 只在 `packages/*` 裡找。
 *
 * `apps/harness` 與 `apps/web` 也是 workspace package，兩個都沒有 `src/invariant.ts`，
 * 掃進來 gate 第一天就是紅的。**這是選的，不是 glob 字串默默決定的**：dsh 的 owner 樹在
 * `packages` 底下**再深一層**，app 本來就不在裡面；而配套入口認領的是「這個 package 擁有的跨筆關係」，
 * 組裝點與前端不擁有任何人的關係——它們是消費者。理由與另外兩個選項見 #108。
 */
const OWNER_ROOT = 'packages';

/** 一個 owner，與它參與規則的那幾個檔案。 */
export interface PackageInvariantOwner {
  /** repo 相對的 package 目錄。 */
  readonly dir: string;
  /** repo 相對的 `package.json`。 */
  readonly manifestPath: string;
  /** repo 相對的配套入口原始檔。 */
  readonly sourcePath: string;
  /** manifest 宣告的 package 名。 */
  readonly packageName: string;
}

/** 一條違規，路徑一律 repo 相對。 */
export interface PackageInvariantViolation {
  readonly path: string;
  readonly message: string;
}

interface PackageManifest {
  name?: string;
  exports?: Record<string, unknown>;
}

/**
 * 找出 repo 根。
 *
 * **找不到就拋，不回退。** 這個模組所有規則都建立在「掃得到全部的 package」上，根算錯的話
 * 底下每一條都會安靜地掃到空的清單，然後回報零違規——一個永遠綠的 gate 比沒有 gate 更糟。
 *
 * @returns repo 根的絕對路徑。
 * @throws 往上找不到 `pnpm-workspace.yaml`，訊息帶著找過的起點。
 */
export function repositoryRoot(): string {
  const start = dirname(fileURLToPath(import.meta.url));
  let current = start;
  for (;;) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current;
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`從 ${start} 往上找不到 pnpm-workspace.yaml，無法決定 repo 根`);
    }
    current = parent;
  }
}

/**
 * 掃出每一個 owner。
 *
 * **這裡不看 `src/invariant.ts` 在不在**——不在也是一個 owner，只是它會在
 * {@link collectPackageInvariantViolations} 裡拿到一條「缺配套入口」。少掃一個 package
 * 與掃到一個壞掉的 package，前者是靜默的，所以發現與判定分開。
 *
 * @param root - repo 根，省略即 {@link repositoryRoot} 的結果。
 * @returns 依目錄名排序的 owner。
 * @throws 某個 `package.json` 沒有 `name`——沒有名字就對不出它該註冊什麼。
 */
export function packageInvariantOwners(root: string = repositoryRoot()): PackageInvariantOwner[] {
  const ownerRoot = resolve(root, OWNER_ROOT);
  return readdirSync(ownerRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${OWNER_ROOT}/${entry.name}`)
    .filter((dir) => existsSync(resolve(root, dir, 'package.json')))
    .sort()
    .map((dir) => {
      const manifestPath = `${dir}/package.json`;
      const manifest = readManifest(resolve(root, manifestPath));
      if (manifest.name === undefined || manifest.name === '') {
        throw new Error(`${manifestPath}：package 必須宣告 name`);
      }
      return {
        dir,
        manifestPath,
        sourcePath: `${dir}/src/invariant.ts`,
        packageName: manifest.name,
      };
    });
}

/**
 * 跑完全部規則。
 *
 * @param root - repo 根，省略即 {@link repositoryRoot} 的結果。
 * @returns 全部違規；空陣列代表通過。
 */
export function collectPackageInvariantViolations(
  root: string = repositoryRoot(),
): PackageInvariantViolation[] {
  const violations: PackageInvariantViolation[] = [];
  for (const owner of packageInvariantOwners(root)) {
    checkManifest(owner, readManifest(resolve(root, owner.manifestPath)), violations);
    checkSource(owner, root, violations);
  }
  return violations;
}

/** 給命令列印的一行。 */
export function formatPackageInvariantViolation(violation: PackageInvariantViolation): string {
  return `${violation.path}: ${violation.message}`;
}

function readManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as PackageManifest;
}

function addViolation(
  violations: PackageInvariantViolation[],
  path: string,
  message: string,
): void {
  violations.push({ path, message });
}

/**
 * manifest 這一側只剩一條。
 *
 * dsh 那邊 `checkManifest` 還檢 `files` 要發布 `lib/invariant.js`、註冊表要同時是
 * `workspace:^` 的 peer 與 dev 相依，`checkBuild` 再檢 bundle entry 與 project references。
 * **那些規則檢的產物在我們這裡不存在**：沒有 `lib/`、沒有 `files`、不發布，`build` 就是
 * `tsc --noEmit`。整組退到「不檢」，偏離標註見 #108 與該張動工的 PR 內文。
 */
function checkManifest(
  owner: PackageInvariantOwner,
  manifest: PackageManifest,
  violations: PackageInvariantViolation[],
): void {
  const expected = './src/invariant.ts';
  if (manifest.exports?.['./invariant'] !== expected) {
    addViolation(
      violations,
      owner.manifestPath,
      `exports["./invariant"] 必須是 ${JSON.stringify(expected)}——沒有它，` +
        `${JSON.stringify(`${owner.packageName}/invariant`)} 這個 specifier 解析不到`,
    );
  }
}

function checkSource(
  owner: PackageInvariantOwner,
  root: string,
  violations: PackageInvariantViolation[],
): void {
  const absolute = resolve(root, owner.sourcePath);
  if (!existsSync(absolute)) {
    addViolation(violations, owner.sourcePath, '缺配套入口——每個 package 都要有一個');
    return;
  }
  const sourceText = readFileSync(absolute, 'utf8');
  if (sourceText.includes('@generated')) {
    addViolation(
      violations,
      owner.sourcePath,
      '配套入口必須是手寫的，不得帶 @generated 標記——生成出來的檢查沒有人在擁有它',
    );
  }

  const sourceFile = ts.createSourceFile(
    absolute,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const constants = topLevelStringConstants(sourceFile);
  const registrations: string[] = [];
  const installerNames: string[] = [];
  const unresolved: number[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isInvariantRegistration(node.expression)) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      const nameArgument = node.arguments[0];
      const packageName =
        nameArgument === undefined ? undefined : stringValue(nameArgument, constants);
      if (packageName === undefined) unresolved.push(line);
      else registrations.push(packageName);

      const installer = node.arguments[1];
      if (installer !== undefined && ts.isIdentifier(installer))
        installerNames.push(installer.text);
      else {
        addViolation(
          violations,
          owner.sourcePath,
          `第 ${line} 行：register 的第二個引數必須是本檔宣告的 InvariantInstaller 常數，` +
            '不能是就地寫的函式——就地寫的沒有名字，下面每一條都對不到它',
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  for (const line of unresolved) {
    addViolation(
      violations,
      owner.sourcePath,
      `第 ${line} 行：register 的 package 名必須解析得到本檔的頂層字串常數`,
    );
  }
  if (registrations.length !== 1 || registrations[0] !== owner.packageName) {
    addViolation(
      violations,
      owner.sourcePath,
      `必須正好註冊自己的 package 名 ${JSON.stringify(owner.packageName)}，` +
        `實際看到 ${JSON.stringify(registrations)}`,
    );
  }
  if (!hasExportedPluginFactory(sourceFile)) {
    addViolation(
      violations,
      owner.sourcePath,
      '必須具名 export 一個 create*InvariantPlugin 工廠——沒有它，這個配套入口誰都掛不上',
    );
  }
  if (hasDefaultExport(sourceFile)) {
    addViolation(
      violations,
      owner.sourcePath,
      '不得 default export：配套入口的 specifier 要留得住具名匯出',
    );
  }

  const installerName = installerNames[0];
  if (installerName !== undefined) {
    checkInstaller(owner, sourceFile, sourceText, installerName, violations);
  }
}

/**
 * installer 本身的兩條。
 *
 * **dsh 要求那個常數叫 `install`，我們不要求。** `@nexus/core` 的叫 `sessionInvariant`，
 * 而為了滿足 gate 去改產品程式碼的名字是本末倒置——#108 的拍板選了「規則照我們的約定」。
 * 這裡改成用 register 實際傳進去的那個識別字去找宣告，效果一樣：檢的還是那個真的被註冊的
 * 函式，不是碰巧同名的另一個。
 */
function checkInstaller(
  owner: PackageInvariantOwner,
  sourceFile: ts.SourceFile,
  sourceText: string,
  installerName: string,
  violations: PackageInvariantViolation[],
): void {
  const declaration = topLevelVariableStatement(sourceFile, installerName);
  const installer =
    declaration === undefined ? undefined : installerFunction(declaration.initializer);
  if (declaration === undefined || installer === undefined) {
    addViolation(
      violations,
      owner.sourcePath,
      `註冊的 ${JSON.stringify(installerName)} 必須是本檔頂層宣告的函式`,
    );
    return;
  }

  if (ts.isBlock(installer.body) && installer.body.statements.length === 0) {
    if (
      !explanationFor(sourceFile, sourceText, declaration.statement).includes(
        NO_RUNTIME_INVARIANT_MARKER,
      )
    ) {
      addViolation(
        violations,
        owner.sourcePath,
        `空 installer 必須說明為什麼，註解要含 "${NO_RUNTIME_INVARIANT_MARKER}"——` +
          '空的是正確結果，沒有說明的空的不是',
      );
    }
    return;
  }

  const reporter = installer.parameters[1]?.name;
  if (reporter === undefined || !ts.isIdentifier(reporter)) {
    addViolation(violations, owner.sourcePath, '非空 installer 的第二個參數必須是綁定的違規回報器');
    return;
  }
  if (!usesIdentifier(installer.body, reporter.text)) {
    addViolation(
      violations,
      owner.sourcePath,
      `非空 installer 必須真的用到它的回報器 ${JSON.stringify(reporter.text)}——` +
        '觀察了卻不回報，等於沒有檢查',
    );
  }
}

/**
 * 空 installer 的說明可以寫在哪裡。
 *
 * 兩個地方都算：**模組檔頭**（第一個 statement 之前的整段），或**這個宣告自己的前置註解**。
 * dsh 只認後者；我們九個檔案的說明都在檔頭，而說明的價值在讀得到不在位置——#108 的拍板選了
 * 「規則照我們的約定」。
 */
function explanationFor(
  sourceFile: ts.SourceFile,
  sourceText: string,
  statement: ts.VariableStatement,
): string {
  const header = sourceText.slice(0, sourceFile.statements[0]?.getStart() ?? 0);
  return `${header}\n${sourceText.slice(statement.getFullStart(), statement.getEnd())}`;
}

function topLevelVariableStatement(
  sourceFile: ts.SourceFile,
  name: string,
): { statement: ts.VariableStatement; initializer: ts.Expression } | undefined {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === name &&
        declaration.initializer !== undefined
      ) {
        return { statement, initializer: declaration.initializer };
      }
    }
  }
  return undefined;
}

function installerFunction(
  node: ts.Expression,
): ts.ArrowFunction | ts.FunctionExpression | undefined {
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return node;
  // `satisfies` / `as` 包起來的還是同一個函式。
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return installerFunction(node.expression);
  }
  return undefined;
}

function usesIdentifier(node: ts.Node, name: string): boolean {
  if (ts.isIdentifier(node) && node.text === name) return true;
  return node.getChildren().some((child) => usesIdentifier(child, name));
}

function topLevelStringConstants(sourceFile: ts.SourceFile): ReadonlyMap<string, string> {
  const constants = new Map<string, string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.initializer !== undefined &&
        ts.isStringLiteral(declaration.initializer)
      ) {
        constants.set(declaration.name.text, declaration.initializer.text);
      }
    }
  }
  return constants;
}

function stringValue(
  node: ts.Expression,
  constants: ReadonlyMap<string, string>,
): string | undefined {
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isIdentifier(node)) return constants.get(node.text);
  return undefined;
}

/** `registry.invariants.register(...)` 這個形狀，不管前面那個物件叫什麼。 */
function isInvariantRegistration(expression: ts.LeftHandSideExpression): boolean {
  if (!ts.isPropertyAccessExpression(expression) || expression.name.text !== 'register') {
    return false;
  }
  const target = expression.expression;
  return ts.isPropertyAccessExpression(target) && target.name.text === 'invariants';
}

function hasExportedPluginFactory(sourceFile: ts.SourceFile): boolean {
  return sourceFile.statements.some(
    (statement) =>
      ts.isFunctionDeclaration(statement) &&
      statement.name !== undefined &&
      /^create.*InvariantPlugin$/.test(statement.name.text) &&
      hasExportModifier(statement),
  );
}

function hasDefaultExport(sourceFile: ts.SourceFile): boolean {
  return sourceFile.statements.some((statement) => {
    if (ts.isExportAssignment(statement)) return true;
    return ts.canHaveModifiers(statement)
      ? (ts.getModifiers(statement) ?? []).some(
          (modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword,
        )
      : false;
  });
}

function hasExportModifier(statement: ts.Statement): boolean {
  return ts.canHaveModifiers(statement)
    ? (ts.getModifiers(statement) ?? []).some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      )
    : false;
}

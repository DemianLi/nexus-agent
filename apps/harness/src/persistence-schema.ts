/**
 * 用 TypeScript 型別檢查器，從原始碼抽出會話日誌落盤的完整型別圖
 * （[#1856](https://github.com/DemianLi/nexus-agent/issues/1856) ⓪b-1）。
 *
 * 照 dsh `scripts/persistence-schema.ts`（`687f282e`）：合成一個只有型別別名的根檔（header、`keyof SessionEventMap`、
 * 每一種 `SessionEvent<"名字">`），跟產品原始碼一起建一個 program，再把每個根的型別轉成 JSON 型別圖
 * （`persistence-schema-model.ts`），算出標準指紋。生成物是 `docs/persistence-schema.json`
 * （`gen-persistence-schema.ts`）。偵測不比 git diff：加一個選填欄位、把必填改選填、改 header，指紋都會變。
 *
 * ## 根
 *
 * - `SessionHeader`：`StoredSessionHeader`（邏輯 header；`version` 是 `typeof SESSION_LOG_FORMAT_VERSION`，#1862）。
 * - `SessionEventEnvelope`：每一種事件拿掉 `data`、`type` 換成 `string` 之後的聯集。一般的新事件種類不改它。
 * - `event:<名字>`：每一種事件，名字來自 `known-event-types-catalog.ts` 的掃描，再跟編譯器看到的
 *   `keyof SessionEventMap` 對一次，兩邊不一致就拋。
 *
 * dsh 另有 `JsonlHeaderLine` 這個根（實體 header 行跟邏輯 header 分開），nexus 不建：header 檔就是 `StoredSessionHeader`
 * 直接序列化，沒有另一個實體型別（不是偏離）。
 *
 * 每個事件根照 dsh 帶 `surface` 欄位（不進指紋；dsh 的驗證器 `persistence-changes.ts:299` 拒收沒有這一格的事件根，
 * `:388`、`:397`、`:424` 用它判斷能不能同版新增）。nexus 沒有 surface 那一軸（`session-log.ts` 的
 * `ModelVisibleEventType` 說明），所以每一種都照實寫 `false`。
 *
 * 合成的根檔放在 `scripts/`（同 dsh），不在追蹤範圍裡：它的型別別名不能變成型別名與宣告位置，否則
 * `__persistence_schema_roots__.ts#EventRootN` 會進基線，而且每加一種排序靠前的事件就整批重編號。
 *
 * ## program 怎麼組
 *
 * dsh 讀 `tsconfig.host.json`，檔案是 host 那一側所有套件的原始碼。nexus 沒有根 `tsconfig.json`，對應的是
 * `tsconfig.base.json`（它的 `paths` 把 `@nexus/core` 對到原始碼，各套件 `declare module '@nexus/core'` 的事件擴充才合得進去），
 * 檔案是 `packages/<套件>/src` 與 `apps/harness/src` 的產品原始碼（跟事件目錄同一套判斷）。`apps/web/src` 不進 program：
 * 它不宣告事件，`tsconfig.base.json` 也沒有 DOM 與 JSX 的設定。編譯選項照 dsh 覆寫成 `strict`、
 * `exactOptionalPropertyTypes`、`skipLibCheck: false`；診斷只收選項、語法、根檔，以及從根可達的宣告範圍內的語意錯誤。
 *
 * ## 過渡：訊息上的來源不進型別圖
 *
 * **`@persistenceSource`／`@persistenceAttribution` 這一刀不搬，登記為過渡（不掛偏離理由）。** dsh 用這兩個標記把訊息來源
 * （`packages/llm/llm/src/message.ts:145` 的 `MessageBase.source`）綁進型別圖，讓「新增一種來源」走寬鬆的相容政策。
 * nexus 訊息上的來源 `MessageSource`（`packages/nexus-core/src/message-source.ts`）落盤在 `additional_kwargs.nexus_source`，
 * 今天的 `LoggedMessage` 照 LangChain 把 `additional_kwargs` 宣告成 `Record<string, any>`，所以圖裡是 `any`。**表達得出來**：
 * 跟 `role`、`name`、`tool_call_id` 一樣在 `LoggedMessage` 改寫型別就行；這一刀不收窄，是因為 `MessageSource` 本身是開放記錄
 * （`kind: string` 加索引簽名），接進來也看不出變更，dsh 的綁定還要求同一個物件上有 `role` 字面量。收窄屬
 * [#1883](https://github.com/DemianLi/nexus-agent/issues/1883)。兩個標記都不搬，清單的 `formatVersion` 固定 1。
 * **後果：訊息的 `additional_kwargs`、`response_metadata` 裡的東西這套檢查看不到，改了不會紅。** `user/message` 的
 * `data.source`（`session-log.ts` 的 `UserMessageSource`，封閉聯集）不受影響，已經在圖裡。
 * 撤除條件：訊息來源改成封閉的型別、落在型別圖看得到的位置（#1883）。
 *
 * `@persistenceReserved` 照搬：標在選填的 `never`／`undefined` 屬性上，讓「預留但還沒用」的欄位留在圖裡。
 *
 * @module
 */

import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import ts from 'typescript';

import {
  collectSessionEventTypes,
  EVENT_CATALOG_ROOTS,
  productFilesUnder,
} from './known-event-types-catalog.js';
import {
  canonicalizeSchema,
  persistenceSchemaSnapshot,
  schemaChildren,
  schemaDigest,
  type PersistenceRoot,
  type PersistenceSchemaInventory,
  type PersistenceType,
  type SchemaNode,
  type SchemaProperty,
} from './persistence-schema-model.js';

/** 生成物的位置，相對於 repo 根。 */
export const PERSISTENCE_SCHEMA_PATH = 'docs/persistence-schema.json';

/** 重新生成的指令：新鮮度測試失敗時印出來。 */
export const PERSISTENCE_SCHEMA_REGENERATE =
  'pnpm --filter @nexus/harness run gen-persistence-schema';

/**
 * 生成物的全文：精簡清單照 dsh `gen-persistence-catalog.ts` 的寫法（兩格縮排、結尾換行）。
 *
 * @param inventory - {@link extractPersistenceSchema} 的結果。
 */
export function renderPersistenceSchema(inventory: PersistenceSchemaInventory): string {
  return `${JSON.stringify(persistenceSchemaSnapshot(inventory), null, 2)}\n`;
}

/** 組 program 用的設定檔，相對於 repo 根。 */
const CONFIG_PATH = 'tsconfig.base.json';

/**
 * 合成的根檔：只存在於 compiler host 裡，不落盤。放在 {@link TRACKED_PREFIXES} 之外（同 dsh 的 `scripts/`），
 * 它的別名才不會被記成型別名與宣告位置。
 */
export const ROOTS_FILE = 'scripts/__persistence_schema_roots__.ts';

/** 型別圖要追蹤宣告位置、收語意診斷、找 `@persistenceReserved` 的原始碼範圍（相對於 repo 根）。 */
const TRACKED_PREFIXES = ['packages/', 'vendor/', 'apps/harness/src/'] as const;

interface DeclarationMetadata {
  readonly names: Set<string>;
  readonly sources: Set<string>;
}

interface RootInput {
  readonly key: string;
  readonly kind: PersistenceRoot['kind'];
  readonly event?: string;
  readonly surface?: boolean;
  readonly node: number;
}

/** 一個可達的 TypeScript 型別沒辦法表示成落盤的 JSON 型別，或原始碼本身不合規。 */
export class PersistenceSchemaError extends Error {
  override name = 'PersistenceSchemaError';
}

/**
 * 抽出每一種事件、事件封裝與會話 header 的型別圖。
 *
 * @param root - repo 根；`tsconfig.base.json` 與掃描的目錄都相對於它。
 * @returns 每個根的標準指紋，以及所有可達的型別定義。
 */
export function extractPersistenceSchema(root: string): PersistenceSchemaInventory {
  root = resolve(root);
  const scan = collectSessionEventTypes(root, EVENT_CATALOG_ROOTS);
  if (scan.violations.length > 0) {
    throw new PersistenceSchemaError(`persistence schema: ${scan.violations.join('\n')}`);
  }
  const events = [...scan.events].sort((left, right) => compare(left.name, right.name));
  if (events.length === 0) {
    throw new PersistenceSchemaError('persistence schema: no Session events were discovered');
  }
  const filename = resolve(root, ROOTS_FILE);
  const source = [
    "import type { SessionEvent, SessionEventMap, StoredSessionHeader } from '@nexus/core';",
    'export type HeaderRoot = StoredSessionHeader;',
    'export type EventNamesRoot = keyof SessionEventMap;',
    ...events.map(
      (event, index) =>
        `export type EventRoot${String(index)} = SessionEvent<${JSON.stringify(event.name)}>;`,
    ),
    '',
  ].join('\n');
  const configPath = resolve(root, CONFIG_PATH);
  const config = ts.readConfigFile(configPath, (file) => readFileSync(file, 'utf8'));
  if (config.error !== undefined) throw new PersistenceSchemaError(diagnosticText(config.error));
  // 只要選項（含 `paths` 的基準目錄）；檔案清單自己組，免得預設的 `**/*` 走遍整個 repo。
  const parsed = ts.parseJsonConfigFileContent(
    { ...(config.config as object), files: [], include: [] },
    ts.sys,
    root,
    undefined,
    configPath,
  );
  // 18002：files 是空的；18003：沒有輸入。兩個都是上一行刻意造成的。
  const configErrors = parsed.errors.filter(
    (error) => error.code !== 18002 && error.code !== 18003,
  );
  if (configErrors.length > 0) {
    throw new PersistenceSchemaError(configErrors.map(diagnosticText).join('\n'));
  }
  const options: ts.CompilerOptions = {
    ...parsed.options,
    composite: false,
    incremental: false,
    noEmit: true,
    rootDir: root,
    noUnusedLocals: false,
    noUnusedParameters: false,
    // 可達的宣告檔有錯，不能變成不透明的 any。
    skipLibCheck: false,
    strict: true,
    exactOptionalPropertyTypes: true,
  };
  const host = ts.createCompilerHost(options);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) =>
    resolve(path) === filename
      ? ts.createSourceFile(filename, source, languageVersion, true)
      : originalGetSourceFile(path, languageVersion, onError, shouldCreateNewSourceFile);
  const files = [
    ...new Set([
      ...programSourceFiles(root),
      ...events.map((event) => resolve(root, event.source.slice(0, event.source.lastIndexOf(':')))),
    ]),
  ];
  const program = ts.createProgram({ rootNames: [filename, ...files], options, host });
  const rootSource = program.getSourceFile(filename);
  if (rootSource === undefined) {
    throw new PersistenceSchemaError('persistence schema: compiler omitted the requested roots');
  }
  const diagnostics = [
    ...program.getOptionsDiagnostics(),
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(rootSource),
  ];
  if (diagnostics.length > 0) {
    throw new PersistenceSchemaError(diagnostics.map(diagnosticText).join('\n'));
  }
  const checker = program.getTypeChecker();
  const declarations = new Map(
    rootSource.statements
      .filter(ts.isTypeAliasDeclaration)
      .map((declaration) => [declaration.name.text, declaration]),
  );
  const declaration = (name: string): ts.TypeAliasDeclaration => {
    const found = declarations.get(name);
    if (found === undefined) {
      throw new PersistenceSchemaError(`persistence schema: missing compiler root ${name}`);
    }
    return found;
  };
  const eventNamesDeclaration = declaration('EventNamesRoot');
  const compiledEvents = stringLiterals(
    checker.getTypeFromTypeNode(eventNamesDeclaration.type),
    'keyof SessionEventMap',
  );
  const discoveredEvents = new Set(events.map((event) => event.name));
  const omitted = [...compiledEvents].filter((name) => !discoveredEvents.has(name));
  const uncompiled = [...discoveredEvents].filter((name) => !compiledEvents.has(name));
  if (omitted.length > 0 || uncompiled.length > 0) {
    throw new PersistenceSchemaError(
      `persistence schema: compiler and source event discovery disagree; omitted: ${omitted.join(', ')}; uncompiled: ${uncompiled.join(', ')}`,
    );
  }
  const header = declaration('HeaderRoot');
  const declarationSources = validateReachableDeclarations(program, root, [
    ...declarations.values(),
  ]);
  const extraction = new SchemaExtractor(root, program, declarationSources);
  const roots: RootInput[] = [
    {
      key: 'SessionHeader',
      kind: 'header',
      node: extraction.convert(checker.getTypeFromTypeNode(header.type), header),
    },
  ];
  const envelopes: number[] = [];
  for (const [index, event] of events.entries()) {
    const item = declaration(`EventRoot${String(index)}`);
    const node = extraction.convert(checker.getTypeFromTypeNode(item.type), item);
    roots.push({
      key: `event:${event.name}`,
      kind: 'event',
      event: event.name,
      surface: false,
      node,
    });
    envelopes.push(extraction.envelope(node, event.name));
  }
  roots.splice(1, 0, {
    key: 'SessionEventEnvelope',
    kind: 'envelope',
    node: extraction.union(envelopes),
  });
  return extraction.inventory(roots);
}

/** program 的檔案：`packages/<套件>/src` 與 `apps/harness/src` 的產品原始碼（對應 dsh 的 `hostSourceFiles`）。 */
function programSourceFiles(root: string): string[] {
  return [
    ...productFilesUnder(root, 'packages').filter((file) => /^packages\/[^/]+\/src\//u.test(file)),
    ...productFilesUnder(root, 'apps/harness/src'),
  ].map((file) => resolve(root, file));
}

function validateReachableDeclarations(
  program: ts.Program,
  root: string,
  roots: readonly ts.Node[],
): ReadonlyMap<ts.Type, readonly ts.Node[]> {
  const checker = program.getTypeChecker();
  const visited = new Set<ts.Node>();
  const declarations = new Map<ts.SourceFile, ts.Node[]>();
  const definitions = new Map<ts.Type, ts.Node[]>();
  const visit = (node: ts.Node): void => {
    if (visited.has(node)) return;
    visited.add(node);
    const file = node.getSourceFile();
    if (trackedSource(slash(relative(root, file.fileName)))) {
      const scopes = declarations.get(file) ?? [];
      scopes.push(node);
      declarations.set(file, scopes);
      if (isNamedTypeDeclaration(node) || ts.isTypeLiteralNode(node)) {
        // 基本型別的別名跟沒有別名的屬性共用同一個 checker 型別。
        const type = checker.getTypeAtLocation(node);
        const entries = definitions.get(type) ?? [];
        entries.push(node);
        definitions.set(type, entries);
      }
    }
    const target = ts.isTypeReferenceNode(node)
      ? node.typeName
      : ts.isExpressionWithTypeArguments(node)
        ? node.expression
        : ts.isTypeQueryNode(node)
          ? node.exprName
          : ts.isImportTypeNode(node)
            ? node.qualifier
            : undefined;
    if (target !== undefined) {
      let symbol = checker.getSymbolAtLocation(target);
      if (symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias) {
        symbol = checker.getAliasedSymbol(symbol);
      }
      for (const declaration of symbol?.declarations ?? []) {
        if (trackedSource(slash(relative(root, declaration.getSourceFile().fileName)))) {
          visit(declaration);
        }
      }
    }
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) return;
    ts.forEachChild(node, visit);
  };
  for (const item of roots) visit(item);
  const errors = [...declarations].flatMap(([file, scopes]) =>
    program.getSemanticDiagnostics(file).filter((error) => {
      const start = error.start;
      return (
        start !== undefined &&
        scopes.some((scope) => start >= scope.getStart() && start < scope.end)
      );
    }),
  );
  if (errors.length > 0) throw new PersistenceSchemaError(errors.map(diagnosticText).join('\n'));
  return definitions;
}

function isNeverOrUndefined(type: ts.Type): boolean {
  return (type.isUnion() ? type.types : [type]).every(
    (member) => (member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Never)) !== 0,
  );
}

function reservedPropertyAnnotations(
  root: string,
  program: ts.Program,
): ReadonlySet<ts.Declaration> {
  const checker = program.getTypeChecker();
  const reserved = new Set<ts.Declaration>();
  for (const file of program.getSourceFiles()) {
    const path = slash(relative(root, file.fileName));
    if (
      !(path.startsWith('packages/') || path.startsWith('apps/harness/src/')) ||
      path.includes('/node_modules/')
    ) {
      continue;
    }
    const visit = (node: ts.Node): void => {
      const tags = ts
        .getJSDocTags(node)
        .filter((tag) => tag.tagName.text === 'persistenceReserved');
      if (tags.length > 0) {
        if (
          tags.length !== 1 ||
          tags[0]?.comment !== undefined ||
          !ts.isPropertySignature(node) ||
          node.questionToken === undefined ||
          !isNeverOrUndefined(checker.getTypeAtLocation(node))
        ) {
          throw new PersistenceSchemaError(
            `persistence schema: ${path}: @persistenceReserved requires one argument-free marker on an optional never or undefined property`,
          );
        }
        reserved.add(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return reserved;
}

class SchemaExtractor {
  readonly nodes: SchemaNode[] = [];
  private readonly cache = new Map<ts.Type, number>();
  private readonly declarationMetadata = new Map<number, DeclarationMetadata>();

  private readonly checker: ts.TypeChecker;
  private readonly reservedProperties: ReadonlySet<ts.Declaration>;

  constructor(
    private readonly root: string,
    program: ts.Program,
    private readonly declarationSources: ReadonlyMap<ts.Type, readonly ts.Node[]>,
  ) {
    this.checker = program.getTypeChecker();
    this.reservedProperties = reservedPropertyAnnotations(root, program);
  }

  convert(type: ts.Type, site: ts.Node): number {
    const cached = this.cache.get(type);
    if (cached !== undefined) {
      this.record(cached, type);
      return cached;
    }
    const id = this.nodes.length;
    this.nodes.push({ kind: 'primitive', type: 'never' });
    this.cache.set(type, id);
    this.record(id, type);
    const add = (node: SchemaNode): number => {
      this.nodes[id] = node;
      return id;
    };
    const flags = type.flags;
    if (flags & ts.TypeFlags.Any) {
      if ((type as ts.Type & { intrinsicName?: string }).intrinsicName === 'error') {
        this.fail(type, site, 'unresolved compiler type');
      }
      return add({ kind: 'opaque', reason: 'any' });
    }
    if (flags & ts.TypeFlags.Unknown) return add({ kind: 'opaque', reason: 'unknown' });
    if (flags & ts.TypeFlags.Never) return add({ kind: 'primitive', type: 'never' });
    if (flags & ts.TypeFlags.Null) return add({ kind: 'primitive', type: 'null' });
    if (flags & ts.TypeFlags.String) return add({ kind: 'primitive', type: 'string' });
    if (flags & ts.TypeFlags.Number) return add({ kind: 'primitive', type: 'number' });
    if (flags & ts.TypeFlags.Boolean) return add({ kind: 'primitive', type: 'boolean' });
    if (flags & ts.TypeFlags.StringLiteral) {
      return add({ kind: 'literal', value: (type as ts.StringLiteralType).value });
    }
    if (flags & ts.TypeFlags.NumberLiteral) {
      return add({ kind: 'literal', value: (type as ts.NumberLiteralType).value });
    }
    if (flags & ts.TypeFlags.BooleanLiteral) {
      return add({ kind: 'literal', value: this.checker.typeToString(type) === 'true' });
    }
    if (type.isUnion()) {
      return add(this.unionNode(type.types.map((member) => this.convert(member, site))));
    }
    if (type.isIntersection()) {
      const material = type.types.filter((member) => !this.phantom(member));
      for (const member of material) this.rejectClass(member, site);
      if (material.length === 1) {
        const target = this.convert(material[0] as ts.Type, site);
        return add({ kind: 'union', types: [target] });
      }
      if (
        material.length === 0 ||
        material.some((member) => (member.flags & ts.TypeFlags.Object) === 0)
      ) {
        this.fail(type, site, 'unsupported material intersection');
      }
      return add(this.object(type, site));
    }
    if (this.checker.isTupleType(type)) {
      const reference = type as ts.TypeReference;
      const target = reference.target as ts.TupleType;
      return add({
        kind: 'tuple',
        elements: this.checker.getTypeArguments(reference).map((element, index) => {
          const elementFlags = target.elementFlags[index] ?? ts.ElementFlags.Required;
          const optional = (elementFlags & ts.ElementFlags.Optional) !== 0;
          const rest = (elementFlags & (ts.ElementFlags.Rest | ts.ElementFlags.Variadic)) !== 0;
          return { type: this.valueType(element, site, optional), optional, rest };
        }),
      });
    }
    if (this.checker.isArrayType(type) || this.checker.isArrayLikeType(type)) {
      const element = this.checker.getIndexTypeOfType(type, ts.IndexKind.Number);
      if (element === undefined) this.fail(type, site, 'array element is unavailable');
      return add({ kind: 'array', element: this.convert(element, site) });
    }
    if (flags & ts.TypeFlags.Object) return add(this.object(type, site));
    this.fail(type, site, 'type has no supported JSON representation');
  }

  private valueType(type: ts.Type, site: ts.Node, optional: boolean): number {
    if (!optional) return this.convert(type, site);
    const members = (type.isUnion() ? type.types : [type]).filter(
      (member) => !(member.flags & ts.TypeFlags.Undefined),
    );
    return this.union(members.map((member) => this.convert(member, site)));
  }

  private object(type: ts.Type, site: ts.Node): SchemaNode {
    this.rejectClass(type, site);
    if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) {
      this.fail(type, site, 'callable data is not JSON');
    }
    const properties: SchemaProperty[] = [];
    for (const property of this.checker
      .getPropertiesOfType(type)
      .sort((left, right) => compare(left.name, right.name))) {
      if (property.getName().startsWith('__@')) {
        this.fail(type, site, 'symbol-keyed data is not a JSON field');
      }
      const declaration = property.valueDeclaration ?? property.declarations?.[0] ?? site;
      const propertyType = this.checker.getTypeOfSymbolAtLocation(property, declaration);
      const optional = (property.flags & ts.SymbolFlags.Optional) !== 0;
      const reserved =
        property.declarations?.some((item) => this.reservedProperties.has(item)) === true;
      if (reserved && (!optional || !isNeverOrUndefined(propertyType))) {
        this.fail(
          type,
          declaration,
          '@persistenceReserved must remain an optional never or undefined property',
        );
      }
      if (optional && isNeverOrUndefined(propertyType) && !reserved) continue;
      const child = this.valueType(propertyType, declaration, optional);
      properties.push({ name: property.getName(), type: child, optional });
    }
    const indices = this.checker.getIndexInfosOfType(type).map((info) => ({
      key: this.convert(info.keyType, site),
      value: this.convert(info.type, site),
    }));
    if (properties.length === 0 && indices.length === 0) {
      this.fail(type, site, 'unconstrained empty object type is not an explicit JSON record');
    }
    return { kind: 'object', properties, indices };
  }

  private rejectClass(type: ts.Type, site: ts.Node): void {
    const symbol = type.getSymbol();
    if (
      symbol?.declarations?.some(
        (declaration) => ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration),
      )
    ) {
      this.fail(type, site, 'class instances require an explicit persisted representation');
    }
  }

  private phantom(type: ts.Type): boolean {
    if (!(type.flags & ts.TypeFlags.Object)) return false;
    const properties = this.checker.getPropertiesOfType(type);
    return (
      properties.length > 0 &&
      properties.every((property) => property.getName().startsWith('__@')) &&
      type.getCallSignatures().length === 0 &&
      type.getConstructSignatures().length === 0 &&
      this.checker.getIndexInfosOfType(type).length === 0
    );
  }

  union(types: readonly number[]): number {
    const node = this.unionNode(types);
    if (node.kind === 'union' && node.types.length === 1) return node.types[0] as number;
    this.nodes.push(node);
    return this.nodes.length - 1;
  }

  private unionNode(types: readonly number[]): SchemaNode {
    if (types.length === 0) return { kind: 'primitive', type: 'never' };
    return { kind: 'union', types: [...new Set(types)] };
  }

  envelope(id: number, event: string): number {
    const node = this.nodes[id] as SchemaNode;
    if (node.kind === 'union') {
      return this.union(node.types.map((type) => this.envelope(type, event)));
    }
    if (node.kind !== 'object') {
      throw new PersistenceSchemaError(
        'persistence schema: SessionEvent must resolve to object alternatives',
      );
    }
    const tag = node.properties.find((property) => property.name === 'type');
    const data = node.properties.find((property) => property.name === 'data');
    const literal =
      tag === undefined ? undefined : canonicalizeSchema(this.nodes, tag.type).nodes[0];
    if (
      tag?.optional !== false ||
      data?.optional !== false ||
      literal?.kind !== 'literal' ||
      literal.value !== event
    ) {
      throw new PersistenceSchemaError(
        `persistence schema: SessionEvent<${JSON.stringify(event)}> must retain its required type and data fields`,
      );
    }
    const string = this.nodes.length;
    this.nodes.push({ kind: 'primitive', type: 'string' });
    const envelope: SchemaNode = {
      kind: 'object',
      properties: node.properties
        .filter((property) => property.name !== 'data')
        .map((property) => (property.name === 'type' ? { ...property, type: string } : property)),
      indices: node.indices,
    };
    this.nodes.push(envelope);
    return this.nodes.length - 1;
  }

  inventory(inputs: readonly RootInput[]): PersistenceSchemaInventory {
    const roots = inputs.map((input) => {
      const schema = canonicalizeSchema(this.nodes, input.node);
      return {
        key: input.key,
        kind: input.kind,
        ...(input.event === undefined ? {} : { event: input.event }),
        ...(input.surface === undefined ? {} : { surface: input.surface }),
        digest: schemaDigest(schema),
        schema,
      };
    });
    const found = new Set<number>();
    const visit = (id: number): void => {
      if (found.has(id)) return;
      found.add(id);
      const node = this.nodes[id] as SchemaNode;
      for (const child of schemaChildren(node)) visit(child);
    };
    for (const input of inputs) visit(input.node);
    const types = new Map<
      string,
      { schema: PersistenceType['schema']; names: Set<string>; sources: Set<string> }
    >();
    for (const id of found) {
      const schema = canonicalizeSchema(this.nodes, id);
      const digest = schemaDigest(schema);
      const item = types.get(digest) ?? {
        schema,
        names: new Set<string>(),
        sources: new Set<string>(),
      };
      const metadata = this.declarationMetadata.get(id);
      for (const name of metadata?.names ?? []) item.names.add(name);
      for (const source of metadata?.sources ?? []) item.sources.add(source);
      types.set(digest, item);
    }
    return {
      formatVersion: 1,
      roots,
      types: [...types]
        .sort(([left], [right]) => compare(left, right))
        .map(([digest, item]) => ({
          digest,
          schema: item.schema,
          names: [...item.names].sort(compare),
          sources: [...item.sources].sort(compare),
        })),
    };
  }

  private record(id: number, type: ts.Type): void {
    const item = this.declarationMetadata.get(id) ?? {
      names: new Set<string>(),
      sources: new Set<string>(),
    };
    const declarations = new Set([
      ...(this.declarationSources.get(type) ?? []),
      ...(type.aliasSymbol?.declarations ?? []),
      ...(type.getSymbol()?.declarations ?? []),
    ]);
    for (const declaration of declarations) {
      if (
        !isNamedTypeDeclaration(declaration) &&
        !ts.isTypeLiteralNode(declaration) &&
        !ts.isEnumMember(declaration)
      ) {
        continue;
      }
      const sourceFile = declaration.getSourceFile();
      const file = slash(relative(this.root, sourceFile.fileName));
      if (!trackedSource(file)) continue;
      if (isNamedTypeDeclaration(declaration)) item.names.add(`${file}#${declaration.name.text}`);
      const position = sourceFile.getLineAndCharacterOfPosition(declaration.getStart());
      item.sources.add(`${file}:${String(position.line + 1)}`);
    }
    this.declarationMetadata.set(id, item);
  }

  private fail(type: ts.Type, site: ts.Node, reason: string): never {
    const file = slash(relative(this.root, site.getSourceFile().fileName));
    const position = site.getSourceFile().getLineAndCharacterOfPosition(site.getStart());
    throw new PersistenceSchemaError(
      `persistence schema: ${file}:${String(position.line + 1)}: ${reason}: ${this.checker.typeToString(type)}`,
    );
  }
}

function isNamedTypeDeclaration(
  node: ts.Node,
): node is ts.TypeAliasDeclaration | ts.InterfaceDeclaration | ts.EnumDeclaration {
  return (
    ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node)
  );
}

function stringLiterals(type: ts.Type, name: string): Set<string> {
  if (type.flags & ts.TypeFlags.Never) return new Set();
  const members = type.isUnion() ? type.types : [type];
  if (members.some((member) => !(member.flags & ts.TypeFlags.StringLiteral))) {
    throw new PersistenceSchemaError(
      `persistence schema: ${name} is not a closed string-literal union`,
    );
  }
  return new Set(members.map((member) => (member as ts.StringLiteralType).value));
}

function diagnosticText(diagnostic: ts.Diagnostic): string {
  return `persistence schema: TypeScript TS${String(diagnostic.code)}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function slash(path: string): string {
  return path.split(sep).join('/');
}

function trackedSource(file: string): boolean {
  return (
    TRACKED_PREFIXES.some((prefix) => file.startsWith(prefix)) && !file.includes('/node_modules/')
  );
}

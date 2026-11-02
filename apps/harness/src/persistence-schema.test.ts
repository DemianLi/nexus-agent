/**
 * 從原始碼抽持久化型別圖（[#1856](https://github.com/DemianLi/nexus-agent/issues/1856) ⓪b-1）。
 *
 * 照 dsh `scripts/persistence-schema.spec.ts`（`687f282e`）：在暫存目錄搭一棵照 nexus 佈局的小 repo
 * （`tsconfig.base.json`、`packages/nexus-core/src` 的 `SessionEventMap` 與 `StoredSessionHeader`、一個放酬載的套件），
 * 改原始碼、重抽、比指紋。沒搬的：surface 與 `JsonlHeaderLine` 那一格（nexus 沒有 surface 那一軸，事件根一律
 * `surface: false`；也沒有 `JsonlHeaderLine` 這個根）、訊息來源政策那一組（過渡，見 `persistence-schema.ts` 檔頭）、用 `classifyPersistenceChange`／`parsePersistenceSnapshot` 斷言的地方
 * （驗證器，⓪b-2；這裡改成比指紋）。
 *
 * 最後兩格跑真的 repo：已提交的 `docs/persistence-schema.json` 沒過期，以及每一種事件都在、每個可達節點都有指紋。
 * 事件探索的根（含 `apps/web/src`）跟抽取器 program 收哪些檔是兩回事（web 不進 program）。
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { collectSessionEventTypes, EVENT_CATALOG_ROOTS } from './known-event-types-catalog.js';
import { repositoryRoot } from './package-invariants.js';
import {
  extractPersistenceSchema,
  PERSISTENCE_SCHEMA_PATH,
  PERSISTENCE_SCHEMA_REGENERATE,
  renderPersistenceSchema,
  ROOTS_FILE,
} from './persistence-schema.js';
import {
  canonicalizeSchema,
  isArbitraryJsonSchema,
  schemaDigest,
  type PersistenceSchemaInventory,
} from './persistence-schema-model.js';

const ROOTS = ['packages', 'apps/harness/src', 'apps/web/src'];

/** 每次抽取都建一個 program；夾具測試一格最多抽三次。 */
const EXTRACT_TIMEOUT = 60_000;

const PAYLOAD = 'packages/fixture-payload/src/types.ts';
const SESSION_LOG = 'packages/nexus-core/src/session-log.ts';
const SESSION_STORE = 'packages/nexus-core/src/session-store.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

function put(root: string, file: string, source: string): void {
  const path = join(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
}

function fixture(payload: string, options: { event?: string } = {}): string {
  // realpath：macOS 的暫存目錄經過 /var → /private/var 的連結，編譯器解出來的檔名是真路徑。
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nexus-persistence-schema-')));
  roots.push(root);
  put(
    root,
    'tsconfig.base.json',
    JSON.stringify({
      compilerOptions: {
        target: 'ES2023',
        lib: ['ES2023'],
        module: 'ESNext',
        moduleResolution: 'bundler',
        strict: true,
        skipLibCheck: true,
        types: [],
        paths: {
          '@nexus/core': ['./packages/nexus-core/src/index.ts'],
          '@fixture/payload': [`./${PAYLOAD}`],
        },
      },
    }),
  );
  mkdirSync(join(root, 'apps/harness/src'), { recursive: true });
  mkdirSync(join(root, 'apps/web/src'), { recursive: true });
  put(
    root,
    'apps/harness/src/jsonl-session-store.ts',
    "import type { StoredSessionHeader } from '@nexus/core';\nexport interface JsonlHeaderLine extends StoredSessionHeader { readonly type: 'session' }\n",
  );
  put(root, PAYLOAD, payload);
  put(
    root,
    'packages/nexus-core/src/index.ts',
    [
      "export type { SessionEvent, SessionEventMap } from './session-log.js';",
      "export type { StoredSessionHeader } from './session-store.js';",
      '',
    ].join('\n'),
  );
  put(
    root,
    SESSION_STORE,
    'export interface StoredSessionHeader { readonly version: 50; readonly id: string; readonly createdAt: number; readonly cwd?: string }\n',
  );
  put(
    root,
    SESSION_LOG,
    `
import type { Payload } from '@fixture/payload';
export interface SessionEventMap {
  /** One recorded payload. */
  'test/record': Payload;
  ${options.event ?? ''}
}
export type SessionEventType = keyof SessionEventMap;
export type SessionEvent<T extends SessionEventType = SessionEventType> = T extends SessionEventType
  ? { readonly type: T; readonly seq: number; readonly time: number; readonly data: SessionEventMap[T]; readonly ignorable?: true }
  : never;
`,
  );
  return root;
}

function event(inventory: PersistenceSchemaInventory, name = 'test/record'): string {
  const root = inventory.roots.find((item) => item.event === name);
  if (root === undefined) throw new Error(`missing test event ${name}`);
  return root.digest;
}

function digestOf(inventory: PersistenceSchemaInventory, key: string): string | undefined {
  return inventory.roots.find((item) => item.key === key)?.digest;
}

describe('從原始碼抽持久化型別', { timeout: EXTRACT_TIMEOUT }, () => {
  it('根依序是 header、header 行、事件封裝、每一種事件；header 的版號是字面量', () => {
    const inventory = extractPersistenceSchema(fixture('export interface Payload { id: string }'));
    expect(inventory.formatVersion).toBe(1);
    expect(inventory.roots.map((item) => item.key)).toEqual([
      'SessionHeader',
      'JsonlHeaderLine',
      'SessionEventEnvelope',
      'event:test/record',
    ]);
    // 事件根帶 surface 這一格；nexus 沒有這一軸，一律 false。header、header 行與封裝沒有這一格。
    expect(inventory.roots.map((item) => item.surface)).toEqual([
      undefined,
      undefined,
      undefined,
      false,
    ]);
    expect(Object.keys(inventory.roots[0]!)).not.toContain('surface');
    expect(Object.keys(inventory.roots[1]!)).not.toContain('surface');
    expect(Object.keys(inventory.roots[2]!)).not.toContain('surface');
    const header = inventory.roots[0]!.schema;
    const object = header.nodes[0];
    if (object?.kind !== 'object') throw new Error('header is not an object');
    const version = object.properties.find((property) => property.name === 'version');
    expect(version?.optional).toBe(false);
    expect(header.nodes[version!.type]).toEqual({ kind: 'literal', value: 50 });
  });

  it('保留寫出來的型別名與匿名宣告的位置，不替走訪路徑編名字', () => {
    const root = fixture(
      'interface Section { text: string }\nexport interface Payload { inserted: { source: { kind: "hooks"; sections: Section[] } }[] }',
    );
    const inventory = extractPersistenceSchema(root);
    expect(inventory.types.flatMap((type) => type.names).every((name) => name.includes('#'))).toBe(
      true,
    );
    expect(inventory.types.some((type) => type.names.includes(`${PAYLOAD}#Section`))).toBe(true);
    expect(
      inventory.types.some(
        (type) => type.names.length === 0 && type.sources.includes(`${PAYLOAD}:2`),
      ),
    ).toBe(true);
    expect(
      inventory.types.some(
        (type) => type.schema.nodes[0]?.kind === 'array' && type.names.length === 0,
      ),
    ).toBe(true);
  });

  it('別名、檔案、說明、readonly、品牌與屬性順序都不進指紋', () => {
    const left = fixture(
      'declare const brand: unique symbol; type Id = string & {readonly [brand]: "Id"}; export interface Payload { readonly id: Id; value?: number }',
    );
    const right = fixture(
      'type Renamed = string; /** Different documentation. */ export type Payload = {value?: number; id: Renamed}',
    );
    expect(event(extractPersistenceSchema(left))).toBe(event(extractPersistenceSchema(right)));
  });

  it.each([
    [
      '巢狀欄位順序',
      'export interface Payload {\n  id: string\n  detail: {\n    label: string\n    count?: number\n  }\n}',
      'export interface Payload {\n  detail: {\n    count?: number\n    label: string\n  }\n  id: string\n}',
    ],
    [
      '匿名聯集順序',
      'export type Payload =\n  { a: string }\n  | { b: number }\n  | { c?: boolean }',
      'export type Payload =\n  { c?: boolean }\n  | { b: number }\n  | { a: string }',
    ],
    [
      '遞迴聯集順序',
      'export type Payload =\n  { a: string; next?: Payload }\n  | { b: number; next?: Payload }\n  | null',
      'export type Payload =\n  null\n  | { next?: Payload; b: number }\n  | { next?: Payload; a: string }',
    ],
    [
      '交集與分配出來的聯集順序',
      'type A = { a: string } | { b: number }; type B = { c: boolean }; export type Payload = A & B',
      'type A = { b: number } | { a: string }; type B = { c: boolean }; export type Payload = B & A',
    ],
    [
      '索引簽名順序',
      'export interface Payload { [key: string]: string | number; [key: number]: number }',
      'export interface Payload { [key: number]: number; [key: string]: number | string }',
    ],
    [
      '型別宣告順序',
      'interface A { a: string }\ninterface B { b: number }\nexport type Payload = A | B',
      'interface B { b: number }\ninterface A { a: string }\nexport type Payload = B | A',
    ],
    [
      '合併宣告順序',
      'export interface Payload { a: string }\nexport interface Payload { b: number }',
      'export interface Payload { b: number }\nexport interface Payload { a: string }',
    ],
    [
      '映射鍵順序',
      'export type Payload = { [K in "a" | "b" | "c"]: string }',
      'export type Payload = { [K in "c" | "b" | "a"]: string }',
    ],
    [
      '明寫值的 enum 成員順序',
      'enum Value {\n  A = "a",\n  B = "b",\n}\nexport interface Payload { value: Value }',
      'enum Value {\n  B = "b",\n  A = "a",\n}\nexport interface Payload { value: Value }',
    ],
  ])('%s換了，每個根與型別的指紋都不變', (_name, before, after) => {
    const root = fixture(before);
    const inventory = extractPersistenceSchema(root);
    put(root, PAYLOAD, after);
    const reordered = extractPersistenceSchema(root);
    expect(reordered.roots).toEqual(inventory.roots);
    expect(reordered.types.map(({ digest, schema }) => ({ digest, schema }))).toEqual(
      inventory.types.map(({ digest, schema }) => ({ digest, schema })),
    );
  });

  it.each([
    [
      'tuple 位置',
      'export type Payload = [string, number]',
      'export type Payload = [number, string]',
    ],
    [
      '隱含值的 enum',
      'enum Value { A, B }; export interface Payload { value: Value.A }',
      'enum Value { B, A }; export interface Payload { value: Value.A }',
    ],
  ])('換順序會改變%s時，指紋跟著變', (_name, before, after) => {
    const root = fixture(before);
    const digest = event(extractPersistenceSchema(root));
    put(root, PAYLOAD, after);
    expect(event(extractPersistenceSchema(root))).not.toBe(digest);
  });

  it('header、事件封裝與事件的宣告換順序，指紋不變', () => {
    const record = "  /** One recorded payload. */\n  'test/record': Payload;";
    const other = "/** Another recorded payload. */\n  'test/other': { value: number };";
    const root = fixture('export interface Payload { id: string }', { event: other });
    const inventory = extractPersistenceSchema(root);
    const source = readFileSync(join(root, SESSION_LOG), 'utf8');
    const reordered = source
      .replace(`${record}\n  ${other}`, `  ${other}\n${record}`)
      .replace(
        'readonly type: T; readonly seq: number; readonly time: number; readonly data: SessionEventMap[T]',
        'readonly data: SessionEventMap[T]; readonly time: number; readonly seq: number; readonly type: T',
      );
    expect(reordered.indexOf("'test/other':")).toBeLessThan(reordered.indexOf("'test/record':"));
    expect(reordered).toContain('readonly data: SessionEventMap[T]; readonly time');
    put(root, SESSION_LOG, reordered);
    put(
      root,
      SESSION_STORE,
      'export interface StoredSessionHeader { readonly cwd?: string; readonly createdAt: number; readonly id: string; readonly version: 50 }\n',
    );
    const result = extractPersistenceSchema(root);
    expect(result.roots).toEqual(inventory.roots);
    expect(result.types.map(({ digest, schema }) => ({ digest, schema }))).toEqual(
      inventory.types.map(({ digest, schema }) => ({ digest, schema })),
    );
  });

  it('把泛型、條件與映射別名展開成實際的屬性', () => {
    const generic = fixture(
      'type Box<T> = { [K in keyof T]: T[K] extends string ? string[] : T[K] }; export type Payload = Box<{label: string; count?: number}>',
    );
    const concrete = fixture('export interface Payload {count?: number; label: string[]}');
    expect(event(extractPersistenceSchema(generic))).toBe(
      event(extractPersistenceSchema(concrete)),
    );
  });

  it('遞迴照算，跟別名怎麼拆無關', () => {
    const self = fixture('export interface Payload { value: string; next?: Payload }');
    const mutual = fixture(
      'interface Other {next?: Payload; value: string} export interface Payload {value: string; next?: Other}',
    );
    const changed = fixture(
      'interface Other {next?: Payload; value: number} export interface Payload {value: string; next?: Other}',
    );
    const digest = event(extractPersistenceSchema(self));
    expect(event(extractPersistenceSchema(mutual))).toBe(digest);
    expect(event(extractPersistenceSchema(changed))).not.toBe(digest);
  });

  it('沒宣告事件、只擴充巢狀酬載表的套件也算進來', () => {
    const root = fixture(
      'export interface NestedMap {first: {value: string}}; export type Payload = NestedMap[keyof NestedMap]',
    );
    const before = extractPersistenceSchema(root);
    put(
      root,
      'packages/fixture-extension/src/index.ts',
      "import '@fixture/payload'; declare module '@fixture/payload' {interface NestedMap {second: {value: number}}}",
    );
    const after = extractPersistenceSchema(root);
    expect(collectSessionEventTypes(root, ROOTS).events).toHaveLength(1);
    expect(event(after)).not.toBe(event(before));
  });

  it("找得到插件用 declare module '@nexus/core' 加的事件；一般的新事件不改事件封裝與既有事件的指紋", () => {
    const root = fixture('export interface Payload {id: string}');
    const before = extractPersistenceSchema(root);
    put(
      root,
      'packages/fixture-extension/src/index.ts',
      `import '@nexus/core'; declare module '@nexus/core' {
interface SessionEventMap {
/** A plugin event. */
'plugin/new': { optional?: boolean }
}}
`,
    );
    const after = extractPersistenceSchema(root);
    expect(after.roots.some((item) => item.event === 'plugin/new')).toBe(true);
    expect(digestOf(after, 'SessionEventEnvelope')).toBe(digestOf(before, 'SessionEventEnvelope'));
    expect(event(after)).toBe(event(before));
  });

  it('harness 宣告的事件也算進來', () => {
    const root = fixture('export interface Payload {id: string}');
    put(
      root,
      'apps/harness/src/extension.ts',
      `import '@nexus/core'; declare module '@nexus/core' {
interface SessionEventMap {
/** A harness event. */
'harness/new': { value: string }
}}
`,
    );
    expect(extractPersistenceSchema(root).roots.some((item) => item.event === 'harness/new')).toBe(
      true,
    );
  });

  it('JSX 模組的事件照收；在那裡用 extends 宣告一樣被拒', () => {
    const root = fixture('export interface Payload {id: string}');
    put(
      root,
      'packages/fixture-extension/src/index.tsx',
      `import '@nexus/core'; declare module '@nexus/core' {
interface SessionEventMap {
/** A JSX-module event. */
'plugin/tsx': { value: number }
}}
`,
    );
    expect(extractPersistenceSchema(root).roots.some((item) => item.event === 'plugin/tsx')).toBe(
      true,
    );
    put(
      root,
      'packages/fixture-extension/src/index.tsx',
      `import '@nexus/core';
interface Extra { 'plugin/inherited': {value: number} }
declare module '@nexus/core' { interface SessionEventMap extends Extra {} }
`,
    );
    expect(() => extractPersistenceSchema(root)).toThrow('用了 extends');
  });

  it('編譯器看到的事件比原始碼掃到的多就拒絕', () => {
    const root = fixture(
      "import '../../../vendor/events.ts'; export interface Payload {id: string}",
    );
    put(
      root,
      'vendor/events.ts',
      `import '@nexus/core'; declare module '@nexus/core' {
interface SessionEventMap {
/** A contribution outside the package source corpus. */
'outside/event': { value: number }
}}
`,
    );
    expect(() => extractPersistenceSchema(root)).toThrow('omitted: outside/event');
  });

  it('加一個選填欄位，事件的指紋就變', () => {
    const old = extractPersistenceSchema(fixture('export interface Payload {id: string}'));
    const optional = extractPersistenceSchema(
      fixture('export interface Payload {id: string; detail?: string}'),
    );
    expect(event(old)).not.toBe(event(optional));
    expect(digestOf(optional, 'SessionEventEnvelope')).toBe(digestOf(old, 'SessionEventEnvelope'));
  });

  it('header 加欄位或升版號，只動 header 的指紋', () => {
    const root = fixture('export interface Payload {id: string}');
    const before = extractPersistenceSchema(root);
    for (const header of [
      'export interface StoredSessionHeader { readonly version: 50; readonly id: string; readonly createdAt: number; readonly cwd?: string; readonly marker?: string }\n',
      'export interface StoredSessionHeader { readonly version: 51; readonly id: string; readonly createdAt: number; readonly cwd?: string }\n',
    ]) {
      put(root, SESSION_STORE, header);
      const after = extractPersistenceSchema(root);
      expect(digestOf(after, 'SessionHeader')).not.toBe(digestOf(before, 'SessionHeader'));
      expect(digestOf(after, 'SessionEventEnvelope')).toBe(
        digestOf(before, 'SessionEventEnvelope'),
      );
      expect(event(after)).toBe(event(before));
    }
  });

  it('事件封裝多一個欄位，封裝與每一種事件的指紋都變', () => {
    const root = fixture('export interface Payload {id: string}');
    const before = extractPersistenceSchema(root);
    const source = readFileSync(join(root, SESSION_LOG), 'utf8');
    const changed = source.replace(
      'readonly ignorable?: true }',
      'readonly ignorable?: true; readonly origin?: string }',
    );
    expect(changed).not.toBe(source);
    put(root, SESSION_LOG, changed);
    const after = extractPersistenceSchema(root);
    expect(digestOf(after, 'SessionEventEnvelope')).not.toBe(
      digestOf(before, 'SessionEventEnvelope'),
    );
    expect(event(after)).not.toBe(event(before));
  });

  it('任意 JSON 照結構記；unknown 與 any 明確標成不透明', () => {
    const root = fixture(
      'type Arbitrary = null | boolean | number | string | Arbitrary[] | {[key: string]: Arbitrary}; export interface Payload {json: Arbitrary; opaque: unknown; unsafe: any}',
    );
    const model = extractPersistenceSchema(root);
    expect(model.types.some((item) => isArbitraryJsonSchema(item.schema))).toBe(true);
    expect(
      model.types
        .filter((item) => item.schema.nodes[0]?.kind === 'opaque')
        .map((item) => item.schema.nodes[0]),
    ).toEqual(
      expect.arrayContaining([
        { kind: 'opaque', reason: 'unknown' },
        { kind: 'opaque', reason: 'any' },
      ]),
    );
    put(
      root,
      PAYLOAD,
      'type Arbitrary = null | boolean | number | string | Arbitrary[]; export interface Payload {json: Arbitrary; opaque: unknown; unsafe: any}',
    );
    const changed = extractPersistenceSchema(root);
    expect(event(changed)).not.toBe(event(model));
    expect(changed.types.some((item) => isArbitraryJsonSchema(item.schema))).toBe(false);
  });

  it('可達的宣告檔有錯就拒絕，不管設定裡的 skipLibCheck', () => {
    const root = fixture("export type { Payload } from './declared.js'");
    put(
      root,
      'packages/fixture-payload/src/declared.d.ts',
      'type Bad = ReturnType<42>; export interface Payload {value: Bad}',
    );
    expect(() => extractPersistenceSchema(root)).toThrow('TS2344');
  });

  it('宣告檔寫明的 any 照收，不檢查不相干的宣告', () => {
    const root = fixture("export type { Payload } from './declared.js'");
    put(
      root,
      'packages/fixture-payload/src/declared.d.ts',
      'type Declared = any; export interface Payload {value: Declared}; type Unrelated = ReturnType<42>',
    );
    const model = extractPersistenceSchema(root);
    expect(
      model.types.some(
        (item) => item.schema.nodes[0]?.kind === 'opaque' && item.schema.nodes[0].reason === 'any',
      ),
    ).toBe(true);
  });

  it('具名的遞移定義記在宣告處，不記在參照處', () => {
    const root = fixture(
      "import type { Detail as ImportedDetail } from './detail.js'\nexport interface Payload { first: ImportedDetail; second: ImportedDetail }",
    );
    put(
      root,
      'packages/fixture-payload/src/detail.ts',
      '/** Detailed payload. */\nexport interface Detail { code: string; done: true }\n',
    );
    const model = extractPersistenceSchema(root);
    const detail = model.types.find((item) =>
      item.names.includes('packages/fixture-payload/src/detail.ts#Detail'),
    );
    expect(detail?.sources).toEqual(['packages/fixture-payload/src/detail.ts:2']);
  });

  it('共用的純量只在真的別名上記宣告資訊，一般的屬性參照不記', () => {
    const root = fixture(
      [
        'type Label = string',
        "type Done = 'done'",
        'export interface Payload {',
        '  label: Label',
        '  other: string',
        '  state: Done',
        "  fallback: 'done'",
        '  count: number',
        '}',
      ].join('\n'),
    );
    const model = extractPersistenceSchema(root);
    const string = model.types.find(
      (item) =>
        item.schema.nodes[0]?.kind === 'primitive' && item.schema.nodes[0].type === 'string',
    );
    const literal = model.types.find(
      (item) => item.schema.nodes[0]?.kind === 'literal' && item.schema.nodes[0].value === 'done',
    );
    const number = model.types.find(
      (item) =>
        item.schema.nodes[0]?.kind === 'primitive' && item.schema.nodes[0].type === 'number',
    );
    expect(string?.names).toEqual([`${PAYLOAD}#Label`]);
    expect(string?.sources).toEqual([`${PAYLOAD}:1`]);
    expect(literal?.names).toEqual([`${PAYLOAD}#Done`]);
    expect(literal?.sources).toEqual([`${PAYLOAD}:2`]);
    expect(number?.names).toEqual([]);
    expect(number?.sources).toEqual([]);
  });

  it('匿名物件字面量記它自己的位置，不記包住它的屬性', () => {
    const root = fixture('export interface Payload {\n  detail:\n    { code: string }\n}');
    const model = extractPersistenceSchema(root);
    const detail = model.types.find((item) => {
      const node = item.schema.nodes[0];
      return (
        node?.kind === 'object' &&
        node.properties.length === 1 &&
        node.properties[0]?.name === 'code'
      );
    });
    expect(detail?.sources).toEqual([`${PAYLOAD}:3`]);
  });

  it.each([
    ['不存在的型別', 'export interface Payload {value: Missing}', 'TS2304'],
    ['函式值', 'export interface Payload {value: () => void}', 'callable data'],
    [
      'class 實例',
      'export class Instance {value: string = ""}; export interface Payload {value: Instance}',
      'class instances',
    ],
    [
      '必填卻可以是 undefined',
      'export interface Payload {value: string | undefined}',
      'no supported JSON',
    ],
    [
      '沒解開的樣板字串',
      'export interface Payload {value: `prefix-${string}`}',
      'no supported JSON',
    ],
    ['空物件型別', 'export type Payload = {}', 'unconstrained empty object'],
    [
      'symbol 鍵',
      'declare const key: unique symbol; export interface Payload {[key]: string; value: number}',
      'symbol-keyed data',
    ],
    [
      '合併時互相衝突的屬性',
      'export interface Payload {value: string}; export interface Payload {value: number}',
      'TS2717',
    ],
    [
      '跟 class 交集',
      'class Instance {value: string = ""}; export type Payload = Instance & {extra: string}',
      'class instances',
    ],
    [
      '不合法的泛型別名',
      'type Bad = ReturnType<42>; export interface Payload {value: Bad}',
      'TS2344',
    ],
  ])('%s：拒絕，不把型別圖放寬', (_name, source, error) => {
    expect(() => extractPersistenceSchema(fixture(source))).toThrow(error);
  });
});

describe('明確預留的 JSON 屬性', { timeout: EXTRACT_TIMEOUT }, () => {
  function extractedEvent(source: string) {
    const model = extractPersistenceSchema(fixture(source));
    const root = model.roots.find((item) => item.event === 'test/record');
    if (root === undefined) throw new Error('missing reserved-property fixture event');
    return root;
  }

  it('預留欄位改成有值，指紋就變', () => {
    const before = extractedEvent(
      'export interface Payload { id: string;\n/** @persistenceReserved */\ntool?: never }',
    );
    const after = extractedEvent('export interface Payload { id: string; tool?: string }');
    expect(after.digest).not.toBe(before.digest);
  });

  it.each(['never', 'undefined', 'never | undefined'])(
    '標了的選填 %s 屬性留在圖裡，值是 never',
    (value) => {
      const root = extractedEvent(
        `interface Reserved {\n/** @persistenceReserved */\ntool?: ${value}\n}\nexport interface Payload extends Reserved { id: string }`,
      );
      const reserved = root.schema.nodes.flatMap((node) =>
        node.kind === 'object'
          ? node.properties
              .filter((property) => property.name === 'tool')
              .map((property) => ({
                optional: property.optional,
                value: root.schema.nodes[property.type],
              }))
          : [],
      );
      expect(reserved).toEqual([{ optional: true, value: { kind: 'primitive', type: 'never' } }]);
    },
  );

  it('沒標的選填 never 與 undefined 欄位照舊抹掉', () => {
    const before = extractedEvent(
      'export interface Payload { id: string; tool?: never; missing?: undefined }',
    );
    const after = extractedEvent('export interface Payload { id: string }');
    expect(before).toEqual(after);
  });

  it.each(['Required<Reserved>', '{ [Key in keyof Reserved]?: string }'])(
    '預留屬性被 %s 改寫就拒絕',
    (mapped) => {
      expect(() =>
        extractedEvent(
          `interface Reserved {\n/** @persistenceReserved */\ntool?: never\n}\nexport type Payload = ${mapped} & {id: string}`,
        ),
      ).toThrow('@persistenceReserved must remain an optional never or undefined property');
    },
  );

  it.each([
    [
      '必填欄位',
      'export interface Payload { id: string;\n/** @persistenceReserved */\ntool: never }',
    ],
    [
      '字串欄位',
      'export interface Payload { id: string;\n/** @persistenceReserved */\ntool?: string }',
    ],
    [
      '可為 null',
      'export interface Payload { id: string;\n/** @persistenceReserved */\ntool?: null }',
    ],
    [
      'unknown 欄位',
      'export interface Payload { id: string;\n/** @persistenceReserved */\ntool?: unknown }',
    ],
    [
      '標記帶參數',
      'export interface Payload { id: string;\n/** @persistenceReserved value */\ntool?: never }',
    ],
    [
      '標記重複',
      'export interface Payload { id: string;\n/** @persistenceReserved\n * @persistenceReserved */\ntool?: never }',
    ],
    ['標在屬性以外', '/** @persistenceReserved */\nexport interface Payload { id: string }'],
    [
      '標在到不了的地方也算',
      'interface Unused {\n/** @persistenceReserved */\ntool?: string }\nexport interface Payload { id: string }',
    ],
  ])('%s：拒絕', (_name, source) => {
    expect(() => extractedEvent(source)).toThrow(
      '@persistenceReserved requires one argument-free marker on an optional never or undefined property',
    );
  });
});

describe('這個 repo 的持久化型別圖', { timeout: EXTRACT_TIMEOUT }, () => {
  const root = repositoryRoot();
  let inventory: PersistenceSchemaInventory;
  beforeAll(() => {
    inventory = extractPersistenceSchema(root);
  }, EXTRACT_TIMEOUT);

  it('事件探索的根跟事件目錄一樣', () => {
    expect([...EVENT_CATALOG_ROOTS]).toEqual(ROOTS);
  });

  it(`已提交的 ${PERSISTENCE_SCHEMA_PATH} 沒過期（過期了跑：${PERSISTENCE_SCHEMA_REGENERATE}）`, () => {
    const committed = readFileSync(join(root, PERSISTENCE_SCHEMA_PATH), 'utf8');
    expect(
      committed,
      `${PERSISTENCE_SCHEMA_PATH} 跟原始碼抽出來的型別圖不一致。重新生成：${PERSISTENCE_SCHEMA_REGENERATE}`,
    ).toBe(renderPersistenceSchema(inventory));
  });

  it('合成的根檔不在追蹤範圍裡，沒有型別名或宣告位置指向它', () => {
    const stem = basename(ROOTS_FILE, '.ts');
    const leaked = inventory.types.flatMap((type) =>
      [...type.names, ...type.sources].filter((entry) => entry.includes(stem)),
    );
    expect(leaked).toEqual([]);
  });

  it('每一種事件都在，每個可達節點都有指紋', () => {
    expect(
      inventory.roots
        .filter((item) => item.kind === 'event')
        .map((item) => item.event)
        .sort(),
    ).toEqual(
      collectSessionEventTypes(root, ROOTS)
        .events.map((item) => item.name)
        .sort(),
    );
    expect(
      inventory.roots.filter((item) => item.kind === 'header').map((item) => item.key),
    ).toEqual(['SessionHeader', 'JsonlHeaderLine']);
    expect(inventory.roots.filter((item) => item.kind === 'envelope')).toHaveLength(1);
    for (const item of inventory.roots) {
      expect(item.surface, item.key).toBe(item.kind === 'event' ? false : undefined);
    }
    const digests = new Set(inventory.types.map((type) => type.digest));
    for (const item of inventory.roots) {
      expect(schemaDigest(item.schema)).toBe(item.digest);
      for (let node = 0; node < item.schema.nodes.length; node++) {
        expect(digests.has(schemaDigest(canonicalizeSchema(item.schema.nodes, node)))).toBe(true);
      }
    }
  });
});

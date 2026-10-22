/**
 * 持久化型別變更的確認紀錄與驗證器（[#1856](https://github.com/DemianLi/nexus-agent/issues/1856) ⓪b-2）。
 *
 * 照 dsh `scripts/persistence-changes.spec.ts`（`687f282e`）：多數格用手搭的清單（`typeRoot`）當抽取結果，在暫存目錄
 * 寫紀錄、驗歷史。沒搬的：歷史格式的快照解析、定稿檢查點、訊息來源的相容政策（理由見 `persistence-changes.ts` 檔頭）；
 * 中英兩份的比對改成單一份（偏離 1）。dsh 拿定稿當起點的幾格，改從基線起算、拿掉定稿那幾個斷言。
 *
 * 另外兩組是 nexus 加的：「驗收」那組在 ⓪b-1 那種夾具樹上跑真的抽取器，逐條走卡面的驗收 A–F；最後一格對這個 repo
 * 跑 {@link verifyPersistenceChanges}，CI 靠它擋「動了持久化型別卻沒寫紀錄」。
 */

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { repositoryRoot } from './package-invariants.js';
import {
  classifyPersistenceChange,
  loadPersistenceHistory,
  parsePersistenceSnapshot,
  PERSISTENCE_HISTORY_DIRECTORY,
  runPersistenceChanges as executePersistenceChanges,
  validatePersistenceHistory,
  verifyPersistenceChanges,
} from './persistence-changes.js';
import type {
  PersistenceChangeRecord,
  PersistenceHistoryEntry,
  PersistenceTypeChange,
} from './persistence-changes.js';
import {
  extractPersistenceSchema,
  PERSISTENCE_SCHEMA_PATH,
  renderPersistenceSchema,
} from './persistence-schema.js';
import { canonicalizeSchema, schemaDigest } from './persistence-schema-model.js';
import type {
  PersistenceRoot,
  PersistenceSchemaInventory,
  SchemaNode,
  SchemaProperty,
} from './persistence-schema-model.js';

/** 真抽取器每次建一個 program；驗收那組一格最多抽十幾次。 */
const EXTRACT_TIMEOUT = 90_000;

function runPersistenceChanges(
  args: readonly string[],
  root: string,
  extract: (root: string) => PersistenceSchemaInventory,
): string {
  return executePersistenceChanges(args, root, extract, (_root, current) => [
    { path: PERSISTENCE_SCHEMA_PATH, content: JSON.stringify(current, null, 2) + '\n' },
  ]);
}

function jsonResult(source: string): { ok: boolean; files: readonly string[] } {
  return JSON.parse(source) as { ok: boolean; files: readonly string[] };
}

const AUTHORED_PROSE = {
  summary: '新增選填的中繼資料。',
  compatibility: '讀方可以略過這個中繼資料。',
  verification: '針對性的測試通過。',
};

function proseFile(root: string): string {
  const path = join(root, 'prose.json');
  writeFileSync(path, JSON.stringify(AUTHORED_PROSE));
  return path;
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'nexus-persistence-changes-'));
  roots.push(root);
  mkdirSync(join(root, PERSISTENCE_HISTORY_DIRECTORY), { recursive: true });
  return root;
}

type Shape = 'string' | 'number' | 'boolean' | { readonly [property: string]: Shape };

function typeRoot(key: string, shape: Shape, version = 3): PersistenceRoot {
  const nodes: SchemaNode[] = [];
  function add(shape: Shape): number {
    const index = nodes.length;
    nodes.push({ kind: 'primitive', type: 'never' });
    nodes[index] =
      typeof shape === 'string'
        ? { kind: 'primitive', type: shape }
        : {
            kind: 'object',
            indices: [],
            properties: Object.entries(shape).map(([name, child]) => ({
              name: name.replace(/\?$/u, ''),
              optional: name.endsWith('?'),
              type: add(child),
            })),
          };
    return index;
  }
  if (key === 'SessionHeader') {
    const index = add(shape);
    const node = nodes[index]!;
    if (node.kind !== 'object') throw new Error('header fixture requires an object');
    nodes[index] = {
      ...node,
      properties: [...node.properties, { name: 'version', optional: false, type: nodes.length }],
    };
    nodes.push({ kind: 'literal', value: version });
  } else if (key.startsWith('event:')) {
    add({ data: shape, type: 'string' });
    const node = nodes[0]!;
    if (node.kind !== 'object') throw new Error('event fixture requires an object');
    const type = node.properties.find((item) => item.name === 'type')!.type;
    nodes[type] = { kind: 'literal', value: key.slice(6) };
  } else add(shape);
  const schema = canonicalizeSchema(nodes, 0);
  return {
    key,
    kind:
      key === 'SessionHeader' ? 'header' : key === 'SessionEventEnvelope' ? 'envelope' : 'event',
    ...(key.startsWith('event:') ? { event: key.slice(6), surface: false } : {}),
    schema,
    digest: schemaDigest(schema),
  };
}

function inventory(
  eventShape: Shape = { value: 'string' },
  version = 3,
): PersistenceSchemaInventory {
  return {
    formatVersion: 1,
    types: [],
    roots: [
      typeRoot('SessionHeader', { id: 'string' }, version),
      typeRoot('SessionEventEnvelope', { type: 'string' }),
      typeRoot('event:example/value', eventShape),
    ],
  };
}

function entry(
  id: string,
  schema: PersistenceSchemaInventory,
  previous: string | null,
  baseline = false,
  decision: 'same-version' | 'version-bump' = 'same-version',
): PersistenceHistoryEntry {
  return {
    record: {
      schemaVersion: 1,
      id,
      baseline,
      changes: schema.roots.map((root) => ({
        root: root.key,
        previous,
        after: root.digest,
        decision,
      })),
    },
    snapshot: schema,
  };
}

const BASE_ID = '2026-09-11-baseline';
const NEXT_ID = '2026-09-11-change';
const COMPATIBLE_ID = '2026-09-19-compatible';
const FUTURE_ID = '2026-09-19-future';

/** 帶 `surfaceOp` 的事件根：nexus 沒有 surface 那一軸，這裡只用來驗嚴格解析器的事件 metadata 檢查。 */
function surfaceEvent(
  operation: 'required' | 'optional' | 'absent',
  event = 'example/value',
): PersistenceSchemaInventory {
  const nodes: SchemaNode[] = [
    {
      kind: 'object',
      indices: [],
      properties: [
        { name: 'type', type: 1, optional: false },
        ...(operation === 'absent'
          ? []
          : [{ name: 'surfaceOp', type: 2, optional: operation === 'optional' }]),
      ],
    },
    { kind: 'literal', value: event },
    { kind: 'primitive', type: 'string' },
  ];
  const schema = canonicalizeSchema(nodes, 0);
  return {
    formatVersion: 1,
    types: [],
    roots: [
      {
        key: 'event:example/value',
        kind: 'event',
        event: 'example/value',
        surface: true,
        schema,
        digest: schemaDigest(schema),
      },
    ],
  };
}

function contents(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const visit = (directory: string): void => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const path = posix.join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else files[path] = readFileSync(join(root, path), 'utf8');
    }
  };
  visit('');
  return files;
}

function onlyEvent(schema: PersistenceSchemaInventory): PersistenceSchemaInventory {
  return { ...schema, roots: schema.roots.filter((root) => root.kind === 'event') };
}

function finishDocuments(root: string, id: string): void {
  const path = join(root, PERSISTENCE_HISTORY_DIRECTORY, `${id}.md`);
  writeFileSync(
    path,
    readFileSync(path, 'utf8')
      .replaceAll('TODO: explain this change.', '選填的酬載中繼資料保留原本記下的值。')
      .replaceAll('TODO: record validation evidence.', '針對性的持久化歷史測試通過。'),
  );
}

function commitCurrent(root: string, schema: PersistenceSchemaInventory): void {
  writeFileSync(join(root, PERSISTENCE_SCHEMA_PATH), JSON.stringify(schema, null, 2) + '\n');
}

function baseline(root: string, schema = inventory()): void {
  runPersistenceChanges(['--baseline', BASE_ID], root, () => schema);
  finishDocuments(root, BASE_ID);
  commitCurrent(root, schema);
}

function unionBody(arms: readonly (readonly SchemaProperty[])[]): PersistenceRoot {
  const nodes: SchemaNode[] = [
    { kind: 'object', indices: [], properties: [{ name: 'data', type: 1, optional: false }] },
    { kind: 'union', types: arms.map((_, index) => 5 + index) },
    { kind: 'primitive', type: 'string' },
    { kind: 'primitive', type: 'number' },
    { kind: 'primitive', type: 'boolean' },
    ...arms.map((properties) => ({ kind: 'object' as const, indices: [], properties })),
  ];
  const schema = canonicalizeSchema(nodes, 0);
  return { ...typeRoot('event:example/value', {}), schema, digest: schemaDigest(schema) };
}

function versionedEvent(
  variants: readonly { version: number; mode: string; extra?: boolean }[],
): PersistenceRoot {
  const nodes: SchemaNode[] = [
    {
      kind: 'object',
      indices: [],
      properties: [
        { name: 'data', type: variants.length === 1 ? 3 : 1, optional: false },
        { name: 'type', type: 3 + variants.length * 3, optional: false },
      ],
    },
    { kind: 'union', types: variants.map((_, index) => 3 + index * 3) },
    { kind: 'primitive', type: 'string' },
  ];
  for (const variant of variants) {
    const index = nodes.length;
    nodes.push(
      {
        kind: 'object',
        indices: [],
        properties: [
          { name: 'version', type: index + 1, optional: false },
          { name: 'mode', type: index + 2, optional: false },
          ...(variant.extra ? [{ name: 'extra', type: 2, optional: false }] : []),
        ],
      },
      { kind: 'literal', value: variant.version },
      { kind: 'literal', value: variant.mode },
    );
  }
  nodes.push({ kind: 'literal', value: 'example/value' });
  const schema = canonicalizeSchema(nodes, 0);
  return { ...typeRoot('event:example/value', {}), schema, digest: schemaDigest(schema) };
}

describe('嚴格解析器的事件 metadata', () => {
  it('宣告位置帶行號照收（dsh 只在歷史格式拒收）', () => {
    const snapshot = surfaceEvent('required');
    const root = snapshot.roots[0]!;
    for (const suffix of [':8', ':8:3', '#L8', '#L8-L12']) {
      const complete = {
        ...snapshot,
        types: [
          {
            schema: root.schema,
            digest: root.digest,
            names: [],
            sources: [`packages/example/src/types.ts${suffix}`],
          },
        ],
      };
      expect(parsePersistenceSnapshot(complete)).toEqual(complete);
    }
  });

  it('surface 事件要有必填的 surfaceOp；非 surface 事件不能有', () => {
    expect(() => parsePersistenceSnapshot(surfaceEvent('optional'))).toThrow('surface metadata');
    expect(() => parsePersistenceSnapshot(surfaceEvent('absent'))).toThrow('surface metadata');
    expect(parsePersistenceSnapshot(surfaceEvent('required'))).toEqual(surfaceEvent('required'));
    const snapshot = surfaceEvent('required');
    expect(() =>
      parsePersistenceSnapshot({
        ...snapshot,
        roots: snapshot.roots.map((root) => ({ ...root, surface: false })),
      }),
    ).toThrow('surface metadata');
  });

  it('事件標籤、根的鍵與 header 的名字對不上就拒', () => {
    expect(() => parsePersistenceSnapshot(surfaceEvent('required', 'wrong/tag'))).toThrow(
      'type does not match',
    );
    const snapshot = surfaceEvent('required');
    expect(() =>
      parsePersistenceSnapshot({
        ...snapshot,
        roots: snapshot.roots.map((root) => ({ ...root, key: 'event:wrong/key' })),
      }),
    ).toThrow('invalid event root key');
    // nexus 沒有 JsonlHeaderLine 這個根（見 persistence-schema.ts 檔頭）。
    const header = { ...typeRoot('SessionHeader', { id: 'string' }), key: 'JsonlHeaderLine' };
    expect(() =>
      parsePersistenceSnapshot({ formatVersion: 1, types: [], roots: [header] }),
    ).toThrow('invalid schema root JsonlHeaderLine');
  });
});

describe('從基線起算的同版紀錄', () => {
  it('只改型別名、宣告位置與根的順序，不必寫紀錄', () => {
    const root = fixture();
    const current = inventory({ value: 'number' });
    baseline(root, current);
    const metadata = {
      ...current,
      roots: [...current.roots].reverse(),
      types: [
        {
          ...current.roots[2]!,
          names: ['RenamedAlias'],
          sources: ['packages/example/src/types.ts:99'],
        },
      ].map(({ schema, digest, names, sources }) => ({ schema, digest, names, sources })),
    };
    commitCurrent(root, metadata);
    expect(runPersistenceChanges(['--check'], root, () => metadata)).toContain('roots match');
  });

  it.each(['optional field', 'ordinary event'] as const)('%s 經一筆新的同版紀錄放行', (kind) => {
    const root = fixture();
    const current = inventory({ value: 'number' });
    baseline(root, current);
    const after =
      kind === 'ordinary event'
        ? { ...current, roots: [...current.roots, typeRoot('event:example/new', {})] }
        : inventory({ value: 'number', 'label?': 'string' });
    const before = contents(root);
    commitCurrent(root, after);
    expect(() => verifyPersistenceChanges(root, after)).toThrow(
      'unacknowledged persistence type changes',
    );
    runPersistenceChanges(
      ['--record', COMPATIBLE_ID, '--prose', proseFile(root)],
      root,
      () => after,
    );
    expect(runPersistenceChanges(['--check'], root, () => after)).toContain('roots match');
    const history = loadPersistenceHistory(root);
    expect(
      history.entries.find((entry) => entry.record.id === COMPATIBLE_ID)?.record.changes,
    ).toEqual([expect.objectContaining({ decision: 'same-version' })]);
    for (const [path, value] of Object.entries(before).filter(([path]) =>
      path.startsWith(`${PERSISTENCE_HISTORY_DIRECTORY}/`),
    )) {
      expect(readFileSync(join(root, path), 'utf8')).toBe(value);
    }
  });

  it.each(['required field', 'changed type'] as const)(
    '%s 在產生或寫檔之前就要求明確決定',
    (kind) => {
      const root = fixture();
      baseline(root, inventory({ value: 'number' }));
      const after = inventory(
        kind === 'required field' ? { value: 'number', label: 'string' } : { value: 'boolean' },
      );
      const before = contents(root);
      let rendered = false;
      const result = JSON.parse(
        executePersistenceChanges(
          ['--record', FUTURE_ID, '--json'],
          root,
          () => after,
          () => {
            rendered = true;
            return [];
          },
        ),
      ) as { ok: boolean; code: string; changes: PersistenceTypeChange[] };
      expect(result).toMatchObject({ ok: false, code: 'decision-required' });
      expect(result.changes.length).toBeGreaterThan(0);
      expect(result.changes.some((change) => change.requiresCompatibilityReview)).toBe(true);
      expect(rendered).toBe(false);
      expect(contents(root)).toEqual(before);
      commitCurrent(root, after);
      expect(() => verifyPersistenceChanges(root, after)).toThrow(
        'unacknowledged persistence type changes',
      );
    },
  );

  it('末端紀錄可以再更新；改了既有的選填欄位要明確決定', () => {
    const root = fixture();
    baseline(root, inventory({ value: 'number' }));
    const first = inventory({ value: 'number', 'label?': 'string' });
    runPersistenceChanges(
      ['--record', COMPATIBLE_ID, '--prose', proseFile(root)],
      root,
      () => first,
    );
    const amended = inventory({ value: 'number', 'label?': 'string', 'extra?': 'boolean' });
    runPersistenceChanges(['--update', COMPATIBLE_ID], root, () => amended);
    expect(runPersistenceChanges(['--check'], root, () => amended)).toContain('roots match');
    const breaking = inventory({ value: 'number', 'label?': 'number', 'extra?': 'boolean' });
    const accepted = inventory({ value: 'number' }).roots[2]!;
    expect(
      classifyPersistenceChange(accepted, breaking.roots[2]!).every(
        (change) => !change.requiresCompatibilityReview,
      ),
    ).toBe(true);
    const before = contents(root);
    expect(() =>
      runPersistenceChanges(
        ['--record', '2026-09-20-breaking', '--prose', proseFile(root)],
        root,
        () => breaking,
      ),
    ).toThrow('--decision');
    expect(contents(root)).toEqual(before);
  });

  it('升版的轉換不動既有紀錄；之後同版的結構變更照樣要明確決定', () => {
    const root = fixture();
    baseline(root, inventory({ value: 'number' }, 4));
    const before = contents(root);
    const after = inventory({ value: 'boolean' }, 5);
    runPersistenceChanges(['--record', FUTURE_ID, '--prose', proseFile(root)], root, () => after);
    expect(runPersistenceChanges(['--check'], root, () => after)).toContain('roots match');
    for (const [path, value] of Object.entries(before).filter(([path]) =>
      path.startsWith(`${PERSISTENCE_HISTORY_DIRECTORY}/`),
    )) {
      expect(readFileSync(join(root, path), 'utf8')).toBe(value);
    }
    const later = inventory({ value: 'string' }, 5);
    expect(() =>
      runPersistenceChanges(
        ['--record', '2026-09-20-without-version', '--prose', proseFile(root)],
        root,
        () => later,
      ),
    ).toThrow('--decision');
  });
});

describe('持久化變更的分類', () => {
  it.each([1, 2])('事件酬載加一個更高的版本、保留 %s 個舊分支，同版放行', (count) => {
    const root = fixture();
    const variants = [
      { version: 0, mode: 'one-shot' },
      { version: 0, mode: 'continuable' },
    ].slice(0, count);
    const oldEvent = versionedEvent(variants);
    const nextEvent = versionedEvent([...variants, { version: 1, mode: 'unknown', extra: true }]);
    const before = {
      ...inventory({}, 4),
      roots: [...inventory({}, 4).roots.filter((root) => root.kind !== 'event'), oldEvent],
    };
    baseline(root, before);
    const after = {
      ...before,
      roots: before.roots.map((root) => (root.kind === 'event' ? nextEvent : root)),
    };
    expect(classifyPersistenceChange(oldEvent, nextEvent)).toEqual([
      expect.objectContaining({
        kind: 'payload-version-added',
        requiresCompatibilityReview: false,
      }),
    ]);
    runPersistenceChanges(
      ['--record', COMPATIBLE_ID, '--prose', proseFile(root)],
      root,
      () => after,
    );
    verifyPersistenceChanges(root, after);
  });

  it('改舊酬載、缺版本、版本沒變高、拿掉舊讀方都要審查', () => {
    const variants = [
      { version: 0, mode: 'one-shot' },
      { version: 0, mode: 'continuable' },
    ];
    const before = versionedEvent(variants);
    for (const after of [
      versionedEvent([...variants, { version: 0, mode: 'unknown' }]),
      versionedEvent([...variants, { version: -1, mode: 'unknown' }]),
      versionedEvent([...variants, { version: 0.5, mode: 'unknown' }]),
      versionedEvent([
        { version: 0, mode: 'one-shot', extra: true },
        variants[1]!,
        { version: 1, mode: 'unknown' },
      ]),
      versionedEvent([{ version: 1, mode: 'unknown' }]),
    ])
      expect(
        classifyPersistenceChange(before, after).some(
          (change) => change.requiresCompatibilityReview,
        ),
      ).toBe(true);
    const expanded = versionedEvent([...variants, { version: 1, mode: 'unknown' }]);
    expect(
      classifyPersistenceChange(expanded, before).some(
        (change) => change.requiresCompatibilityReview,
      ),
    ).toBe(true);
    expect(
      classifyPersistenceChange({ ...before, surface: true }, { ...expanded, surface: true }).some(
        (change) => change.requiresCompatibilityReview,
      ),
    ).toBe(true);
    expect(
      classifyPersistenceChange(
        { ...before, kind: 'header' },
        { ...expanded, kind: 'header' },
      ).some((change) => change.requiresCompatibilityReview),
    ).toBe(true);
    const unversioned = unionBody([[{ name: 'mode', type: 2, optional: false }]]);
    expect(
      classifyPersistenceChange(unversioned, expanded).some(
        (change) => change.requiresCompatibilityReview,
      ),
    ).toBe(true);
  });

  it('新增的選填子樹算一處新增，裡面有必填欄位也一樣', () => {
    const before = typeRoot('event:example/value', { value: 'string' });
    const after = typeRoot('event:example/value', {
      value: 'string',
      'details?': { name: 'string', count: 'number' },
    });
    expect(classifyPersistenceChange(before, after)).toEqual([
      {
        path: 'event:example/value.data.details',
        kind: 'optional-property-added',
        description: 'optional property added',
        requiresCompatibilityReview: false,
      },
    ]);
  });

  it('酬載的必填改選填放行；反方向、改型別、刪欄位都要審查', () => {
    const required = typeRoot('event:example/value', { value: 'string' });
    const optional = typeRoot('event:example/value', { 'value?': 'string' });
    expect(
      classifyPersistenceChange(required, optional).every(
        (change) => !change.requiresCompatibilityReview,
      ),
    ).toBe(true);
    for (const after of [
      required,
      typeRoot('event:example/value', { 'value?': 'number' }),
      typeRoot('event:example/value', {}),
    ]) {
      expect(
        classifyPersistenceChange(optional, after).some(
          (change) => change.requiresCompatibilityReview,
        ),
      ).toBe(true);
    }
  });

  it('共用酬載加選填欄位時，有判別欄位的多個聯集分支照樣配得上', () => {
    function unionRoot(optional: boolean): PersistenceRoot {
      const nodes: SchemaNode[] = [
        { kind: 'object', indices: [], properties: [{ name: 'data', type: 1, optional: false }] },
        { kind: 'union', types: [2, 3] },
        {
          kind: 'object',
          indices: [],
          properties: [
            { name: 'kind', type: 4, optional: false },
            { name: 'payload', type: 6, optional: false },
          ],
        },
        {
          kind: 'object',
          indices: [],
          properties: [
            { name: 'kind', type: 5, optional: false },
            { name: 'payload', type: 6, optional: false },
          ],
        },
        { kind: 'literal', value: 'left' },
        { kind: 'literal', value: 'right' },
        {
          kind: 'object',
          indices: [],
          properties: [
            { name: 'value', type: 7, optional: false },
            ...(optional ? [{ name: 'label', type: 7, optional: true }] : []),
          ],
        },
        { kind: 'primitive', type: 'string' },
      ];
      const schema = canonicalizeSchema(nodes, 0);
      return { ...typeRoot('event:example/value', {}), schema, digest: schemaDigest(schema) };
    }
    const differences = classifyPersistenceChange(unionRoot(false), unionRoot(true));
    expect(differences.length).toBeGreaterThan(0);
    expect(differences.every((change) => !change.requiresCompatibilityReview)).toBe(true);
  });

  it('沒有判別欄位的聯集分支各加選填欄位，放行', () => {
    const first = [{ name: 'a', type: 2, optional: false }];
    const second = [{ name: 'b', type: 3, optional: false }];
    const extra = { name: 'x', type: 4, optional: true };
    const differences = classifyPersistenceChange(
      unionBody([first, second]),
      unionBody([
        [...first, extra],
        [...second, extra],
      ]),
    );
    expect(differences).toEqual([
      expect.objectContaining({
        path: 'event:example/value.data.x',
        requiresCompatibilityReview: false,
      }),
    ]);
  });

  it('沒有判別欄位的聯集分支必填改選填，放行', () => {
    const before = unionBody([
      [{ name: 'a', type: 2, optional: false }],
      [{ name: 'b', type: 3, optional: false }],
    ]);
    const after = unionBody([
      [{ name: 'a', type: 2, optional: true }],
      [{ name: 'b', type: 3, optional: true }],
    ]);
    const differences = classifyPersistenceChange(before, after);
    expect(differences.map((change) => change.path).sort()).toEqual([
      'event:example/value.data.a',
      'event:example/value.data.b',
    ]);
    expect(
      differences.every(
        (change) => change.kind === 'property-made-optional' && !change.requiresCompatibilityReview,
      ),
    ).toBe(true);
  });

  it('一個分支有多個可新增的後繼時，找完整的配對', () => {
    const required = [{ name: 'a', type: 2, optional: false }];
    const optional = [{ name: 'a', type: 2, optional: true }];
    const flexible = [{ name: '0', type: 4, optional: true }, ...optional];
    const constrained = [...required, { name: 'z', type: 4, optional: true }];
    const before = unionBody([required, optional]);
    for (const after of [unionBody([flexible, constrained]), unionBody([constrained, flexible])]) {
      const differences = classifyPersistenceChange(before, after);
      expect(differences.length).toBeGreaterThan(0);
      expect(differences.every((change) => !change.requiresCompatibilityReview)).toBe(true);
    }
    const noCompleteMatching = unionBody([
      flexible,
      [{ name: 'different', type: 4, optional: true }],
    ]);
    expect(
      classifyPersistenceChange(before, noCompleteMatching).some(
        (change) => change.requiresCompatibilityReview,
      ),
    ).toBe(true);
  });

  it('聯集分支數、刪欄位、新必填欄位與值的型別一律嚴格', () => {
    const first = [{ name: 'a', type: 2, optional: false }];
    const second = [{ name: 'b', type: 3, optional: false }];
    const third = [{ name: 'c', type: 4, optional: false }];
    const before = unionBody([first, second]);
    const variants = [
      unionBody([first, second, third]),
      unionBody([first]),
      unionBody([first, third]),
      unionBody([
        [...first, { name: 'x', type: 4, optional: false }],
        [...second, { name: 'x', type: 4, optional: true }],
      ]),
      unionBody([
        [{ name: 'a', type: 3, optional: true }],
        [{ name: 'b', type: 3, optional: true }],
      ]),
    ];
    for (const after of variants) {
      expect(
        classifyPersistenceChange(before, after).some(
          (change) => change.requiresCompatibilityReview,
        ),
      ).toBe(true);
    }
  });

  it('遞迴的聯集分支逐一檢查，不留下候選之間的暫時成功', () => {
    const next = { name: 'next', type: 1, optional: true };
    const first = [{ name: 'a', type: 2, optional: false }, next];
    const second = [{ name: 'b', type: 3, optional: false }, next];
    const extra = { name: 'x', type: 4, optional: true };
    const before = unionBody([first, second]);
    const additive = unionBody([
      [...first, extra],
      [...second, extra],
    ]);
    expect(
      classifyPersistenceChange(before, additive).every(
        (change) => !change.requiresCompatibilityReview,
      ),
    ).toBe(true);
    const invalid = unionBody([
      [...first, extra],
      [{ name: 'b', type: 2, optional: false }, next, extra],
    ]);
    expect(
      classifyPersistenceChange(before, invalid).some(
        (change) => change.requiresCompatibilityReview,
      ),
    ).toBe(true);
    expect(
      classifyPersistenceChange(invalid, before).some(
        (change) => change.requiresCompatibilityReview,
      ),
    ).toBe(true);
  });

  it('陣列與 tuple 裡照樣算酬載範圍；同時改值的型別就要審查', () => {
    function wrapped(
      optional: boolean,
      primitive: 'string' | 'number' = 'string',
    ): PersistenceRoot {
      const nodes: SchemaNode[] = [
        { kind: 'object', indices: [], properties: [{ name: 'data', type: 1, optional: false }] },
        { kind: 'tuple', elements: [{ type: 2, optional: false, rest: false }] },
        { kind: 'array', element: 3 },
        { kind: 'object', indices: [], properties: [{ name: 'value', type: 4, optional }] },
        { kind: 'primitive', type: primitive },
      ];
      const schema = canonicalizeSchema(nodes, 0);
      return { ...typeRoot('event:example/value', {}), schema, digest: schemaDigest(schema) };
    }
    expect(
      classifyPersistenceChange(wrapped(false), wrapped(true)).every(
        (change) => !change.requiresCompatibilityReview,
      ),
    ).toBe(true);
    expect(
      classifyPersistenceChange(wrapped(false), wrapped(true, 'number')).some(
        (change) => change.requiresCompatibilityReview,
      ),
    ).toBe(true);
  });

  it('header／封裝的選填欄位與 surface 事件的新增一律嚴格', () => {
    for (const key of ['SessionHeader', 'SessionEventEnvelope']) {
      expect(
        classifyPersistenceChange(typeRoot(key, {}), typeRoot(key, { 'metadata?': 'string' }))[0]
          ?.requiresCompatibilityReview,
      ).toBe(true);
    }
    const added = typeRoot('event:example/added', { value: 'string' });
    expect(classifyPersistenceChange(null, added)[0]?.requiresCompatibilityReview).toBe(false);
    expect(
      classifyPersistenceChange(null, { ...added, surface: true })[0]?.requiresCompatibilityReview,
    ).toBe(true);
    expect(classifyPersistenceChange(added, null)[0]?.requiresCompatibilityReview).toBe(true);
  });
});

describe('紀錄歷史的驗證', () => {
  it('接受基線與後繼的選填新增，不拿歷史上的型別圖去比目前的原始碼', () => {
    const before = inventory();
    const after = inventory({ value: 'string', 'label?': 'string' });
    const history = validatePersistenceHistory([
      entry(BASE_ID, before, null, true),
      entry(NEXT_ID, onlyEvent(after), BASE_ID),
    ]);
    expect(history.tips.get('event:example/value')?.root?.digest).toBe(after.roots[2]?.digest);
    expect(history.tips.get('SessionHeader')?.id).toBe(BASE_ID);
  });

  it('拒收缺前驅、分叉、成環、重複與沒有基線', () => {
    const base = entry(BASE_ID, inventory(), null, true);
    const next = entry(
      NEXT_ID,
      onlyEvent(inventory({ value: 'string', 'label?': 'string' })),
      BASE_ID,
    );
    expect(() => validatePersistenceHistory([next])).toThrow('exactly one baseline');
    expect(() =>
      validatePersistenceHistory([base, entry(NEXT_ID, next.snapshot, '2026-09-11-missing')]),
    ).toThrow('missing predecessor');
    expect(() =>
      validatePersistenceHistory([base, next, entry('2026-09-11-fork', next.snapshot, BASE_ID)]),
    ).toThrow('forked');
    expect(() => validatePersistenceHistory([base, base])).toThrow('exactly one baseline');
    const cycle = entry(
      '2026-09-11-cycle',
      { ...next.snapshot, roots: [typeRoot('event:cycle/event', {})] },
      '2026-09-11-cycle',
    );
    expect(() => validatePersistenceHistory([base, cycle])).toThrow('cycle');
  });

  it('version-bump 綁在同一筆紀錄自己的 header 版號遞增上', () => {
    const base = entry(BASE_ID, inventory(), null, true);
    const breaking = inventory({ value: 'number' }, 4);
    expect(
      validatePersistenceHistory([base, entry(NEXT_ID, onlyEvent(breaking), BASE_ID)]).tips.get(
        'event:example/value',
      )?.id,
    ).toBe(NEXT_ID);
    expect(() =>
      validatePersistenceHistory([
        base,
        entry(NEXT_ID, onlyEvent(breaking), BASE_ID, false, 'version-bump'),
      ]),
    ).toThrow("this record's own");
    const touched = {
      ...breaking,
      roots: breaking.roots.filter((root) => root.key === 'SessionHeader' || root.kind === 'event'),
    };
    expect(
      validatePersistenceHistory([
        base,
        entry(NEXT_ID, touched, BASE_ID, false, 'version-bump'),
      ]).tips.get('SessionHeader')?.id,
    ).toBe(NEXT_ID);
    const later = entry(
      '2026-09-11-later',
      onlyEvent(inventory({ value: 'boolean' }, 4)),
      NEXT_ID,
      false,
      'version-bump',
    );
    expect(() =>
      validatePersistenceHistory([
        base,
        entry(NEXT_ID, touched, BASE_ID, false, 'version-bump'),
        later,
      ]),
    ).toThrow("this record's own");
  });

  it('刪除留下墓碑，重新加回的根要接在墓碑後面', () => {
    const base = entry(BASE_ID, inventory(), null, true);
    const after = inventory({}, 4);
    const header = after.roots[0]!;
    const record: PersistenceChangeRecord = {
      schemaVersion: 1,
      id: NEXT_ID,
      baseline: false,
      changes: [
        {
          root: 'SessionHeader',
          previous: BASE_ID,
          after: header.digest,
          decision: 'version-bump',
        },
        { root: 'event:example/value', previous: BASE_ID, after: null, decision: 'version-bump' },
      ],
    };
    const deletion = { record, snapshot: { ...after, roots: [header] } };
    expect(
      validatePersistenceHistory([base, deletion]).tips.get('event:example/value')?.root,
    ).toBeNull();
    const restored = entry('2026-09-11-restore', onlyEvent(inventory()), NEXT_ID);
    expect(
      validatePersistenceHistory([base, deletion, restored]).tips.get('event:example/value')?.id,
    ).toBe(restored.record.id);
    expect(() =>
      validatePersistenceHistory([
        base,
        deletion,
        entry('2026-09-11-restore', restored.snapshot, null),
      ]),
    ).toThrow('forked');
  });

  it('拒收壞參照、不認得的節點、竄改過的指紋與多出來的快照根', () => {
    const schema = inventory();
    const malformed: {
      roots: readonly { schema: { nodes: readonly unknown[] }; digest: string }[];
    } = structuredClone(schema);
    malformed.roots[0]!.schema.nodes = [{ kind: 'array', element: 99 }];
    expect(() => parsePersistenceSnapshot(malformed)).toThrow('unknown schema node');
    malformed.roots[0]!.schema.nodes = [{ kind: 'future' }];
    expect(() => parsePersistenceSnapshot(malformed)).toThrow('unknown schema node kind');
    const tampered = structuredClone(schema);
    Object.assign(tampered.roots[0]!, { digest: '0'.repeat(64) });
    expect(() => parsePersistenceSnapshot(tampered)).toThrow('digest mismatch');
    // nexus 只有 formatVersion 1：2 是 dsh 的來源政策版本（過渡，#1883）。
    for (const formatVersion of [2, 3])
      expect(() => parsePersistenceSnapshot({ ...schema, formatVersion })).toThrow(
        'normalization version',
      );
    const next = entry(
      NEXT_ID,
      onlyEvent(inventory({ value: 'string', 'label?': 'string' })),
      BASE_ID,
    );
    expect(() =>
      validatePersistenceHistory([
        entry(BASE_ID, schema, null, true),
        { ...next, snapshot: inventory() },
      ]),
    ).toThrow('snapshot roots');
  });
});

describe('對目前目錄的命令', () => {
  it('紀錄要寫完說明、生成物過期就拒、沒寫紀錄的路徑要列出來', () => {
    const root = fixture();
    const before = inventory();
    runPersistenceChanges(['--baseline', BASE_ID], root, () => before);
    expect(() => loadPersistenceHistory(root)).toThrow('complete compatibility');
    finishDocuments(root, BASE_ID);
    rmSync(join(root, PERSISTENCE_SCHEMA_PATH));
    expect(() => verifyPersistenceChanges(root, before)).toThrow('is missing');
    commitCurrent(root, before);
    const after = inventory({ value: 'string', 'label?': 'string' });
    expect(() => verifyPersistenceChanges(root, after)).toThrow('is stale');
    commitCurrent(root, after);
    expect(() => verifyPersistenceChanges(root, after)).toThrow(
      'event:example/value.data.label: optional property added (same-version allowed)',
    );
    runPersistenceChanges(['--record', NEXT_ID, '--decision', 'same-version'], root, () => after);
    finishDocuments(root, NEXT_ID);
    expect(runPersistenceChanges([], root, () => after)).toContain(
      '3 roots match 2 history records',
    );
    expect(() =>
      runPersistenceChanges(['--baseline', '2026-09-11-reset'], root, () => after),
    ).toThrow('cannot reset history');
    expect(() =>
      runPersistenceChanges(
        ['--record', '2026-09-11-empty', '--decision', 'same-version'],
        root,
        () => after,
      ),
    ).toThrow('no persistence type changes');
  });

  it('沒被紀錄引用的快照就拒', () => {
    const root = fixture();
    baseline(root);
    writeFileSync(
      join(root, PERSISTENCE_HISTORY_DIRECTORY, '2026-09-11-orphan.schema.json'),
      '{}\n',
    );
    expect(() => loadPersistenceHistory(root)).toThrow('unreferenced');
  });

  it('子目錄裡的文件與快照不算紀錄', () => {
    const root = fixture();
    baseline(root);
    const directory = join(root, PERSISTENCE_HISTORY_DIRECTORY, 'historical-formats');
    mkdirSync(directory);
    writeFileSync(join(directory, 'v0.md'), '---\nkind: persistence-format\n---\n');
    writeFileSync(join(directory, 'v0.schema.json'), '{}\n');
    expect(loadPersistenceHistory(root).entries.map((entry) => entry.record.id)).toEqual([BASE_ID]);
  });

  it.each([
    ['optional field', inventory({ value: 'string', 'label?': 'string' })],
    ['required-to-optional field', inventory({ 'value?': 'string' })],
    [
      'ordinary event addition',
      {
        ...inventory(),
        roots: [...inventory().roots, typeRoot('event:example/added', { count: 'number' })],
      },
    ],
  ] as const)('%s 推定為同版', (_name, after) => {
    const root = fixture();
    baseline(root);
    runPersistenceChanges(['--record', NEXT_ID, '--prose', proseFile(root)], root, () => after);
    const changes = loadPersistenceHistory(root).entries.find(
      (entry) => entry.record.id === NEXT_ID,
    )?.record.changes;
    expect(changes?.length).toBeGreaterThan(0);
    expect(changes?.every((change) => change.decision === 'same-version')).toBe(true);
    verifyPersistenceChanges(root, after);
  });

  it('原始碼自己帶著 header 版號遞增時，推定為升版', () => {
    const root = fixture();
    baseline(root);
    const after = inventory({ value: 'number' }, 4);
    runPersistenceChanges(['--record', NEXT_ID, '--prose', proseFile(root)], root, () => after);
    const changes = loadPersistenceHistory(root).entries.find(
      (entry) => entry.record.id === NEXT_ID,
    )?.record.changes;
    expect(changes?.map((change) => change.root).sort()).toEqual([
      'SessionHeader',
      'event:example/value',
    ]);
    expect(changes?.every((change) => change.decision === 'version-bump')).toBe(true);
    verifyPersistenceChanges(root, after);
  });

  it('結構變更在寫檔之前就要求明確決定', () => {
    const root = fixture();
    baseline(root);
    const prose = proseFile(root);
    const directory = join(root, PERSISTENCE_HISTORY_DIRECTORY);
    const files = readdirSync(directory).sort();
    const inventoryPath = join(root, PERSISTENCE_SCHEMA_PATH);
    const before = readFileSync(inventoryPath, 'utf8');
    const result = jsonResult(
      runPersistenceChanges(['--record', NEXT_ID, '--prose', prose, '--json'], root, () =>
        inventory({ value: 'number' }),
      ),
    );
    expect(result).toMatchObject({
      ok: false,
      code: 'decision-required',
      files: [],
      changes: [expect.objectContaining({ requiresCompatibilityReview: true })],
    });
    expect(readFileSync(inventoryPath, 'utf8')).toBe(before);
    expect(readdirSync(directory).sort()).toEqual(files);
    expect(
      jsonResult(
        runPersistenceChanges(
          ['--record', NEXT_ID, '--decision', 'same-version', '--prose', prose, '--json'],
          root,
          () => inventory({ value: 'number' }),
        ),
      ).ok,
    ).toBe(true);
  });

  it('從明寫的說明寫出完整紀錄；生成物過期時照樣回報原始碼的變更', () => {
    const root = fixture();
    baseline(root);
    const after = inventory({ value: 'string', 'label?': 'string' });
    const pending = jsonResult(runPersistenceChanges(['--check', '--json'], root, () => after));
    expect(pending).toMatchObject({
      ok: false,
      operation: 'check',
      code: 'stale-artifacts',
      roots: [
        {
          root: 'event:example/value',
          kind: 'event',
          before: inventory().roots[2]?.digest,
          after: after.roots[2]?.digest,
        },
      ],
      changes: [
        {
          root: 'event:example/value',
          path: 'event:example/value.data.label',
          kind: 'optional-property-added',
          requiresCompatibilityReview: false,
        },
      ],
    });
    const written = jsonResult(
      runPersistenceChanges(
        ['--record', NEXT_ID, '--decision', 'same-version', '--prose', proseFile(root), '--json'],
        root,
        () => after,
      ),
    );
    expect(written).toMatchObject({ ok: true, operation: 'record', recordId: NEXT_ID });
    expect(written.files).toEqual([
      PERSISTENCE_SCHEMA_PATH,
      `${PERSISTENCE_HISTORY_DIRECTORY}/${NEXT_ID}.md`,
      `${PERSISTENCE_HISTORY_DIRECTORY}/${NEXT_ID}.schema.json`,
    ]);
    expect(written).toMatchObject({
      roots: [
        {
          root: 'event:example/value',
          kind: 'event',
          before: inventory().roots[2]?.digest,
          after: after.roots[2]?.digest,
        },
      ],
    });
    expect(
      readFileSync(join(root, `${PERSISTENCE_HISTORY_DIRECTORY}/${NEXT_ID}.md`), 'utf8'),
    ).toContain(AUTHORED_PROSE.compatibility);
    expect(jsonResult(runPersistenceChanges(['--check', '--json'], root, () => after)).ok).toBe(
      true,
    );
  });

  it('只能更新末端的紀錄，作者寫的說明與前驅照留', () => {
    const root = fixture();
    baseline(root);
    const after = inventory({ value: 'string', 'label?': 'string' });
    const prose = proseFile(root);
    runPersistenceChanges(
      ['--record', NEXT_ID, '--decision', 'same-version', '--prose', prose],
      root,
      () => after,
    );
    const path = join(root, `${PERSISTENCE_HISTORY_DIRECTORY}/${NEXT_ID}.md`);
    const beforeText = readFileSync(path, 'utf8');
    const refreshed = inventory({ value: 'string', 'label?': 'string', 'extra?': 'number' });
    runPersistenceChanges(['--update', NEXT_ID], root, () => refreshed);
    const stripRecord = (value: string): string =>
      value.replace(/```yaml persistence-change[\s\S]*?```/u, '');
    expect(stripRecord(readFileSync(path, 'utf8'))).toBe(stripRecord(beforeText));
    expect(loadPersistenceHistory(root).tips.get('event:example/value')?.id).toBe(NEXT_ID);
    expect(
      loadPersistenceHistory(root).entries.find((entry) => entry.record.id === NEXT_ID)?.record
        .changes[0]?.previous,
    ).toBe(BASE_ID);
    expect(jsonResult(runPersistenceChanges(['--check', '--json'], root, () => refreshed)).ok).toBe(
      true,
    );
    const final = inventory({
      value: 'string',
      'label?': 'string',
      'extra?': 'number',
      'last?': 'boolean',
    });
    runPersistenceChanges(
      ['--record', '2026-09-11-successor', '--decision', 'same-version', '--prose', prose],
      root,
      () => final,
    );
    expect(() =>
      runPersistenceChanges(['--update', NEXT_ID, '--decision', 'same-version'], root, () => final),
    ).toThrow('with successors');
    expect(() =>
      runPersistenceChanges(['--update', BASE_ID, '--decision', 'same-version'], root, () => final),
    ).toThrow('cannot update the persistence baseline');
  });

  it('用 --update 把草稿補完；說明或決定不合格時一個檔都不動', () => {
    const root = fixture();
    baseline(root);
    const after = inventory({ value: 'number' });
    const draft = runPersistenceChanges(
      ['--record', NEXT_ID, '--decision', 'same-version'],
      root,
      () => after,
    );
    expect(draft).toContain(`--update ${NEXT_ID} --decision same-version --prose FILE`);
    const prose = proseFile(root);
    runPersistenceChanges(
      ['--update', NEXT_ID, '--decision', 'same-version', '--prose', prose],
      root,
      () => after,
    );
    expect(runPersistenceChanges(['--check'], root, () => after)).toContain('roots match');
    const path = join(root, `${PERSISTENCE_HISTORY_DIRECTORY}/${NEXT_ID}.md`);
    expect(readFileSync(path, 'utf8')).not.toContain('TODO:');
    const completed = readFileSync(path, 'utf8');
    runPersistenceChanges(
      ['--update', NEXT_ID, '--decision', 'same-version', '--prose', prose],
      root,
      () => after,
    );
    expect(readFileSync(path, 'utf8')).toBe(completed);
    const before = readFileSync(path, 'utf8');
    const invalid = inventory({ value: 'boolean' });
    const result = jsonResult(
      runPersistenceChanges(['--update', NEXT_ID, '--json'], root, () => invalid),
    );
    expect(result).toMatchObject({
      ok: false,
      code: 'decision-required',
      changes: [
        expect.objectContaining({ kind: 'type-changed', requiresCompatibilityReview: true }),
      ],
    });
    expect(readFileSync(path, 'utf8')).toBe(before);
    for (const value of [
      { ...AUTHORED_PROSE, extra: 'unsupported' },
      { ...AUTHORED_PROSE, compatibility: '   ' },
      { ...AUTHORED_PROSE, verification: 'TODO: record validation evidence.' },
    ]) {
      writeFileSync(prose, JSON.stringify(value));
      expect(() =>
        runPersistenceChanges(
          ['--update', NEXT_ID, '--decision', 'same-version', '--prose', prose],
          root,
          () => after,
        ),
      ).toThrow();
      expect(readFileSync(path, 'utf8')).toBe(before);
    }
  });
});

describe('明確的同版決定', () => {
  it.each(['optional header', 'removed field', 'changed field'] as const)(
    '明確確認過的 %s 放行',
    (kind) => {
      const root = fixture();
      baseline(root, inventory({ value: 'number' }, 4));
      const previous = contents(root);
      let after: PersistenceSchemaInventory;
      if (kind === 'optional header') {
        const current = inventory({ value: 'number' }, 4);
        after = {
          ...current,
          roots: current.roots.map((root) =>
            root.key === 'SessionHeader'
              ? typeRoot('SessionHeader', { id: 'string', 'env?': 'string' }, 4)
              : root,
          ),
        };
      } else if (kind === 'removed field') {
        after = inventory({}, 4);
      } else {
        after = inventory({ value: 'boolean' }, 4);
      }
      const prose = proseFile(root);
      expect(
        jsonResult(
          runPersistenceChanges(
            ['--record', NEXT_ID, '--decision', 'same-version', '--prose', prose, '--json'],
            root,
            () => after,
          ),
        ).ok,
      ).toBe(true);
      const saved = loadPersistenceHistory(root).entries.find(
        (entry) => entry.record.id === NEXT_ID,
      )!;
      expect(saved.record.changes.every((change) => change.decision === 'same-version')).toBe(true);
      expect(runPersistenceChanges(['--check'], root, () => after)).toContain('roots match');
      for (const [path, content] of Object.entries(previous).filter(([path]) =>
        path.startsWith(`${PERSISTENCE_HISTORY_DIRECTORY}/`),
      )) {
        expect(readFileSync(join(root, path), 'utf8')).toBe(content);
      }
    },
  );

  it('同版決定免不掉真的版號轉換', () => {
    const root = fixture();
    baseline(root);
    const before = contents(root);
    for (const version of [2, 4]) {
      expect(
        jsonResult(
          runPersistenceChanges(
            ['--record', NEXT_ID, '--decision', 'same-version', '--json'],
            root,
            () => inventory({ value: 'string' }, version),
          ),
        ),
      ).toMatchObject({ ok: false, code: 'version-transition-required' });
    }
    expect(
      jsonResult(
        runPersistenceChanges(
          ['--record', NEXT_ID, '--decision', 'version-bump', '--json'],
          root,
          () => inventory({ value: 'string' }, 2),
        ),
      ),
    ).toMatchObject({ ok: false, code: 'version-transition-required' });
    expect(contents(root)).toEqual(before);
  });

  it.each(['unchanged', 'changed'] as const)('更新 %s 的需審查型別圖時要明確決定', (kind) => {
    const root = fixture();
    baseline(root);
    const after = inventory({ value: 'number' });
    runPersistenceChanges(
      ['--record', NEXT_ID, '--decision', 'same-version', '--prose', proseFile(root)],
      root,
      () => after,
    );
    const current = kind === 'changed' ? inventory({ value: 'boolean' }) : after;
    const before = contents(root);
    expect(
      jsonResult(runPersistenceChanges(['--update', NEXT_ID, '--json'], root, () => current)),
    ).toMatchObject({
      ok: false,
      code: 'decision-required',
      files: [],
    });
    expect(contents(root)).toEqual(before);
    runPersistenceChanges(['--update', NEXT_ID, '--decision', 'same-version'], root, () => current);
    expect(runPersistenceChanges(['--check'], root, () => current)).toContain('roots match');
  });

  it('同版決定綁在確切的歷史快照上；沒涵蓋到的根照樣拒', () => {
    const root = fixture();
    baseline(root);
    const after = inventory({ value: 'number' });
    runPersistenceChanges(
      ['--record', NEXT_ID, '--decision', 'same-version', '--prose', proseFile(root)],
      root,
      () => after,
    );
    const uncovered = {
      ...after,
      roots: after.roots.map((root) =>
        root.key === 'SessionHeader'
          ? typeRoot('SessionHeader', { id: 'string', 'env?': 'string' })
          : root,
      ),
    };
    commitCurrent(root, uncovered);
    expect(() => verifyPersistenceChanges(root, uncovered)).toThrow(
      'unacknowledged persistence type changes',
    );
    const history = loadPersistenceHistory(root);
    const recorded = history.entries.find((entry) => entry.record.id === NEXT_ID)!;
    const invalid = { ...recorded, snapshot: onlyEvent(inventory({ value: 'boolean' })) };
    expect(() =>
      validatePersistenceHistory([
        ...history.entries.filter((entry) => entry !== recorded),
        invalid,
      ]),
    ).toThrow('after digest mismatch');
  });
});

// ── 真抽取器：⓪b-1 那種夾具樹（tsconfig.base.json、@nexus/core 的 SessionEventMap 與 StoredSessionHeader） ──

const PAYLOAD = 'packages/fixture-payload/src/types.ts';
const SESSION_LOG = 'packages/nexus-core/src/session-log.ts';
const SESSION_STORE = 'packages/nexus-core/src/session-store.ts';
const HEADER_50 =
  'export interface StoredSessionHeader { readonly version: 50; readonly id: string; readonly createdAt: number }\n';

function put(root: string, file: string, source: string): void {
  const path = join(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
}

function sourceTree(payload: string): string {
  // realpath：macOS 的暫存目錄經過 /var → /private/var 的連結，編譯器解出來的檔名是真路徑。
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nexus-persistence-changes-tree-')));
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
  mkdirSync(join(root, 'apps', 'harness', 'src'), { recursive: true });
  mkdirSync(join(root, 'apps', 'web', 'src'), { recursive: true });
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
  put(root, SESSION_STORE, HEADER_50);
  put(
    root,
    SESSION_LOG,
    `
import type { Payload } from '@fixture/payload';
export interface SessionEventMap {
  'test/record': Payload;
}
export type SessionEventType = keyof SessionEventMap;
export type SessionEvent<T extends SessionEventType = SessionEventType> = T extends SessionEventType
  ? { readonly type: T; readonly seq: number; readonly time: number; readonly data: SessionEventMap[T] }
  : never;
`,
  );
  mkdirSync(join(root, 'docs'), { recursive: true });
  return root;
}

/** 照真的流程重新生成 `docs/persistence-schema.json`（同 `gen-persistence-schema`）。 */
function regenerate(root: string): void {
  writeFileSync(
    join(root, PERSISTENCE_SCHEMA_PATH),
    renderPersistenceSchema(extractPersistenceSchema(root)),
  );
}

/** 用真的抽取器與預設生成物跑命令列的函式。 */
function cli(root: string, ...args: string[]): string {
  return executePersistenceChanges(args, root);
}

function verifyTree(root: string): void {
  verifyPersistenceChanges(root, extractPersistenceSchema(root));
}

/** 起一棵有基線、已生成型別圖的樹。 */
function acceptedTree(): { root: string; prose: string } {
  const root = sourceTree('export interface Payload { readonly id: string }\n');
  const prose = proseFile(root);
  cli(root, '--baseline', BASE_ID, '--prose', prose);
  verifyTree(root);
  return { root, prose };
}

describe('驗收：在夾具樹上跑真的抽取器', { timeout: EXTRACT_TIMEOUT }, () => {
  it('A：酬載加一個選填欄位、不寫紀錄就紅，訊息列出路徑並標 same-version allowed；補一筆同版紀錄就綠', () => {
    const { root, prose } = acceptedTree();
    put(
      root,
      PAYLOAD,
      'export interface Payload { readonly id: string; readonly label?: string }\n',
    );
    regenerate(root);
    expect(() => verifyTree(root)).toThrow(
      'event:test/record.data.label: optional property added (same-version allowed)',
    );
    cli(root, '--record', NEXT_ID, '--prose', prose);
    verifyTree(root);
    const changes = loadPersistenceHistory(root).entries.find(
      (entry) => entry.record.id === NEXT_ID,
    )?.record.changes;
    expect(changes).toEqual([
      expect.objectContaining({ root: 'event:test/record', decision: 'same-version' }),
    ]);
  });

  it('B：升 header 版號、紀錄寫 same-version 就紅；改成 version-bump、帶著版號遞增就綠', () => {
    const { root, prose } = acceptedTree();
    put(root, SESSION_STORE, HEADER_50.replace('version: 50', 'version: 51'));
    regenerate(root);
    expect(() => verifyTree(root)).toThrow(
      'SessionHeader.version: type changed (compatibility review required)',
    );
    expect(
      JSON.parse(
        cli(root, '--record', NEXT_ID, '--decision', 'same-version', '--prose', prose, '--json'),
      ),
    ).toMatchObject({ ok: false, code: 'version-transition-required' });
    // 手寫的紀錄同樣擋得住：CI 只認紀錄上寫的 decision（README〈相容規則〉）。
    cli(root, '--record', NEXT_ID, '--decision', 'version-bump', '--prose', prose);
    verifyTree(root);
    const path = join(root, PERSISTENCE_HISTORY_DIRECTORY, `${NEXT_ID}.md`);
    const recorded = readFileSync(path, 'utf8');
    expect(recorded).toContain('decision: version-bump');
    writeFileSync(path, recorded.replaceAll('decision: version-bump', 'decision: same-version'));
    expect(() => verifyTree(root)).toThrow(
      'SessionHeader.version changes require an increasing version-bump',
    );
  });

  it('C：相容性那段留 TODO 就紅', () => {
    const { root, prose } = acceptedTree();
    put(
      root,
      PAYLOAD,
      'export interface Payload { readonly id: string; readonly label?: string }\n',
    );
    regenerate(root);
    cli(root, '--record', NEXT_ID, '--prose', prose);
    verifyTree(root);
    const path = join(root, PERSISTENCE_HISTORY_DIRECTORY, `${NEXT_ID}.md`);
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace(
        AUTHORED_PROSE.compatibility,
        'TODO: explain this change.',
      ),
    );
    expect(() => verifyTree(root)).toThrow('complete compatibility and verification prose');
  });

  it('D：竄改一筆紀錄的 after 摘要就紅', () => {
    const { root, prose } = acceptedTree();
    put(
      root,
      PAYLOAD,
      'export interface Payload { readonly id: string; readonly label?: string }\n',
    );
    regenerate(root);
    cli(root, '--record', NEXT_ID, '--prose', prose);
    verifyTree(root);
    const path = join(root, PERSISTENCE_HISTORY_DIRECTORY, `${NEXT_ID}.md`);
    const recorded = readFileSync(path, 'utf8');
    const after = /after: "([a-f0-9]{64})"/u.exec(recorded)?.[1];
    expect(after).toBeDefined();
    writeFileSync(path, recorded.replace(after!, 'f'.repeat(64)));
    expect(() => verifyTree(root)).toThrow(
      `${NEXT_ID}: after digest mismatch for event:test/record`,
    );
  });

  it('E：兩筆紀錄接在同一個前驅上（分叉）就紅', () => {
    const { root, prose } = acceptedTree();
    put(
      root,
      PAYLOAD,
      'export interface Payload { readonly id: string; readonly label?: string }\n',
    );
    regenerate(root);
    cli(root, '--record', NEXT_ID, '--prose', prose);
    verifyTree(root);
    const fork = '2026-09-11-fork';
    const directory = join(root, PERSISTENCE_HISTORY_DIRECTORY);
    writeFileSync(
      join(directory, `${fork}.md`),
      readFileSync(join(directory, `${NEXT_ID}.md`), 'utf8').replaceAll(NEXT_ID, fork),
    );
    copyFileSync(join(directory, `${NEXT_ID}.schema.json`), join(directory, `${fork}.schema.json`));
    expect(() => verifyTree(root)).toThrow(`forked persistence history for event:test/record`);
  });

  it('F：改了原始碼、沒重新生成 persistence-schema.json 就紅', () => {
    const { root } = acceptedTree();
    put(
      root,
      PAYLOAD,
      'export interface Payload { readonly id: string; readonly label?: string }\n',
    );
    expect(() => verifyTree(root)).toThrow(`${PERSISTENCE_SCHEMA_PATH} is stale`);
  });

  // 同 dsh `:802`：真的命令列行程、真的 TypeScript 抽取，暫存的樹沒有 git 歷史。
  it('真的命令列對只有原始碼的暫存樹', () => {
    const root = sourceTree('export interface Payload { readonly value: string }\n');
    const script = fileURLToPath(new URL('./persistence-changes.ts', import.meta.url));
    const harness = fileURLToPath(new URL('..', import.meta.url));
    const run = (...args: string[]): ReturnType<typeof spawnSync> =>
      spawnSync(process.execPath, ['--import', 'tsx', script, '--root', root, ...args], {
        cwd: harness,
        encoding: 'utf8',
        timeout: 120_000,
      });
    const prose = proseFile(root);
    const initialized = run('--baseline', BASE_ID, '--prose', prose);
    expect(initialized.error).toBeUndefined();
    expect(initialized.status, String(initialized.stderr)).toBe(0);
    const accepted = run('--check');
    expect(accepted.status, String(accepted.stderr)).toBe(0);
    put(
      root,
      PAYLOAD,
      'export interface Payload { readonly value: string; readonly label?: string }\n',
    );
    const authored = run('--record', NEXT_ID, '--prose', prose, '--json');
    expect(authored.status, String(authored.stderr)).toBe(0);
    expect(JSON.parse(String(authored.stdout))).toMatchObject({ ok: true, operation: 'record' });
    const recordPath = join(root, `${PERSISTENCE_HISTORY_DIRECTORY}/${NEXT_ID}.md`);
    const beforeUpdate = readFileSync(recordPath, 'utf8');
    put(
      root,
      PAYLOAD,
      'export interface Payload { readonly value: string; readonly label?: string; readonly extra?: number }\n',
    );
    const updated = run('--update', NEXT_ID, '--json');
    expect(updated.status, String(updated.stderr)).toBe(0);
    expect(JSON.parse(String(updated.stdout))).toMatchObject({ ok: true, operation: 'update' });
    const strip = (value: string): string =>
      value.replace(/```yaml persistence-change[\s\S]*?```/u, '');
    expect(strip(readFileSync(recordPath, 'utf8'))).toBe(strip(beforeUpdate));
    const generated = extractPersistenceSchema(root);
    expect(readFileSync(join(root, PERSISTENCE_SCHEMA_PATH), 'utf8')).toBe(
      renderPersistenceSchema(generated),
    );
    verifyPersistenceChanges(root, generated);
    put(
      root,
      PAYLOAD,
      'export interface Payload { readonly value: number; readonly label?: string; readonly extra?: number }\n',
    );
    regenerate(root);
    const rejected = run('--check');
    expect(rejected.status).toBe(1);
    expect(String(rejected.stderr)).toContain('compatibility review required');
    const structured = run('--check', '--json');
    expect(structured.status).toBe(1);
    expect(JSON.parse(String(structured.stdout))).toMatchObject({
      ok: false,
      code: 'unacknowledged-changes',
      changes: [
        expect.objectContaining({ kind: 'type-changed', requiresCompatibilityReview: true }),
      ],
    });
    const missingDecision = run('--record', FUTURE_ID, '--prose', prose, '--json');
    expect(missingDecision.status).toBe(1);
    expect(JSON.parse(String(missingDecision.stdout))).toMatchObject({
      ok: false,
      code: 'decision-required',
      files: [],
    });
    const chosen = run(
      '--record',
      FUTURE_ID,
      '--decision',
      'same-version',
      '--prose',
      prose,
      '--json',
    );
    expect(chosen.status, String(chosen.stderr)).toBe(0);
    expect(JSON.parse(String(chosen.stdout))).toMatchObject({ ok: true, operation: 'record' });
    const missingUpdateDecision = run('--update', FUTURE_ID, '--json');
    expect(missingUpdateDecision.status).toBe(1);
    expect(JSON.parse(String(missingUpdateDecision.stdout))).toMatchObject({
      ok: false,
      code: 'decision-required',
      files: [],
    });
    const chosenUpdate = run('--update', FUTURE_ID, '--decision', 'same-version', '--json');
    expect(chosenUpdate.status, String(chosenUpdate.stderr)).toBe(0);
    expect(JSON.parse(String(chosenUpdate.stdout))).toMatchObject({
      ok: true,
      operation: 'update',
    });
    verifyPersistenceChanges(root, extractPersistenceSchema(root));
  });
});

describe('這個 repo 的持久化變更紀錄', { timeout: EXTRACT_TIMEOUT }, () => {
  it('原始碼的型別圖跟紀錄歷史的末端一致，沒有沒寫紀錄的變更', () => {
    const root = repositoryRoot();
    const history = verifyPersistenceChanges(root, extractPersistenceSchema(root));
    expect(history.entries.filter((entry) => entry.record.baseline)).toHaveLength(1);
  });
});

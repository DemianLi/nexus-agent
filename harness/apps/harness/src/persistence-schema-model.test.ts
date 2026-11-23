/**
 * 持久化型別圖的正規化與指紋（[#1856](https://github.com/DemianLi/nexus-agent/issues/1856) ⓪b-1）。
 *
 * 照 dsh `scripts/persistence-schema-model.spec.ts` 與 `persistence-schema-snapshot.spec.ts`（`687f282e`）。沒搬的：
 * 訊息來源政策那一組（`SourceCompatibility` 不搬，見 `persistence-schema.ts` 檔頭），以及精簡清單「讀回來還原」的幾格
 * （`parsePersistenceSnapshot` 屬於驗證器，⓪b-2）。
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalizeSchema,
  isArbitraryJsonSchema,
  persistenceSchemaSnapshot,
  schemaDigest,
  type PersistenceSchemaInventory,
  type SchemaNode,
} from './persistence-schema-model.js';

const string: SchemaNode = { kind: 'primitive', type: 'string' };
const number: SchemaNode = { kind: 'primitive', type: 'number' };

describe('標準化的持久化型別圖', () => {
  it('不受原始碼順序影響，共用與重複的子型別算成同一張圖', () => {
    const left: SchemaNode[] = [
      {
        kind: 'object',
        properties: [
          { name: 'b', type: 1, optional: false },
          { name: 'a', type: 1, optional: true },
        ],
        indices: [],
      },
      string,
    ];
    const right: SchemaNode[] = [
      string,
      string,
      {
        kind: 'object',
        properties: [
          { name: 'a', type: 0, optional: true },
          { name: 'b', type: 1, optional: false },
        ],
        indices: [],
      },
    ];
    expect(canonicalizeSchema(left, 0)).toEqual(canonicalizeSchema(right, 2));
  });

  it('拆法不同的遞迴別名最小化成同一張圖', () => {
    const self: SchemaNode[] = [
      {
        kind: 'object',
        properties: [
          { name: 'next', type: 0, optional: true },
          { name: 'value', type: 1, optional: false },
        ],
        indices: [],
      },
      string,
    ];
    const mutual: SchemaNode[] = [
      {
        kind: 'object',
        properties: [
          { name: 'value', type: 2, optional: false },
          { name: 'next', type: 1, optional: true },
        ],
        indices: [],
      },
      {
        kind: 'object',
        properties: [
          { name: 'next', type: 0, optional: true },
          { name: 'value', type: 3, optional: false },
        ],
        indices: [],
      },
      string,
      string,
    ];
    const normalized = canonicalizeSchema(self, 0);
    expect(canonicalizeSchema(mutual, 0)).toEqual(normalized);
    expect(canonicalizeSchema(normalized.nodes, 0)).toEqual(normalized);
    mutual[3] = number;
    expect(schemaDigest(canonicalizeSchema(mutual, 0))).not.toBe(schemaDigest(normalized));
  });

  it('攤平換過順序的聯集，拿掉結構相同的分支', () => {
    const flat: SchemaNode[] = [{ kind: 'union', types: [1, 2] }, string, number];
    const factored: SchemaNode[] = [
      string,
      number,
      { kind: 'union', types: [0, 3] },
      { kind: 'union', types: [1, 0] },
    ];
    expect(canonicalizeSchema(flat, 0)).toEqual(canonicalizeSchema(factored, 2));
    expect(canonicalizeSchema([{ kind: 'union', types: [1, 2] }, string, string], 0)).toEqual(
      canonicalizeSchema([string], 0),
    );
    expect(
      canonicalizeSchema(
        [
          { kind: 'union', types: [1, 2] },
          { kind: 'literal', value: true },
          { kind: 'literal', value: false },
        ],
        0,
      ),
    ).toEqual(canonicalizeSchema([{ kind: 'primitive', type: 'boolean' }], 0));
  });

  it('遞迴聯集、欄位、索引簽名與節點編號的順序一起換也不影響', () => {
    const original: SchemaNode[] = [
      { kind: 'union', types: [1, 2, 3] },
      {
        kind: 'object',
        properties: [
          { name: 'label', type: 5, optional: false },
          { name: 'next', type: 0, optional: true },
        ],
        indices: [],
      },
      { kind: 'array', element: 0 },
      {
        kind: 'object',
        properties: [],
        indices: [
          { key: 5, value: 0 },
          { key: 4, value: 1 },
        ],
      },
      number,
      string,
    ];
    const reordered: SchemaNode[] = [
      string,
      {
        kind: 'object',
        properties: [],
        indices: [
          { key: 3, value: 5 },
          { key: 0, value: 4 },
        ],
      },
      { kind: 'array', element: 4 },
      number,
      { kind: 'union', types: [1, 2, 5] },
      {
        kind: 'object',
        properties: [
          { name: 'next', type: 4, optional: true },
          { name: 'label', type: 0, optional: false },
        ],
        indices: [],
      },
    ];
    expect(canonicalizeSchema(reordered, 4)).toEqual(canonicalizeSchema(original, 0));
  });

  it('tuple 的位置、可省略的元素與 rest 元素都進指紋', () => {
    const baseline: SchemaNode[] = [
      {
        kind: 'tuple',
        elements: [
          { type: 1, optional: false, rest: false },
          { type: 2, optional: true, rest: false },
        ],
      },
      string,
      number,
    ];
    const reversed: SchemaNode[] = [
      {
        kind: 'tuple',
        elements: [
          { type: 2, optional: false, rest: false },
          { type: 1, optional: true, rest: false },
        ],
      },
      string,
      number,
    ];
    const rest: SchemaNode[] = [
      {
        kind: 'tuple',
        elements: [
          { type: 1, optional: false, rest: false },
          { type: 2, optional: false, rest: true },
        ],
      },
      string,
      number,
    ];
    const digest = schemaDigest(canonicalizeSchema(baseline, 0));
    expect(schemaDigest(canonicalizeSchema(reversed, 0))).not.toBe(digest);
    expect(schemaDigest(canonicalizeSchema(rest, 0))).not.toBe(digest);
  });

  it('純看結構認出任意 JSON 值，並保留它的定義', () => {
    const json: SchemaNode[] = [
      { kind: 'union', types: [1, 2, 3, 4, 5, 6] },
      { kind: 'primitive', type: 'null' },
      { kind: 'primitive', type: 'boolean' },
      number,
      string,
      { kind: 'array', element: 0 },
      { kind: 'object', properties: [], indices: [{ key: 4, value: 0 }] },
    ];
    const schema = canonicalizeSchema(json, 0);
    expect(isArbitraryJsonSchema(schema)).toBe(true);
    expect(schema.nodes.some((node) => node.kind === 'array' && node.element === 0)).toBe(true);
    json[0] = { kind: 'union', types: [1, 2, 3, 4, 5] };
    expect(isArbitraryJsonSchema(canonicalizeSchema(json, 0))).toBe(false);
  });

  it('拒絕不存在的參照與沒有實體的聯集環', () => {
    expect(() => canonicalizeSchema([{ kind: 'array', element: 5 }], 0)).toThrow('missing node 5');
    expect(() => canonicalizeSchema([{ kind: 'union', types: [0] }], 0)).toThrow('union cycle');
  });

  it('指紋是 nexus 自己的領域前綴加上圖的 JSON，不跟 dsh 共用摘要空間', () => {
    const schema = canonicalizeSchema([string], 0);
    const digest = (prefix: string): string =>
      createHash('sha256').update(prefix).update(JSON.stringify(schema)).digest('hex');
    expect(schemaDigest(schema)).toBe(digest('nexus-persistence-schema-v1\n'));
    expect(schemaDigest(schema)).not.toBe(digest('dsh-persistence-schema-v1\n'));
  });
});

function inventory(): PersistenceSchemaInventory {
  const schema = canonicalizeSchema(
    [
      { kind: 'object', properties: [{ name: 'child', type: 1, optional: false }], indices: [] },
      {
        kind: 'object',
        properties: [
          { name: 'next', type: 1, optional: true },
          { name: 'value', type: 2, optional: false },
        ],
        indices: [],
      },
      { kind: 'primitive', type: 'string' },
    ],
    0,
  );
  return {
    formatVersion: 1,
    roots: ['SessionHeader', 'SessionEventEnvelope'].map((key) => ({
      key,
      kind: key === 'SessionHeader' ? ('header' as const) : ('envelope' as const),
      digest: schemaDigest(schema),
      schema,
    })),
    types: schema.nodes
      .map((_, index) => {
        const type = canonicalizeSchema(schema.nodes, index);
        return {
          digest: schemaDigest(type),
          schema: type,
          names: index === 1 ? ['Recursive'] : [],
          sources: ['packages/example/src/types.ts'],
        };
      })
      .sort((left, right) => left.digest.localeCompare(right.digest)),
  };
}

describe('精簡的持久化清單', () => {
  it('只留根圖；從根重建得出來的型別只留指紋與宣告資訊', () => {
    const original = inventory();
    const snapshot = persistenceSchemaSnapshot(original);
    expect(snapshot.formatVersion).toBe(1);
    expect(snapshot.roots).toEqual(original.roots);
    expect(snapshot.types).toEqual(
      original.types.map(({ digest, names, sources }) => ({ digest, names, sources })),
    );
  });

  it.each([true, false])('從根到不了的遞迴型別保留自己的圖（有根圖=%s）', (withRoots) => {
    const base = inventory();
    const schema = canonicalizeSchema(
      [
        {
          kind: 'object',
          properties: [
            { name: 'next', type: 0, optional: true },
            { name: 'flag', type: 1, optional: false },
          ],
          indices: [],
        },
        { kind: 'literal', value: false },
      ],
      0,
    );
    const independent = {
      digest: schemaDigest(schema),
      schema,
      names: ['example.ts#Independent', 'example.ts#Alias'],
      sources: ['example.ts'],
    };
    const original = {
      ...base,
      roots: withRoots ? base.roots : [],
      types: [independent, ...base.types],
    };
    const snapshot = persistenceSchemaSnapshot(original);
    expect(snapshot.types[0]).toEqual(independent);
    if (withRoots) {
      expect(snapshot.types.slice(1).every((type) => type.schema === undefined)).toBe(true);
    } else {
      expect(snapshot.types).toEqual(original.types);
    }
  });
});

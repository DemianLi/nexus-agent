/**
 * 持久化型別圖與它的標準指紋：跟原始碼無關的 JSON 型別圖，最小化之後算 sha256
 * （[#1856](https://github.com/DemianLi/nexus-agent/issues/1856) ⓪b-1）。圖裡的數字參照只在同一張圖內有效；
 * 型別名與宣告位置是附帶的資訊，不進指紋。
 *
 * 照 dsh `scripts/persistence-schema-model.ts`（`687f282e`）搬過來，演算法不改。跟 dsh 不同的兩處：
 *
 * - **沒有 `SourceCompatibility`，`formatVersion` 固定 1。** dsh 用它記 `@persistenceSource` 綁定的訊息來源政策，
 *   nexus 這一刀不搬那兩個標記（偏離登記在 `persistence-schema.ts` 檔頭），所以這裡也沒有對應的欄位與 v2 指紋。
 * - **指紋前綴是 `nexus-persistence-schema-v1`**，不跟 dsh 共用摘要空間。
 *
 * @module
 */

import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

/** 一個 JSON 屬性；「可以不出現」跟值的型別分開記。 */
export interface SchemaProperty {
  readonly name: string;
  readonly type: number;
  readonly optional: boolean;
}

/** tuple 的一個位置。 */
export interface SchemaTupleElement {
  readonly type: number;
  readonly optional: boolean;
  readonly rest: boolean;
}

/** 一個解析完的持久化型別；數字參照指向同一張圖裡的節點。 */
export type SchemaNode =
  | {
      readonly kind: 'primitive';
      readonly type: 'null' | 'boolean' | 'number' | 'string' | 'never';
    }
  | { readonly kind: 'literal'; readonly value: string | number | boolean }
  | { readonly kind: 'opaque'; readonly reason: 'any' | 'unknown' }
  | { readonly kind: 'array'; readonly element: number }
  | { readonly kind: 'tuple'; readonly elements: readonly SchemaTupleElement[] }
  | {
      readonly kind: 'object';
      readonly properties: readonly SchemaProperty[];
      readonly indices: readonly { readonly key: number; readonly value: number }[];
    }
  | { readonly kind: 'union'; readonly types: readonly number[] };

/** 自成一體、最小化過的圖；從根開始、節點編號確定。 */
export interface CanonicalSchema {
  readonly root: 0;
  readonly nodes: readonly SchemaNode[];
}

/** 一個各自追蹤的持久化紀錄詞彙（header、事件封裝、每一種事件）。 */
export interface PersistenceRoot {
  readonly key: string;
  readonly kind: 'header' | 'envelope' | 'event';
  readonly event?: string;
  readonly digest: string;
  readonly schema: CanonicalSchema;
}

/** 一個可達的結構型別，加上不進指紋的宣告資訊。 */
export interface PersistenceType {
  readonly digest: string;
  readonly schema: CanonicalSchema;
  readonly names: readonly string[];
  readonly sources: readonly string[];
}

/** 目前原始碼的完整持久化清單；`formatVersion` 也釘住正規化的做法。 */
export interface PersistenceSchemaInventory {
  readonly formatVersion: 1;
  readonly roots: readonly PersistenceRoot[];
  readonly types: readonly PersistenceType[];
}

/** 型別的宣告資訊；只有從根重建不出來的才帶自己的圖。 */
export interface PersistenceTypeIndex extends Omit<PersistenceType, 'schema'> {
  readonly schema?: CanonicalSchema;
}

/** 精簡過的清單（`docs/persistence-schema.json` 的形狀）；`formatVersion` 一樣釘住正規化。 */
export interface PersistenceSchemaSnapshot {
  readonly formatVersion: PersistenceSchemaInventory['formatVersion'];
  readonly roots: readonly PersistenceRoot[];
  readonly types: readonly PersistenceTypeIndex[];
}

/**
 * 把這幾張圖裡可達的每一個型別，依結構指紋建索引。
 *
 * @param schemas - 完整、標準化過的根圖。
 * @returns 以結構指紋為鍵的標準子圖。
 */
export function reachableSchemaTypes(
  schemas: readonly CanonicalSchema[],
): Map<string, CanonicalSchema> {
  const types = new Map<string, CanonicalSchema>();
  for (const schema of schemas) {
    for (const [index] of schema.nodes.entries()) {
      const type = canonicalizeSchema(schema.nodes, index);
      types.set(schemaDigest(type), type);
    }
  }
  return types;
}

/**
 * 從根重建得出來的型別圖省掉，其他的照留。
 *
 * @param inventory - 完整清單，包括被正規化從根圖抹掉的型別。
 * @returns 無損的精簡清單：根圖、型別順序、宣告資訊都保留。
 */
export function persistenceSchemaSnapshot(
  inventory: PersistenceSchemaInventory,
): PersistenceSchemaSnapshot {
  const reachable = reachableSchemaTypes(inventory.roots.map((root) => root.schema));
  return {
    formatVersion: inventory.formatVersion,
    roots: inventory.roots,
    types: inventory.types.map(({ digest, schema, names, sources }) => ({
      digest,
      ...(isDeepStrictEqual(schema, reachable.get(digest)) ? {} : { schema }),
      names,
      sources,
    })),
  };
}

/**
 * 照正規化後的語意順序，列出一個節點直接指到的節點。
 *
 * @param node - 解析完的節點。
 * @returns 指到的節點編號，重複的有序邊照列。
 */
export function schemaChildren(node: SchemaNode): number[] {
  switch (node.kind) {
    case 'array':
      return [node.element];
    case 'tuple':
      return node.elements.map((element) => element.type);
    case 'object':
      return [
        ...node.properties.map((property) => property.type),
        ...node.indices.flatMap((index) => [index.key, index.value]),
      ];
    case 'union':
      return [...node.types];
    case 'primitive':
    case 'literal':
    case 'opaque':
      return [];
    default:
      return assertNever(node);
  }
}

function mapNode(node: SchemaNode, ref: (id: number) => number): SchemaNode {
  switch (node.kind) {
    case 'array':
      return { kind: 'array', element: ref(node.element) };
    case 'tuple':
      return {
        kind: 'tuple',
        elements: node.elements.map((element) => ({
          type: ref(element.type),
          optional: element.optional,
          rest: element.rest,
        })),
      };
    case 'object':
      return {
        kind: 'object',
        properties: [...node.properties]
          .sort((left, right) => compare(left.name, right.name))
          .map((property) => ({
            name: property.name,
            type: ref(property.type),
            optional: property.optional,
          })),
        indices: node.indices
          .map((index) => ({ key: ref(index.key), value: ref(index.value) }))
          .sort((left, right) => left.key - right.key || left.value - right.value),
      };
    case 'union':
      return {
        kind: 'union',
        types: [...new Set(node.types.map(ref))].sort((left, right) => left - right),
      };
    case 'primitive':
      return { kind: 'primitive', type: node.type };
    case 'literal':
      return { kind: 'literal', value: node.value };
    case 'opaque':
      return { kind: 'opaque', reason: node.reason };
    default:
      return assertNever(node);
  }
}

function partition(nodes: readonly SchemaNode[]): number[] {
  let colors = nodes.map(() => 0);
  for (;;) {
    const signatures = nodes.map((node, index) =>
      JSON.stringify([colors[index], mapNode(node, (id) => colors[id] as number)]),
    );
    const ordered = [...new Set(signatures)].sort(compare);
    const ids = new Map(ordered.map((value, index) => [value, index]));
    const next = signatures.map((value) => ids.get(value) as number);
    const unchanged = new Set(next).size === new Set(colors).size;
    colors = next;
    if (unchanged) return colors;
  }
}

/**
 * 把互相模擬（bisimilar）的遞迴節點合併成一個，再確定地為可達的圖編號。
 *
 * @param input - 解析完的節點；屬性與聯集的順序可以任意。
 * @param root - 要的那個根的編號。
 * @returns 標準圖：不含不可達的節點，也不含重複的結構。
 */
export function canonicalizeSchema(input: readonly SchemaNode[], root: number): CanonicalSchema {
  input = normalizeUnions(input);
  const selected: number[] = [];
  const positions = new Map<number, number>();
  const select = (id: number): void => {
    if (!Number.isInteger(id) || id < 0 || id >= input.length) {
      throw new Error(`persistence schema: missing node ${String(id)}`);
    }
    if (positions.has(id)) return;
    positions.set(id, selected.length);
    selected.push(id);
    for (const child of schemaChildren(input[id] as SchemaNode)) select(child);
  };
  select(root);
  let nodes = selected.map((id) =>
    mapNode(input[id] as SchemaNode, (child) => positions.get(child) as number),
  );
  let rootIndex = 0;
  for (;;) {
    const colors = partition(nodes);
    const representatives = new Map<number, number>();
    colors.forEach((color, index) => {
      if (!representatives.has(color)) representatives.set(color, index);
    });
    const aliases = new Map<number, number>();
    nodes.forEach((node, index) => {
      if (node.kind !== 'union') return;
      const members = [...new Set(node.types.map((child) => colors[child] as number))];
      if (members.length === 1) {
        aliases.set(index, representatives.get(members[0] as number) as number);
      }
    });
    if (aliases.size > 0) {
      const resolve = (id: number): number => {
        const seen = new Set<number>();
        while (aliases.has(id)) {
          if (seen.has(id)) {
            throw new Error('persistence schema: union cycle has no material type');
          }
          seen.add(id);
          id = aliases.get(id) as number;
        }
        return id;
      };
      rootIndex = resolve(rootIndex);
      nodes = nodes.map((node, index) =>
        aliases.has(index) ? (nodes[resolve(index)] as SchemaNode) : mapNode(node, resolve),
      );
      continue;
    }
    const emitted = new Map<number, number>();
    const result: SchemaNode[] = [];
    const visit = (id: number): number => {
      const color = colors[id] as number;
      const existing = emitted.get(color);
      if (existing !== undefined) return existing;
      const position = result.length;
      emitted.set(color, position);
      result.push({ kind: 'primitive', type: 'never' });
      const representative = representatives.get(color) as number;
      const colored = mapNode(
        nodes[representative] as SchemaNode,
        (child) => colors[child] as number,
      );
      result[position] = mapNode(colored, (child) => visit(representatives.get(child) as number));
      return position;
    };
    visit(rootIndex);
    return { root: 0, nodes: result };
  }
}

function normalizeUnions(input: readonly SchemaNode[]): SchemaNode[] {
  const result = [...input];
  const flattened = (id: number, visiting: Set<number>): number[] => {
    const node = input[id];
    if (node === undefined) throw new Error(`persistence schema: missing node ${String(id)}`);
    if (node.kind !== 'union') return [id];
    if (visiting.has(id)) {
      throw new Error('persistence schema: union cycle has no material type');
    }
    const next = new Set(visiting).add(id);
    return node.types.flatMap((child) => flattened(child, next));
  };
  for (const [id, node] of input.entries()) {
    if (node.kind !== 'union') continue;
    let members = [...new Set(flattened(id, new Set()))];
    const primitives = new Set(
      members.flatMap((child) => {
        const value = input[child] as SchemaNode;
        return value.kind === 'primitive' ? [value.type] : [];
      }),
    );
    const literals = members.flatMap((child) => {
      const value = input[child] as SchemaNode;
      return value.kind === 'literal' ? [value.value] : [];
    });
    if (!primitives.has('boolean') && literals.includes(true) && literals.includes(false)) {
      primitives.add('boolean');
      members.push(result.length);
      result.push({ kind: 'primitive', type: 'boolean' });
    }
    members = members.filter((child) => {
      const value = result[child] as SchemaNode;
      if (value.kind === 'primitive') return value.type !== 'never';
      return (
        value.kind !== 'literal' ||
        !primitives.has(typeof value.value as 'string' | 'number' | 'boolean')
      );
    });
    result[id] =
      members.length === 0
        ? { kind: 'primitive', type: 'never' }
        : { kind: 'union', types: members };
  }
  return result;
}

/** 指紋的領域前綴。改它等於讓每一筆已記的指紋失效，所以它跟 `formatVersion` 一起動。 */
const DIGEST_DOMAIN = 'nexus-persistence-schema-v1\n';

/**
 * 算一張標準圖的 SHA-256 指紋（帶版本前綴）。
 *
 * @param schema - 標準化過的持久化型別。
 * @returns 小寫十六進位摘要。
 */
export function schemaDigest(schema: CanonicalSchema): string {
  return createHash('sha256').update(DIGEST_DOMAIN).update(JSON.stringify(schema)).digest('hex');
}

/**
 * 不看型別名，純看結構認出「任意 JSON 值」這個遞迴型別。
 *
 * @param schema - 標準化過的型別。
 * @returns 這個型別是否允許任意 JSON 值。
 */
export function isArbitraryJsonSchema(schema: CanonicalSchema): boolean {
  return schemaDigest(schema) === JSON_VALUE_DIGEST;
}

const JSON_VALUE_DIGEST = schemaDigest(
  canonicalizeSchema(
    [
      { kind: 'union', types: [1, 2, 3, 4, 5, 6] },
      { kind: 'primitive', type: 'null' },
      { kind: 'primitive', type: 'boolean' },
      { kind: 'primitive', type: 'number' },
      { kind: 'primitive', type: 'string' },
      { kind: 'array', element: 0 },
      { kind: 'object', properties: [], indices: [{ key: 4, value: 0 }] },
    ],
    0,
  ),
);

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertNever(value: never): never {
  throw new Error(`persistence schema: unsupported node ${JSON.stringify(value)}`);
}

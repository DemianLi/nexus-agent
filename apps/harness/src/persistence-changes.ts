/**
 * 持久化型別變更的確認紀錄與驗證器（[#1856](https://github.com/DemianLi/nexus-agent/issues/1856) ⓪b-2）。
 *
 * 照 dsh `scripts/persistence-changes.ts`（`687f282e`）搬過來，檢查與分類不改：從原始碼抽出的型別圖
 * （{@link ./persistence-schema.ts}）跟 `docs/persistence-changes/` 的紀錄歷史末端比，對不上又沒有紀錄就拋
 * `unacknowledged persistence type changes`。每一筆紀錄是 `YYYY-MM-DD-slug.md`（機器聲明＋相容性與驗證的說明）加
 * `YYYY-MM-DD-slug.schema.json`（變更後的型別圖）。規則與檔案職責見 `docs/persistence-changes/README.md`。
 * CI 由 `persistence-changes.test.ts` 跑 {@link verifyPersistenceChanges}；命令列是
 * `pnpm --filter @nexus/harness run persistence-changes --check|--baseline ID|--record ID|--update ID`。
 *
 * 跟 dsh 不同的地方：
 *
 * - **紀錄只寫中文一份**（偏離 dsh，理由 2：本 repo 的文件只有中文）。dsh 一筆是英文 `.md`、中文 `.zh.md`、
 *   `i18n.yaml` 與 `schema.json`，並驗兩份的機器聲明逐字相同（dsh `:658-664`、`renderPersistencePair`）；這裡一筆是
 *   一份中文 `.md` 加 `schema.json`，說明輸入（`--prose`）也只有一種語言。
 * - **訊息來源的相容政策不搬**（過渡，登記在 `persistence-schema.ts` 檔頭，撤除條件
 *   [#1883](https://github.com/DemianLi/nexus-agent/issues/1883)）：清單只有 `formatVersion` 1，所以 dsh
 *   `parseSchema` 的 compatibility 欄位（`:219-228`、`:255-262`）、比對時的來源分組（`:455-476`）與 `formatVersion` 2
 *   （`:288`）在這裡是走不到的分支，跟著拿掉；`source-policy-changed`、`attribution-kind-added` 兩種分類也就沒有。
 * - 不在這張卡的範圍、所以沒有的：定稿檢查點 `finalized/vN.json`（dsh `verifyFinalization`）、歷史格式的快照解析
 *   （`parseHistoricalPersistenceSnapshot`，只給 `persistence-review`／`persistence-formats` 用）、人讀的目錄文件
 *   `persistence-catalog.md`（[#1886](https://github.com/DemianLi/nexus-agent/issues/1886)）。
 * - header 根只認 `SessionHeader`、基線必備的根不含 `JsonlHeaderLine`：nexus 沒有那個根（見 `persistence-schema.ts` 檔頭）。
 * - 生成物缺漏或過期時，訊息指向 `gen-persistence-schema`，不寫 dsh 的「regenerate the persistence catalog」：
 *   這裡沒有 catalog（同上，#1886）。
 *
 * @module
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { JSON_SCHEMA, load } from 'js-yaml';
import { repositoryRoot } from './package-invariants.js';
import {
  extractPersistenceSchema,
  PERSISTENCE_SCHEMA_PATH,
  renderPersistenceSchema,
} from './persistence-schema.js';
import {
  canonicalizeSchema,
  reachableSchemaTypes,
  schemaDigest,
} from './persistence-schema-model.js';
import type {
  CanonicalSchema,
  PersistenceRoot,
  PersistenceSchemaInventory,
  SchemaNode,
  SchemaTupleElement,
} from './persistence-schema-model.js';

/** 紀錄目錄（相對 repo 根）。 */
export const PERSISTENCE_HISTORY_DIRECTORY = 'docs/persistence-changes';
const ID_PATTERN = /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const EXPLANATION_PLACEHOLDER = 'TODO: explain this change.';
const EVIDENCE_PLACEHOLDER = 'TODO: record validation evidence.';

/** 作者對一次機械分類過的轉換所下的決定。 */
export type PersistenceDecision = 'same-version' | 'version-bump';

/** 一個根的後繼；`after` 是 `null` 表示那個根在這一筆被刪除，歷史照留。 */
export interface PersistenceChange {
  readonly root: string;
  readonly previous: string | null;
  readonly after: string | null;
  readonly decision: PersistenceDecision;
}

/** 一筆紀錄的機器聲明，跟說明文字無關。 */
export interface PersistenceChangeRecord {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly baseline: boolean;
  readonly changes: readonly PersistenceChange[];
}

/** 解析過的一筆紀錄，加上它自成一體的變更後型別圖。 */
export interface PersistenceHistoryEntry {
  readonly record: PersistenceChangeRecord;
  readonly snapshot: PersistenceSchemaInventory;
}

/** 偵測到的一處型別變更，路徑讓審查的人找得到。 */
export interface PersistenceTypeChange {
  readonly kind: PersistenceTypeChangeKind;
  readonly path: string;
  readonly description: string;
  readonly requiresCompatibilityReview: boolean;
}

const CHANGE_DESCRIPTIONS = {
  'root-added': 'root added',
  'root-removed': 'root removed',
  'root-classification-changed': 'root classification changed',
  'type-changed': 'type changed',
  'property-removed': 'property removed',
  'property-made-optional': 'property made optional',
  'property-made-required': 'property made required',
  'optional-property-added': 'optional property added',
  'required-property-added': 'required property added',
  'index-signature-changed': 'index signature changed',
  'tuple-length-changed': 'tuple length changed',
  'tuple-element-cardinality-changed': 'tuple element cardinality changed',
  'payload-version-added': 'event payload version added',
  'union-variants-changed': 'union variants changed',
} as const;

/** 結構分類，跟診斷文字無關。 */
export type PersistenceTypeChangeKind = keyof typeof CHANGE_DESCRIPTIONS;

/** 作者寫的三段說明，用來把紀錄補完（只有中文一份，見檔頭）。 */
export interface PersistenceChangeProse {
  readonly summary: string;
  readonly compatibility: string;
  readonly verification: string;
}

interface ReportedChange extends PersistenceTypeChange {
  readonly root: string;
}

interface RootTransition {
  readonly root: string;
  readonly kind: PersistenceRoot['kind'];
  readonly before: string | null;
  readonly after: string | null;
}

class PersistenceChangeFailure extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly changes: readonly ReportedChange[] = [],
    readonly roots: readonly RootTransition[] = [],
  ) {
    super(message);
  }
}

interface CommandResult {
  readonly schemaVersion: 1;
  readonly ok: boolean;
  readonly operation: 'check' | 'baseline' | 'record' | 'update';
  readonly message: string;
  readonly changes: readonly ReportedChange[];
  readonly roots: readonly RootTransition[];
  readonly files: readonly string[];
  readonly recordId?: string;
  readonly code?: string;
}

interface Tip {
  readonly id: string;
  readonly root: PersistenceRoot | null;
}

/** 驗過的每個根的歷史末端；歷史上的型別圖不必跟目前的原始碼一致。 */
export interface PersistenceHistory {
  readonly entries: readonly PersistenceHistoryEntry[];
  readonly tips: ReadonlyMap<string, Tip>;
}

/** 一個要寫出的檔：相對 repo 根的路徑與內容。 */
export interface PersistenceArtifact {
  readonly path: string;
  readonly content: string;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function keys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
  optional: readonly string[] = [],
): void {
  const missing = expected.find((key) => !Object.hasOwn(value, key));
  const unexpected = Object.keys(value).find(
    (key) => !expected.includes(key) && !optional.includes(key),
  );
  if (missing !== undefined || unexpected !== undefined)
    throw new Error(
      `${label}: ${missing === undefined ? `unknown field ${String(unexpected)}` : `missing field ${missing}`}`,
    );
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function textValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`${label} must be a non-empty string`);
  return value;
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`);
  return value;
}

function identifier(value: unknown, label: string): string {
  const id = textValue(value, label);
  if (!ID_PATTERN.test(id)) throw new Error(`${label} must be YYYY-MM-DD-slug`);
  return id;
}

function digest(value: unknown, label: string): string {
  const result = textValue(value, label);
  if (!DIGEST_PATTERN.test(result)) throw new Error(`${label} must be a SHA-256 digest`);
  return result;
}

function reference(value: unknown, count: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) >= count)
    throw new Error(`${label} references an unknown schema node`);
  return value as number;
}

function parseSchema(value: unknown, label: string): CanonicalSchema {
  const input = record(value, label);
  keys(input, ['root', 'nodes'], label);
  if (input.root !== 0) throw new Error(`${label}.root must be zero`);
  const nodes = array(input.nodes, `${label}.nodes`);
  if (nodes.length === 0) throw new Error(`${label}.nodes must not be empty`);
  const ref = (value: unknown): number => reference(value, nodes.length, label);
  for (const [index, raw] of nodes.entries()) {
    const node = record(raw, `${label}.nodes[${index}]`);
    switch (node.kind) {
      case 'primitive':
        keys(node, ['kind', 'type'], label);
        if (!['null', 'boolean', 'number', 'string', 'never'].includes(String(node.type)))
          throw new Error(`${label}: invalid primitive`);
        break;
      case 'literal':
        keys(node, ['kind', 'value'], label);
        if (
          !['string', 'boolean', 'number'].includes(typeof node.value) ||
          (typeof node.value === 'number' && !Number.isFinite(node.value))
        )
          throw new Error(`${label}: invalid literal`);
        break;
      case 'opaque':
        keys(node, ['kind', 'reason'], label);
        if (!['any', 'unknown'].includes(String(node.reason)))
          throw new Error(`${label}: invalid opaque reason`);
        break;
      case 'array':
        keys(node, ['kind', 'element'], label);
        ref(node.element);
        break;
      case 'tuple':
        keys(node, ['kind', 'elements'], label);
        for (const rawElement of array(node.elements, label)) {
          const element = record(rawElement, label);
          keys(element, ['type', 'optional', 'rest'], label);
          ref(element.type);
          bool(element.optional, label);
          bool(element.rest, label);
        }
        break;
      case 'object': {
        keys(node, ['kind', 'properties', 'indices'], label);
        const names = new Set<string>();
        for (const rawProperty of array(node.properties, label)) {
          const property = record(rawProperty, label);
          keys(property, ['name', 'type', 'optional'], label);
          if (typeof property.name !== 'string')
            throw new Error(`${label}: property name must be a string`);
          const name = property.name;
          if (names.has(name)) throw new Error(`${label}: duplicate property ${name}`);
          names.add(name);
          ref(property.type);
          bool(property.optional, label);
        }
        for (const rawIndex of array(node.indices, label)) {
          const entry = record(rawIndex, label);
          keys(entry, ['key', 'value'], label);
          ref(entry.key);
          ref(entry.value);
        }
        break;
      }
      case 'union':
        keys(node, ['kind', 'types'], label);
        if (array(node.types, label).length === 0) throw new Error(`${label}: empty union`);
        for (const item of node.types as unknown[]) ref(item);
        break;
      default:
        throw new Error(`${label}: unknown schema node kind ${String(node.kind)}`);
    }
  }
  const schema = input as unknown as CanonicalSchema;
  const canonical = canonicalizeSchema(schema.nodes, schema.root);
  if (JSON.stringify(canonical) !== JSON.stringify(schema))
    throw new Error(`${label}: schema is not canonical`);
  return schema;
}

/**
 * 解析完整或精簡的清單，重建型別圖並拒收對不上的指紋。
 *
 * @param value - 從 `docs/persistence-schema.json` 或一筆紀錄的快照讀出的 JSON。
 * @returns 驗過的清單。
 */
export function parsePersistenceSnapshot(value: unknown): PersistenceSchemaInventory {
  const input = record(value, 'schema inventory');
  keys(input, ['formatVersion', 'roots', 'types'], 'schema inventory');
  if (input.formatVersion !== 1)
    throw new Error('unsupported persistence schema normalization version');
  const names = new Set<string>();
  const schemas: CanonicalSchema[] = [];
  for (const rawRoot of array(input.roots, 'schema roots')) {
    const root = record(rawRoot, 'schema root');
    keys(root, ['key', 'kind', 'digest', 'schema'], 'schema root', ['event', 'surface']);
    const key = textValue(root.key, 'root key');
    if (names.has(key)) throw new Error(`duplicate schema root ${key}`);
    names.add(key);
    if (root.kind === 'event') {
      if (key !== `event:${textValue(root.event, 'event name')}`)
        throw new Error(`invalid event root key ${key}`);
      bool(root.surface, 'event surface membership');
    } else if (
      (root.kind !== 'header' || key !== 'SessionHeader') &&
      (root.kind !== 'envelope' || key !== 'SessionEventEnvelope')
    )
      throw new Error(`invalid schema root ${key}`);
    if (root.kind !== 'event' && (root.event !== undefined || root.surface !== undefined))
      throw new Error(`${key}: non-event metadata`);
    const schema = parseSchema(root.schema, key);
    if (root.kind === 'event')
      validateEventMetadata(schema, String(root.event), root.surface === true);
    if (digest(root.digest, `${key} digest`) !== schemaDigest(schema))
      throw new Error(`${key}: schema digest mismatch`);
    schemas.push(schema);
  }
  let reachable: Map<string, CanonicalSchema> | undefined;
  const types = array(input.types, 'schema types').map((rawType) => {
    const type = record(rawType, 'schema type');
    keys(type, ['digest', 'names', 'sources'], 'schema type', ['schema']);
    const typeDigest = digest(type.digest, 'shared digest');
    let schema: CanonicalSchema;
    if ('schema' in type) {
      schema = parseSchema(type.schema, 'shared schema');
      if (typeDigest !== schemaDigest(schema)) throw new Error('shared schema digest mismatch');
    } else {
      reachable ??= reachableSchemaTypes(schemas);
      const found = reachable.get(typeDigest);
      if (found === undefined)
        throw new Error(`shared schema digest ${typeDigest} is not reachable from roots`);
      schema = found;
    }
    const typeNames = array(type.names, 'type names').map((name) => textValue(name, 'type name'));
    const sources = array(type.sources, 'type sources').map((source) =>
      textValue(source, 'type source'),
    );
    return { digest: typeDigest, schema, names: typeNames, sources };
  });
  return { ...(input as unknown as PersistenceSchemaInventory), types };
}

function validateEventMetadata(schema: CanonicalSchema, event: string, surface: boolean): void {
  const pending = [0];
  const visited = new Set<number>();
  while (pending.length > 0) {
    const index = pending.pop() as number;
    if (visited.has(index)) continue;
    visited.add(index);
    const node = schema.nodes[index] as SchemaNode;
    if (node.kind === 'union') {
      pending.push(...node.types);
      continue;
    }
    if (node.kind !== 'object') throw new Error(`${event}: event schema must be an object`);
    const tag = node.properties.find((property) => property.name === 'type');
    const value = tag === undefined ? undefined : schema.nodes[tag.type];
    if (tag?.optional !== false || value?.kind !== 'literal' || value.value !== event)
      throw new Error(`${event}: event schema type does not match its root`);
    const operation = node.properties.find((property) => property.name === 'surfaceOp');
    if (surface ? operation === undefined || operation.optional : operation !== undefined)
      throw new Error(`${event}: surface metadata does not match its schema`);
  }
}

function subDigest(schema: CanonicalSchema, node: number): string {
  return schemaDigest(canonicalizeSchema(schema.nodes, node));
}

function matchUnionVariants(candidates: readonly (readonly number[])[]): number[] | undefined {
  const owners = new Map<number, number>();
  function assign(previous: number, visited: Set<number>): boolean {
    for (const next of candidates[previous] ?? []) {
      if (visited.has(next)) continue;
      visited.add(next);
      const owner = owners.get(next);
      if (owner === undefined || assign(owner, visited)) {
        owners.set(next, previous);
        return true;
      }
    }
    return false;
  }
  for (let previous = 0; previous < candidates.length; previous += 1) {
    if (!assign(previous, new Set())) return undefined;
  }
  const matches: number[] = [];
  for (const [next, previous] of owners) matches[previous] = next;
  return matches;
}

/**
 * 依每張型別圖上記的讀方承諾，把結構差異分類。
 *
 * @param before - 前一個根；新增時是 `null`。
 * @param after - 後一個根；刪除時是 `null`。
 * @returns 具體的變更，以及每一處要不要相容審查。
 */
export function classifyPersistenceChange(
  before: PersistenceRoot | null,
  after: PersistenceRoot | null,
): PersistenceTypeChange[] {
  if (before === null) {
    return after === null
      ? []
      : [
          {
            path: after.key,
            kind: 'root-added',
            description: 'root added',
            requiresCompatibilityReview: after.kind !== 'event' || after.surface !== false,
          },
        ];
  }
  if (after === null)
    return [
      {
        path: before.key,
        kind: 'root-removed',
        description: 'root removed',
        requiresCompatibilityReview: true,
      },
    ];
  const key = after.key;
  const oldRoot = before;
  const newRoot = after;
  const describe = (
    path: string,
    kind: PersistenceTypeChangeKind,
    requiresCompatibilityReview = true,
  ): PersistenceTypeChange => ({
    path,
    kind,
    description: CHANGE_DESCRIPTIONS[kind],
    requiresCompatibilityReview,
  });
  const changes: PersistenceTypeChange[] = [];
  if (before.kind !== after.kind || before.surface !== after.surface)
    changes.push(describe(key, 'root-classification-changed'));
  if (before.digest === after.digest) return changes;
  const fingerprints = [new Map<number, string>(), new Map<number, string>()] as const;
  const fingerprint = (schema: CanonicalSchema, index: number, side: 0 | 1): string => {
    let result = fingerprints[side].get(index);
    if (result === undefined) {
      result = subDigest(schema, index);
      fingerprints[side].set(index, result);
    }
    return result;
  };
  type Scope = 'event' | 'body' | 'strict';
  function compare(
    oldIndex: number,
    newIndex: number,
    path: string,
    scope: Scope,
    ancestors: ReadonlySet<string>,
  ): PersistenceTypeChange[] {
    if (fingerprint(oldRoot.schema, oldIndex, 0) === fingerprint(newRoot.schema, newIndex, 1))
      return [];
    const pair = `${oldIndex}:${newIndex}:${scope}`;
    if (ancestors.has(pair)) return [];
    // 遞迴的配對只是這一個候選的假設：失敗的兄弟或沒配上的聯集分支，不能替另一個候選留下快取過的成功。
    const active = new Set(ancestors).add(pair);
    const differences: PersistenceTypeChange[] = [];
    const add = (
      path: string,
      kind: PersistenceTypeChangeKind,
      requiresCompatibilityReview = true,
    ): void => {
      differences.push(describe(path, kind, requiresCompatibilityReview));
    };
    const descend = (oldType: number, newType: number, child: string, childScope: Scope): void => {
      differences.push(...compare(oldType, newType, child, childScope, active));
    };
    const oldNode = oldRoot.schema.nodes[oldIndex] as SchemaNode;
    const newNode = newRoot.schema.nodes[newIndex] as SchemaNode;
    if (
      oldRoot.kind === 'event' &&
      oldRoot.surface === false &&
      scope === 'body' &&
      path === `${key}.data`
    ) {
      const oldTypes = oldNode.kind === 'union' ? oldNode.types : [oldIndex];
      const newTypes = newNode.kind === 'union' ? newNode.types : [newIndex];
      const payloadVersion = (schema: CanonicalSchema, index: number): number | undefined => {
        const node = schema.nodes[index];
        if (node?.kind !== 'object') return undefined;
        const property = node.properties.find(
          (property) => property.name === 'version' && !property.optional,
        );
        const version = schema.nodes[property?.type ?? -1];
        return version?.kind === 'literal' &&
          typeof version.value === 'number' &&
          Number.isSafeInteger(version.value) &&
          version.value >= 0
          ? version.value
          : undefined;
      };
      const versions = oldTypes.map((index) => payloadVersion(oldRoot.schema, index));
      const oldHashes = new Set(oldTypes.map((index) => fingerprint(oldRoot.schema, index, 0)));
      const newHashes = new Set(newTypes.map((index) => fingerprint(newRoot.schema, index, 1)));
      const added = newTypes.filter(
        (index) => !oldHashes.has(fingerprint(newRoot.schema, index, 1)),
      );
      if (
        versions.every((version) => version !== undefined) &&
        added.length > 0 &&
        [...oldHashes].every((hash) => newHashes.has(hash)) &&
        added.every(
          (index) => (payloadVersion(newRoot.schema, index) ?? -1) > Math.max(...versions),
        )
      ) {
        return [describe(path, 'payload-version-added', false)];
      }
    }
    if (oldNode.kind !== newNode.kind) return [describe(path, 'type-changed')];
    if (oldNode.kind === 'object' && newNode.kind === 'object') {
      const oldProps = new Map(oldNode.properties.map((property) => [property.name, property]));
      const newProps = new Map(newNode.properties.map((property) => [property.name, property]));
      for (const [name, property] of oldProps) {
        const next = newProps.get(name);
        const child = `${path}.${name}`;
        if (next === undefined) {
          add(child, 'property-removed');
          continue;
        }
        if (property.optional !== next.optional)
          add(
            child,
            next.optional ? 'property-made-optional' : 'property-made-required',
            scope !== 'body' || !next.optional,
          );
        const childScope =
          scope === 'body' || (scope === 'event' && name === 'data') ? 'body' : 'strict';
        descend(property.type, next.type, child, childScope);
      }
      for (const [name, property] of newProps) {
        if (!oldProps.has(name))
          add(
            `${path}.${name}`,
            property.optional ? 'optional-property-added' : 'required-property-added',
            scope !== 'body' || !property.optional,
          );
      }
      const oldIndices = new Map(
        oldNode.indices.map((entry) => [fingerprint(oldRoot.schema, entry.key, 0), entry]),
      );
      const newIndices = new Map(
        newNode.indices.map((entry) => [fingerprint(newRoot.schema, entry.key, 1), entry]),
      );
      if (
        oldIndices.size !== newIndices.size ||
        [...oldIndices.keys()].some((index) => !newIndices.has(index))
      )
        add(path, 'index-signature-changed');
      for (const [index, entry] of oldIndices) {
        const next = newIndices.get(index);
        if (next !== undefined)
          descend(entry.value, next.value, `${path}[*]`, scope === 'body' ? 'body' : 'strict');
      }
      return differences;
    }
    if (oldNode.kind === 'array' && newNode.kind === 'array') {
      return compare(
        oldNode.element,
        newNode.element,
        `${path}[]`,
        scope === 'body' ? 'body' : 'strict',
        active,
      );
    }
    if (oldNode.kind === 'tuple' && newNode.kind === 'tuple') {
      if (oldNode.elements.length !== newNode.elements.length)
        return [describe(path, 'tuple-length-changed')];
      for (const [index, element] of oldNode.elements.entries()) {
        const next = newNode.elements[index] as SchemaTupleElement;
        if (element.optional !== next.optional || element.rest !== next.rest)
          add(`${path}[${index}]`, 'tuple-element-cardinality-changed');
        descend(element.type, next.type, `${path}[${index}]`, scope === 'body' ? 'body' : 'strict');
      }
      return differences;
    }
    if (oldNode.kind === 'union' && newNode.kind === 'union') {
      return compareAlternatives(oldNode.types, newNode.types, path, scope, active);
    }
    return [describe(path, 'type-changed')];
  }
  function compareAlternatives(
    oldTypes: readonly number[],
    newTypes: readonly number[],
    path: string,
    scope: Scope,
    active: ReadonlySet<string>,
  ): PersistenceTypeChange[] {
    if (oldTypes.length !== newTypes.length) return [describe(path, 'union-variants-changed')];
    const candidates = oldTypes.map((oldType) =>
      newTypes.map((newType) => compare(oldType, newType, path, scope, active)),
    );
    const matching = matchUnionVariants(
      candidates.map((row) =>
        row.flatMap((candidate, index) =>
          candidate.every((change) => !change.requiresCompatibilityReview) ? [index] : [],
        ),
      ),
    );
    if (matching !== undefined)
      return matching.flatMap((next, previous) => candidates[previous]?.[next] ?? []);
    const oldByHash = new Map(
      oldTypes.map((index) => [fingerprint(oldRoot.schema, index, 0), index]),
    );
    const newByHash = new Map(
      newTypes.map((index) => [fingerprint(newRoot.schema, index, 1), index]),
    );
    const removed = [...oldByHash]
      .filter(([hash]) => !newByHash.has(hash))
      .map(([, index]) => index);
    const added = [...newByHash].filter(([hash]) => !oldByHash.has(hash)).map(([, index]) => index);
    if (removed.length === 1 && added.length === 1)
      return compare(removed[0] as number, added[0] as number, path, scope, active);
    return [describe(path, 'union-variants-changed')];
  }
  changes.push(...compare(0, 0, key, before.kind === 'event' ? 'event' : 'strict', new Set()));
  if (changes.length === 0) changes.push(describe(key, 'type-changed'));
  return [
    ...new Map(
      changes.map((change) => [
        JSON.stringify([change.path, change.kind, change.requiresCompatibilityReview]),
        change,
      ]),
    ).values(),
  ];
}

function parseDocument(
  source: string,
  filename: string,
  allowIncomplete = false,
): PersistenceChangeRecord {
  const frontmatter = /^---\n([\s\S]*?)\n---\n/u.exec(source);
  if (
    frontmatter === null ||
    record(load(frontmatter[1] as string, { schema: JSON_SCHEMA }), filename).kind !==
      'persistence-change'
  )
    throw new Error(`${filename}: kind must be persistence-change`);
  const openings = [...source.matchAll(/^```yaml persistence-change\s*$/gmu)];
  const block = /^```yaml persistence-change[^\S\n]*\n([\s\S]*?)^```[^\S\n]*$/mu.exec(source);
  if (openings.length !== 1 || block === null)
    throw new Error(`${filename}: expected exactly one persistence-change block`);
  const input = record(load(block[1] as string, { schema: JSON_SCHEMA }), filename);
  keys(input, ['schemaVersion', 'id', 'baseline', 'changes'], filename);
  if (input.schemaVersion !== 1)
    throw new Error(`${filename}: unsupported acknowledgement schema version`);
  const id = identifier(input.id, filename);
  if (basename(filename) !== `${id}.md`)
    throw new Error(`${filename}: record id does not match filename`);
  bool(input.baseline, filename);
  const roots = new Set<string>();
  for (const value of array(input.changes, `${filename} changes`)) {
    const change = record(value, filename);
    keys(change, ['root', 'previous', 'after', 'decision'], filename);
    const root = textValue(change.root, 'changed root');
    if (roots.has(root)) throw new Error(`${filename}: duplicate change for ${root}`);
    roots.add(root);
    if (change.previous !== null) identifier(change.previous, 'previous record');
    if (change.after !== null) digest(change.after, 'after digest');
    if (change.decision !== 'same-version' && change.decision !== 'version-bump')
      throw new Error(`${filename}: invalid compatibility decision`);
  }
  if (roots.size === 0) throw new Error(`${filename}: changes must not be empty`);
  if (
    !allowIncomplete &&
    (source.includes(EXPLANATION_PLACEHOLDER) || source.includes(EVIDENCE_PLACEHOLDER))
  )
    throw new Error(`${filename}: complete compatibility and verification prose`);
  return input as unknown as PersistenceChangeRecord;
}

function headerVersion(root: PersistenceRoot | null): number | undefined {
  if (root === null) return undefined;
  const node = root.schema.nodes[0];
  if (node?.kind !== 'object') return undefined;
  const property = node.properties.find((item) => item.name === 'version');
  if (property === undefined) return undefined;
  const version = root.schema.nodes[property.type];
  return version?.kind === 'literal' &&
    typeof version.value === 'number' &&
    Number.isSafeInteger(version.value)
    ? version.value
    : undefined;
}

/**
 * 檢查每一次歷史轉換，回傳每個根唯一的末端。
 *
 * @param entries - 解析過的紀錄與它們自成一體的型別圖快照。
 * @returns 驗過的歷史與末端；不讀 git，也不讀目前的原始碼。
 */
export function validatePersistenceHistory(
  entries: readonly PersistenceHistoryEntry[],
): PersistenceHistory {
  if (entries.filter((entry) => entry.record.baseline).length !== 1)
    throw new Error('persistence history requires exactly one baseline');
  const records = new Map<string, PersistenceHistoryEntry>();
  for (const entry of entries) {
    if (records.has(entry.record.id))
      throw new Error(`duplicate persistence record ${entry.record.id}`);
    records.set(entry.record.id, entry);
    const expected = entry.record.changes
      .filter((change) => change.after !== null)
      .map((change) => change.root)
      .sort();
    if (
      JSON.stringify(expected) !==
      JSON.stringify(entry.snapshot.roots.map((root) => root.key).sort())
    )
      throw new Error(`${entry.record.id}: snapshot roots do not match acknowledged after schemas`);
    for (const change of entry.record.changes) {
      const root = entry.snapshot.roots.find((root) => root.key === change.root);
      if ((root?.digest ?? null) !== change.after)
        throw new Error(`${entry.record.id}: after digest mismatch for ${change.root}`);
      if (
        entry.record.baseline &&
        (change.previous !== null || change.after === null || change.decision !== 'same-version')
      )
        throw new Error(`${entry.record.id}: invalid baseline transition`);
    }
  }
  const states = new Map<string, 'visiting' | 'visited'>();
  const successors = new Map<string, string>();
  const nodes = new Map<string, { entry: PersistenceHistoryEntry; change: PersistenceChange }>();
  const tips = new Map<string, Tip>();
  const nodeKey = (id: string | null, root: string): string => JSON.stringify([id, root]);
  for (const entry of entries)
    for (const change of entry.record.changes) {
      const parentKey = nodeKey(change.previous, change.root);
      if (successors.has(parentKey))
        throw new Error(
          `forked persistence history for ${change.root}: ${String(successors.get(parentKey))} and ${entry.record.id}`,
        );
      successors.set(parentKey, entry.record.id);
      nodes.set(nodeKey(entry.record.id, change.root), { entry, change });
    }
  function visit(id: string, root: string): PersistenceRoot | null {
    const key = nodeKey(id, root);
    const found = nodes.get(key);
    if (found === undefined) throw new Error(`missing predecessor ${id} for ${root}`);
    if (states.get(key) === 'visiting') throw new Error(`cycle in persistence history for ${root}`);
    const after = found.entry.snapshot.roots.find((item) => item.key === root) ?? null;
    if (states.get(key) === 'visited') return after;
    states.set(key, 'visiting');
    const before = found.change.previous === null ? null : visit(found.change.previous, root);
    if (!found.entry.record.baseline) {
      const differences = classifyPersistenceChange(before, after);
      if (differences.length === 0) throw new Error(`${id}: unchanged acknowledgement for ${root}`);
      if (
        root === 'SessionHeader' &&
        headerVersion(before) !== headerVersion(after) &&
        found.change.decision !== 'version-bump'
      ) {
        throw new PersistenceChangeFailure(
          `${id}: SessionHeader.version changes require an increasing version-bump transition`,
          'version-transition-required',
          differences.map((change) => ({ root, ...change })),
          [rootTransition(before, after)],
        );
      }
      if (found.change.decision === 'version-bump') {
        const header = found.entry.record.changes.find((change) => change.root === 'SessionHeader');
        const oldHeader =
          header?.previous === null || header === undefined
            ? null
            : visit(header.previous, 'SessionHeader');
        const from = headerVersion(oldHeader);
        const to = headerVersion(
          found.entry.snapshot.roots.find((item) => item.key === 'SessionHeader') ?? null,
        );
        if (from === undefined || to === undefined || to <= from) {
          throw new PersistenceChangeFailure(
            `${id}: version-bump requires this record's own increasing SessionHeader.version transition`,
            'version-transition-required',
            differences.map((change) => ({ root, ...change })),
            [rootTransition(before, after)],
          );
        }
      }
    }
    states.set(key, 'visited');
    if (!successors.has(key)) tips.set(root, { id, root: after });
    return after;
  }
  for (const entry of entries)
    for (const change of entry.record.changes) visit(entry.record.id, change.root);
  const baseline = entries.find((entry) => entry.record.baseline) as PersistenceHistoryEntry;
  if (
    !baseline.snapshot.roots.some((root) => root.key === 'SessionHeader') ||
    !baseline.snapshot.roots.some((root) => root.key === 'SessionEventEnvelope')
  ) {
    throw new Error('baseline requires SessionHeader and SessionEventEnvelope roots');
  }
  return { entries, tips };
}

/**
 * 讀並驗目前目錄裡的每一筆紀錄。
 *
 * @param root - repo 根或隔離的夾具根。
 * @returns 驗過的歷史；不拿末端去比目前的原始碼。
 */
export function loadPersistenceHistory(root: string): PersistenceHistory {
  return validatePersistenceHistory(readPersistenceEntries(root));
}

function readPersistenceEntries(
  root: string,
  allowIncompleteId?: string,
): PersistenceHistoryEntry[] {
  const directory = join(root, PERSISTENCE_HISTORY_DIRECTORY);
  if (!existsSync(directory))
    throw new Error(
      'persistence history is missing; use pnpm --filter @nexus/harness run persistence-changes --baseline ID for explicit initialization',
    );
  const files = readdirSync(directory).sort();
  const documents = files.filter(
    (file) => file.endsWith('.md') && file !== 'README.md' && file !== 'AGENTS.md',
  );
  const snapshots = new Set(files.filter((file) => file.endsWith('.schema.json')));
  const entries = documents.map((filename) => {
    const source = readFileSync(join(directory, filename), 'utf8').replaceAll('\r\n', '\n');
    const change = parseDocument(source, filename, filename === `${String(allowIncompleteId)}.md`);
    const snapshotName = `${change.id}.schema.json`;
    if (!snapshots.delete(snapshotName))
      throw new Error(`${filename}: missing schema snapshot ${snapshotName}`);
    const snapshot = parsePersistenceSnapshot(
      JSON.parse(readFileSync(join(directory, snapshotName), 'utf8')),
    );
    return { record: change, snapshot };
  });
  if (snapshots.size !== 0)
    throw new Error(`unreferenced persistence schema snapshot: ${[...snapshots].join(', ')}`);
  return entries;
}

function currentDifferences(
  history: PersistenceHistory,
  current: PersistenceSchemaInventory,
): string[] {
  const roots = new Map(current.roots.map((root) => [root.key, root]));
  const differences: string[] = [];
  for (const key of new Set([...history.tips.keys(), ...roots.keys()])) {
    if (
      classifyPersistenceChange(history.tips.get(key)?.root ?? null, roots.get(key) ?? null)
        .length !== 0
    )
      differences.push(key);
  }
  return differences.sort();
}

/**
 * 一起驗目前的生成物與紀錄的末端。
 *
 * @param root - repo 根或隔離的夾具根。
 * @param current - 剛從目前原始碼抽出來的清單。
 * @returns 驗過的歷史。
 * @throws 紀錄歷史不成立、`docs/persistence-schema.json` 缺或過期、或有沒寫紀錄的型別變更。
 */
export function verifyPersistenceChanges(
  root: string,
  current: PersistenceSchemaInventory,
): PersistenceHistory {
  const history = loadPersistenceHistory(root);
  const differences = reportedDifferences(history, current);
  const transitions = rootTransitions(history, current);
  const committedPath = join(root, PERSISTENCE_SCHEMA_PATH);
  if (!existsSync(committedPath)) {
    throw new PersistenceChangeFailure(
      `${PERSISTENCE_SCHEMA_PATH} is missing; regenerate it with gen-persistence-schema`,
      'generated-artifact-missing',
      differences,
      transitions,
    );
  }
  const committed = parsePersistenceSnapshot(JSON.parse(readFileSync(committedPath, 'utf8')));
  if (JSON.stringify(committed) !== JSON.stringify(current)) {
    throw new PersistenceChangeFailure(
      `${PERSISTENCE_SCHEMA_PATH} is stale; regenerate it with gen-persistence-schema`,
      'stale-artifacts',
      differences,
      transitions,
    );
  }
  if (differences.length !== 0) {
    const details = differences.map(
      (change) =>
        `  ${change.path}: ${change.description} (${change.requiresCompatibilityReview ? 'compatibility review required' : 'same-version allowed'})`,
    );
    throw new PersistenceChangeFailure(
      `unacknowledged persistence type changes:\n${details.join('\n')}`,
      'unacknowledged-changes',
      differences,
      transitions,
    );
  }
  return history;
}

function rootTransition(
  before: PersistenceRoot | null,
  after: PersistenceRoot | null,
): RootTransition {
  const root = (after ?? before) as PersistenceRoot;
  return {
    root: root.key,
    kind: root.kind,
    before: before?.digest ?? null,
    after: after?.digest ?? null,
  };
}

function rootTransitions(
  history: PersistenceHistory | undefined,
  current: PersistenceSchemaInventory,
): RootTransition[] {
  const changed =
    history === undefined
      ? current.roots.map((root) => root.key)
      : currentDifferences(history, current);
  return changed.map((root) =>
    rootTransition(
      history?.tips.get(root)?.root ?? null,
      current.roots.find((item) => item.key === root) ?? null,
    ),
  );
}

function reportedDifferences(
  history: PersistenceHistory,
  current: PersistenceSchemaInventory,
): ReportedChange[] {
  return currentDifferences(history, current).flatMap((root) =>
    classifyPersistenceChange(
      history.tips.get(root)?.root ?? null,
      current.roots.find((item) => item.key === root) ?? null,
    ).map((change) => ({ root, ...change })),
  );
}

function machineBlock(change: PersistenceChangeRecord): string {
  return [
    '```yaml persistence-change',
    'schemaVersion: 1',
    `id: ${change.id}`,
    `baseline: ${String(change.baseline)}`,
    'changes:',
    ...change.changes.flatMap((item) => [
      `  - root: ${JSON.stringify(item.root)}`,
      `    previous: ${item.previous === null ? 'null' : JSON.stringify(item.previous)}`,
      `    after: ${item.after === null ? 'null' : JSON.stringify(item.after)}`,
      `    decision: ${item.decision}`,
    ]),
    '```',
  ].join('\n');
}

/** 紀錄的三段說明標題（dsh 中文版的「概述／兼容性／验证」改成本 repo 的用詞）。 */
const PROSE_HEADINGS = ['摘要', '相容性', '驗證'] as const;

function scaffold(change: PersistenceChangeRecord, prose?: PersistenceChangeProse): string {
  return [
    '---',
    `description: ${JSON.stringify('記錄一次持久化型別轉換與它的相容性確認。')}`,
    'kind: persistence-change',
    '---',
    '',
    `# ${change.id}`,
    '',
    '## 摘要',
    '',
    prose?.summary ?? EXPLANATION_PLACEHOLDER,
    '',
    '## 目錄',
    '',
    '- [聲明](#declaration)',
    '- [相容性](#compatibility)',
    '- [驗證](#verification)',
    '- [開發備註](#dev-note)',
    '',
    '<a id="declaration"></a>',
    '## 聲明',
    '',
    machineBlock(change),
    '',
    '<a id="compatibility"></a>',
    '## 相容性',
    '',
    prose?.compatibility ?? EXPLANATION_PLACEHOLDER,
    '',
    '<a id="verification"></a>',
    '## 驗證',
    '',
    prose?.verification ?? EVIDENCE_PLACEHOLDER,
    '',
    '<a id="dev-note"></a>',
    '## 開發備註',
    '',
    '無。',
    '',
  ].join('\n');
}

/**
 * 解析作者明寫的說明；命令列不替作者補任何相容性或驗證的宣稱。
 *
 * @param value - `--prose` 給的 JSON 解出來的值。
 * @returns 三段完整的說明。
 */
export function parsePersistenceProse(value: unknown): PersistenceChangeProse {
  const sections = record(value, 'persistence prose');
  keys(sections, ['summary', 'compatibility', 'verification'], 'persistence prose');
  for (const [name, text] of Object.entries(sections)) {
    const content = textValue(text, name);
    if (
      content.trim().length === 0 ||
      content.includes(EXPLANATION_PLACEHOLDER) ||
      content.includes(EVIDENCE_PLACEHOLDER)
    ) {
      throw new Error(`${name} requires authored prose without scaffold placeholders`);
    }
  }
  return sections as unknown as PersistenceChangeProse;
}

function updateDocument(
  source: string,
  change: PersistenceChangeRecord,
  prose?: PersistenceChangeProse,
): string {
  source = source.replace(
    /^```yaml persistence-change[^\S\n]*\n[\s\S]*?^```[^\S\n]*$/mu,
    machineBlock(change),
  );
  if (prose === undefined) return source;
  for (const [index, text] of [prose.summary, prose.compatibility, prose.verification].entries()) {
    const lines = source.split('\n');
    const heading = `## ${PROSE_HEADINGS[index] as string}`;
    const start = lines.indexOf(heading);
    if (start < 0 || lines.lastIndexOf(heading) !== start)
      throw new Error(`--prose requires one ${heading} section in the existing record`);
    let end = lines.findIndex((line, lineIndex) => lineIndex > start && /^##? /u.test(line));
    if (end < 0) end = lines.length;
    let anchor = end;
    while (anchor > start + 1 && lines[anchor - 1] === '') anchor -= 1;
    if (/^<a id="[^"]+"><\/a>$/u.test(lines[anchor - 1] ?? '')) end = anchor - 1;
    lines.splice(start + 1, end - start - 1, '', text.trim(), '');
    source = lines.join('\n');
  }
  return source;
}

function commandOperation(args: readonly string[]): CommandResult['operation'] {
  if (args.some((arg) => arg === '--baseline' || arg.startsWith('--baseline='))) return 'baseline';
  if (args.some((arg) => arg === '--record' || arg.startsWith('--record='))) return 'record';
  if (args.some((arg) => arg === '--update' || arg.startsWith('--update='))) return 'update';
  return 'check';
}

function executeCommand(
  args: readonly string[],
  root: string,
  extract: (root: string) => PersistenceSchemaInventory,
  artifacts: (root: string, current: PersistenceSchemaInventory) => readonly PersistenceArtifact[],
): CommandResult {
  const { values } = parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: false,
    options: {
      check: { type: 'boolean' },
      baseline: { type: 'string' },
      record: { type: 'string' },
      update: { type: 'string' },
      decision: { type: 'string' },
      root: { type: 'string' },
      prose: { type: 'string' },
      json: { type: 'boolean' },
    },
  });
  if (values.root !== undefined) root = resolve(values.root);
  const selected = [
    values.check === true,
    values.baseline !== undefined,
    values.record !== undefined,
    values.update !== undefined,
  ];
  if (selected.filter(Boolean).length > 1)
    throw new Error('choose exactly one of --check, --baseline ID, --record ID, or --update ID');
  if (values.record === undefined && values.update === undefined && values.decision !== undefined)
    throw new Error('--decision requires --record or --update');
  const operation = commandOperation(args);
  if (operation === 'check' && values.prose !== undefined)
    throw new Error('--prose requires --baseline, --record, or --update');
  const prose =
    values.prose === undefined
      ? undefined
      : parsePersistenceProse(JSON.parse(readFileSync(resolve(root, values.prose), 'utf8')));
  const current = parsePersistenceSnapshot(extract(root));
  if (operation === 'check') {
    const history = verifyPersistenceChanges(root, current);
    return {
      schemaVersion: 1,
      ok: true,
      operation,
      message: `persistence changes: ${current.roots.length} roots match ${history.entries.length} history records.`,
      changes: [],
      roots: [],
      files: [],
    };
  }
  const baseline = operation === 'baseline';
  const update = operation === 'update';
  const id = identifier(values.baseline ?? values.record ?? values.update, 'record id');
  const directory = join(root, PERSISTENCE_HISTORY_DIRECTORY);
  if (
    baseline &&
    existsSync(directory) &&
    readdirSync(directory).some(
      (file) => file.endsWith('.schema.json') || ID_PATTERN.test(file.replace(/\.md$/u, '')),
    )
  )
    throw new Error('persistence baseline already exists; baseline creation cannot reset history');
  if (
    values.decision !== undefined &&
    values.decision !== 'same-version' &&
    values.decision !== 'version-bump'
  ) {
    throw new Error('--decision must be same-version or version-bump');
  }
  const entries = baseline ? [] : readPersistenceEntries(root, update ? id : undefined);
  const existing = update ? entries.find((entry) => entry.record.id === id) : undefined;
  if (update && existing === undefined)
    throw new Error(`${id}: cannot update a missing acknowledgement`);
  if (existing?.record.baseline === true) throw new Error('cannot update the persistence baseline');
  if (
    existing !== undefined &&
    entries.some((entry) => entry.record.changes.some((change) => change.previous === id))
  ) {
    throw new Error(`${id}: cannot update an acknowledgement with successors`);
  }
  const prior = entries.filter((entry) => entry !== existing);
  const history = baseline ? undefined : validatePersistenceHistory(prior);
  const changed = baseline
    ? current.roots.map((root) => root.key)
    : currentDifferences(history as PersistenceHistory, current);
  if (changed.length === 0) throw new Error('no persistence type changes to acknowledge');
  const differences = history === undefined ? [] : reportedDifferences(history, current);
  const previousHeader = history?.tips.get('SessionHeader')?.root ?? null;
  const currentHeader = current.roots.find((root) => root.key === 'SessionHeader') ?? null;
  const versionChanged =
    !baseline && headerVersion(previousHeader) !== headerVersion(currentHeader);
  if (
    values.decision === undefined &&
    !versionChanged &&
    differences.some((change) => change.requiresCompatibilityReview)
  ) {
    throw new PersistenceChangeFailure(
      `${id}: review reader compatibility and choose --decision same-version or --decision version-bump`,
      'decision-required',
      differences,
      rootTransitions(history, current),
    );
  }
  const decision =
    (values.decision as PersistenceDecision | undefined) ??
    (versionChanged ? 'version-bump' : 'same-version');
  const roots = current.roots.filter((root) => changed.includes(root.key));
  const change: PersistenceChangeRecord = {
    schemaVersion: 1,
    id,
    baseline,
    changes: changed.sort().map((key) => ({
      root: key,
      previous: history?.tips.get(key)?.id ?? null,
      after: roots.find((root) => root.key === key)?.digest ?? null,
      decision,
    })),
  };
  const snapshot: PersistenceSchemaInventory = {
    formatVersion: current.formatVersion,
    roots,
    types: [],
  };
  validatePersistenceHistory([...prior, { record: change, snapshot }]);
  const document =
    existing === undefined
      ? scaffold(change, prose)
      : updateDocument(readFileSync(join(directory, `${id}.md`), 'utf8'), change, prose);
  parseDocument(document, `${id}.md`, prose === undefined && existing === undefined);
  const recordFiles: PersistenceArtifact[] = [
    { path: `${PERSISTENCE_HISTORY_DIRECTORY}/${id}.md`, content: document },
    {
      path: `${PERSISTENCE_HISTORY_DIRECTORY}/${id}.schema.json`,
      content: JSON.stringify(snapshot, null, 2) + '\n',
    },
  ];
  if (!update && recordFiles.some((file) => existsSync(join(root, file.path))))
    throw new Error(`${id}: acknowledgement file already exists`);
  const outputs = [...artifacts(root, current), ...recordFiles];
  for (const file of outputs) mkdirSync(resolve(root, file.path, '..'), { recursive: true });
  for (const file of outputs)
    writeFileSync(resolve(root, file.path), file.content, {
      flag: recordFiles.includes(file) && !update ? 'wx' : 'w',
    });
  const completion = baseline
    ? 'Complete the record document.'
    : `Complete the compatibility and verification prose with --update ${id} --decision ${decision} --prose FILE.`;
  const message =
    existing === undefined && prose === undefined
      ? `Created ${PERSISTENCE_HISTORY_DIRECTORY}/${id}.md and its schema snapshot. ${completion}`
      : `${update ? 'Updated' : 'Created'} ${PERSISTENCE_HISTORY_DIRECTORY}/${id}.md; schema artifacts are current.`;
  return {
    schemaVersion: 1,
    ok: true,
    operation,
    recordId: id,
    message,
    changes: differences,
    roots: rootTransitions(history, current),
    files: outputs.map((file) => file.path),
  };
}

/** 預設的生成物：只有 `docs/persistence-schema.json`（dsh 另有 `persistence-catalog.md`，見檔頭）。 */
function persistenceSchemaArtifacts(
  _root: string,
  current: PersistenceSchemaInventory,
): PersistenceArtifact[] {
  return [{ path: PERSISTENCE_SCHEMA_PATH, content: renderPersistenceSchema(current) }];
}

/**
 * 只驗目前目錄，或替一次持久化型別變更寫一筆明確的確認紀錄。
 *
 * @param args - `--check`、`--baseline`、`--record` 或 `--update` 的參數；`--json` 改成結構化輸出。
 * @param root - repo 根；省略就是這個 repo。
 * @param extract - 從目前原始碼抽清單的函式；夾具傳自己的。
 * @param artifacts - 產生目前生成物的函式；夾具可以只產清單那一份。
 * @returns 文字或一個 JSON 結果；`--json` 時失敗也回 `ok:false`，由入口決定結束碼。
 */
export function runPersistenceChanges(
  args: readonly string[],
  root: string = repositoryRoot(),
  extract: (root: string) => PersistenceSchemaInventory = extractPersistenceSchema,
  artifacts: (
    root: string,
    current: PersistenceSchemaInventory,
  ) => readonly PersistenceArtifact[] = persistenceSchemaArtifacts,
): string {
  try {
    const result = executeCommand(args, root, extract, artifacts);
    return args.includes('--json') ? JSON.stringify(result) : result.message;
  } catch (error: unknown) {
    if (!args.includes('--json')) throw error;
    const result: CommandResult = {
      schemaVersion: 1,
      ok: false,
      operation: commandOperation(args),
      message: error instanceof Error ? error.message : String(error),
      code: error instanceof PersistenceChangeFailure ? error.code : 'verification-failed',
      changes: error instanceof PersistenceChangeFailure ? error.changes : [],
      roots: error instanceof PersistenceChangeFailure ? error.roots : [],
      files: [],
    };
    return JSON.stringify(result);
  }
}

// 用 `import.meta.main`，不比路徑（同 `serve.ts`）。
if (import.meta.main) {
  try {
    const output = runPersistenceChanges(process.argv.slice(2));
    console.log(output);
    if (process.argv.includes('--json') && !(JSON.parse(output) as { ok: boolean }).ok)
      process.exitCode = 1;
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

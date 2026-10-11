/**
 * [#1386](https://github.com/DemianLi/nexus-agent/issues/1386) 驗收 ④ 的素材：Loader 的樹由一份 append-only 的變更紀錄導出，不 fork Include、不寫 YAML。
 *
 * 決議 §3-5：後台每一次插拔與改設定先寫進紀錄，樹由它導出。這裡證明兩個方向都接得上，而且只用上游的公開接縫：
 *
 * - **紀錄 → 樹**：管理動作先 `append` 再呼叫 `create`／`update`／`remove`（{@link JournaledLoader.apply}）；
 *   冷啟動時把整份紀錄折成巢狀的列表（{@link fold}），交給 `loader.root.update()`——Include 讀完 YAML 之後走的就是這一個呼叫。
 * - **樹 → 紀錄**：Loader 自己發起的變更（插件 `ctx.fiber.dispose()` 自我停用、`ctx.fiber.update()` 改自己的設定）
 *   都經過 `EntryTree.commit()`。根 Loader 的 `commit()` 上游就是空的（「the root tree lives in memory only」），
 *   這裡把它換成寫紀錄；管理動作自己引起的 commit 不重複寫。
 *
 * @module
 */

import type { EntryChange, EntryOptions, Loader } from '@cordisjs/plugin-loader';

/** 紀錄的一筆。`parent` 是 group 列的 id，`null` 是根。 */
export type ChangeRecord =
  | {
      readonly op: 'create';
      readonly parent: string | null;
      readonly options: EntryOptions;
      readonly position?: number;
    }
  | {
      readonly op: 'update';
      readonly id: string;
      /** 照 `Entry.update` 的語意合併：值是 `null` 就刪掉那個鍵。 */
      readonly options: Partial<Record<keyof EntryOptions | string, unknown>>;
      readonly parent?: string | null;
      readonly position?: number;
    }
  | { readonly op: 'remove'; readonly id: string };

/** 只能往後加的紀錄。每一筆在加進去時複製並凍結。 */
export class ChangeJournal {
  readonly #records: ChangeRecord[] = [];

  get records(): readonly ChangeRecord[] {
    return this.#records;
  }

  append(record: ChangeRecord): void {
    this.#records.push(deepFreeze(structuredClone(record)));
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** 一個 group 列所在的那一列 id；根 group 是 `null`。 */
function groupId(change: EntryChange): string | null {
  return change.group.ctx.fiber.entry?.options.id ?? null;
}

/** 把 Loader 回報的一次變更寫成紀錄的一筆：update 只記差異，消失的鍵記成 `null`。 */
function recordOf(change: EntryChange): ChangeRecord {
  if (change.options === undefined) return { op: 'remove', id: change.id };
  if (change.legacy === undefined)
    return { op: 'create', parent: groupId(change), options: { ...change.options } };
  const options: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(change.options), ...Object.keys(change.legacy)])) {
    const next = (change.options as unknown as Record<string, unknown>)[key];
    const prev = (change.legacy as unknown as Record<string, unknown>)[key];
    if (JSON.stringify(next) !== JSON.stringify(prev)) options[key] = next ?? null;
  }
  return {
    op: 'update',
    id: change.id,
    options,
    ...(change.from === undefined ? {} : { parent: groupId(change) }),
  };
}

/** 接上紀錄的 Loader。 */
export class JournaledLoader {
  #applying = false;

  constructor(
    readonly loader: Loader,
    readonly journal: ChangeJournal,
  ) {
    // 上游根 Loader 的 commit 是空的；換成寫紀錄。管理動作同步觸發的那一次由 apply 自己記，不重複寫。
    // （`Loader.commit()` 宣告成不收參數，但 `EntryTree` 呼叫它時會傳 change，所以要轉型。）
    (loader as { commit: (change: EntryChange) => void }).commit = (change) => {
      if (!this.#applying) journal.append(recordOf(change));
    };
  }

  /** 管理動作：先寫紀錄，再交給 Loader。 */
  async apply(record: ChangeRecord): Promise<void> {
    this.journal.append(record);
    await applyRecord(this.loader, record, (run) => {
      this.#applying = true;
      try {
        return run();
      } finally {
        this.#applying = false;
      }
    });
  }
}

/**
 * 把一筆紀錄交給 Loader。`create`／`update`／`remove` 都在同步階段呼叫 `commit()`（tree.ts 的註解寫明），
 * 所以 `guard` 只要包住同步的那一段。
 */
export async function applyRecord(
  loader: Loader,
  record: ChangeRecord,
  guard: <T>(run: () => T) => T = (run) => run(),
): Promise<void> {
  if (record.op === 'create') {
    const options = structuredClone(record.options) as EntryOptions;
    await guard(() =>
      loader.create(options as Omit<EntryOptions, 'id'>, record.parent, record.position),
    );
  } else if (record.op === 'update') {
    const options = structuredClone(record.options) as Omit<EntryOptions, 'id' | 'name'>;
    await guard(() => loader.update(record.id, options, record.parent, record.position));
  } else {
    guard(() => loader.remove(record.id));
  }
}

/** 紀錄折成的一列：group 列的 `config` 就是它的子列。 */
type Row = EntryOptions & { config?: unknown };

/**
 * 把整份紀錄折成根 group 的列表——冷啟動時交給 `loader.root.update()`。
 * 語意照 `EntryTree.create`／`update`／`remove` 與 `Entry.update`（null 刪鍵）。
 */
export function fold(records: readonly ChangeRecord[]): EntryOptions[] {
  const root: Row[] = [];
  const rows = new Map<string, Row>();
  const parentOf = new Map<string, Row[]>();
  const listOf = (parent: string | null | undefined): Row[] => {
    if (parent === null || parent === undefined) return root;
    const row = rows.get(parent);
    if (row === undefined || !row.group) throw new Error(`紀錄裡的 group ${parent} 不存在`);
    return row.config as Row[];
  };
  const insert = (list: Row[], row: Row, position?: number) =>
    list.splice(position ?? list.length, 0, row);
  for (const record of records) {
    if (record.op === 'create') {
      const row = structuredClone(record.options) as Row;
      if (row.group) row.config = [];
      const list = listOf(record.parent);
      insert(list, row, record.position);
      rows.set(row.id, row);
      parentOf.set(row.id, list);
    } else if (record.op === 'update') {
      const row = rows.get(record.id);
      if (row === undefined) throw new Error(`紀錄裡的列 ${record.id} 不存在`);
      for (const [key, value] of Object.entries(record.options)) {
        if (row.group && key === 'config') continue;
        const fields = row as unknown as Record<string, unknown>;
        if (value === null || value === undefined) delete fields[key];
        else fields[key] = structuredClone(value);
      }
      if (record.parent !== undefined) {
        const from = parentOf.get(record.id)!;
        from.splice(from.indexOf(row), 1);
        const to = listOf(record.parent);
        insert(to, row, record.position);
        parentOf.set(record.id, to);
      }
    } else {
      const list = parentOf.get(record.id);
      const row = rows.get(record.id);
      if (list === undefined || row === undefined) continue;
      list.splice(list.indexOf(row), 1);
      rows.delete(record.id);
      parentOf.delete(record.id);
    }
  }
  return root;
}

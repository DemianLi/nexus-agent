/**
 * 插件清單的變更紀錄：只增不改的 JSONL，放在 harness home 底下
 * （[#1412](https://github.com/DemianLi/nexus-agent/issues/1412)，Part of #1385）。
 *
 * ## 它是什麼
 *
 * 決議 `.docs/decisions-2026-10-11.md` §3-5 第 18 條：**真相來源是 append-only 的稽核變更紀錄**。後台（今天是主機端的
 * `plugin-cli.ts`）每一次停用、啟用、改設定先寫進這份紀錄；`plugin-config.ts` 把它折成 dsh 的「profile patch」那一層，
 * 疊進清單。插件與載入器都不寫回 YAML。這個模組只管紀錄本身：格式、讀、折、寫；怎麼疊進清單在 `plugin-config.ts`，
 * 怎麼驗證一筆變更在 `plugin-change.ts`。它不 import `plugin-config.ts`，兩邊不成環。
 *
 * ## 一行一筆
 *
 * ```
 * {"v":1,"seq":3,"at":"2026-10-13T…Z","actor":{…},"op":"config-set","id":"todo","name":"@nexus/plugin-todo","before":null,"after":{…}}
 * ```
 *
 * | `op` | 意思 | 折出來的 patch |
 * |---|---|---|
 * | `disable`／`enable` | 停用、啟用一列 | `{ id, disabled }` |
 * | `config-set` | 整份替換一列的 `config` | `{ id, name, config }` |
 * | `config-reset` | 恢復成繼承值 | 拿掉那一列的 `config` 覆蓋 |
 * | `patch` | 遷移用：原樣收一條舊 `cordis.patch.yml` 的 patch（含 `insert`、`name` 斷言），寫入口不開 | 原樣 |
 * | `rejected` | 寫入口驗不過、沒有生效的一次變更（[#1414](https://github.com/DemianLi/nexus-agent/issues/1414)）：操作者、要做的操作、列 id、原因原文；**不帶要寫入的值** | **不折**，清單不因它改變 |
 * | `failed` | serve 發現某一列掛不上，而那一列在紀錄裡有被接受的改動（#1414）：歸因的那一筆的 `seq`（`triggerSeq`，**歸因，不保證是原因**）、掉在哪一步、原因原文 | **不折** |
 * | `self-disabled` | 插件在 `apply` 裡自己 `ctx.fiber.dispose()`（Loader 的 case 7，[#1424](https://github.com/DemianLi/nexus-agent/issues/1424)）：列 id 與模組名。**不帶原因**：插件沒有講原因的管道，要查的是那個插件自己的日誌 | **不折** |
 *
 * `rejected`／`failed`／`self-disabled` **只記不折**：照樣佔序號、序號照樣從 1 連續，`foldJournal` 與 `journalOverrideOf` 跳過
 * 它們，所以同一份紀錄有它們與沒有它們，折出來的清單相同。它們讓「被拒絕的變更」「掛不上的列」「插件自己停用了自己」進稽核，
 * 不是讓它們有作用。**`self-disabled` 不是「有人把這一列關了」**：樹上那一列只在 serve 行程裡停著（`plugin-tree.ts`），
 * 重啟就再試一次；真的要它一直關著，要走寫入口的 `disable`。
 *
 * `before`／`after` 是**明文**（Q4，demian 2026-10-13）：這份檔取代的是 `cordis.patch.yml`，暴露面一樣，檔案 0600。
 *
 * ## 並發與壞掉的行（Q5）
 *
 * - **寫端**：取跨行程鎖 → 檔尾沒有換行就先截掉那半行（它從來沒回報成功，不丟任何稽核過的資料）→ 驗 → 追加整行 → fsync → 才回報。
 * - **讀端**：不取鎖。最後一行沒有換行結尾，當成「還沒寫完的那一筆」略過。
 * - **其餘壞掉**（中間某行解析不了、序號跳號或倒退）：拋 {@link PluginJournalError}，訊息指名第幾行。
 *
 * ## 偏離登記
 *
 * 1. **append 的耐久原語**：dsh 只有整檔 rename、不做 fsync 的 `writeFileAtomic`（`packages/util/atomic-write/src/index.ts:79`）。
 *    稽核紀錄要「回報成功就已落盤」，所以這裡是 `O_APPEND` 寫一整行加 `fsync`，不能說是照 dsh。
 * 2. **鎖照 dsh 的 `withFileLock`**（`:235`）：`wx` 建 `<file>.lock`、記 PID、持有者行程不在了就接手（`:97`、`:108`、`:146`）。
 *    **差在等待上限**：dsh 預設 2 秒（`:196`），並明寫「持有者的操作合法地跑得比檔案工作久時要自己給 `waitMs`」（`:200-208`）。
 *    這裡持鎖的時候要驗證一筆變更、載入模組，所以預設 30 秒。
 * 3. **同一個行程裡先排隊、再取檔案鎖**（[#1450](https://github.com/DemianLi/nexus-agent/issues/1450)）：dsh 的
 *    `withFileLock` 本身沒有行程內佇列，但它的呼叫端有（`credentials-local/src/index.ts:683` 的 `modifyRecord` 先
 *    `this.enqueue(...)`、再 `withFileLock`），所以同一行程的寫入從來不互相搶鎖檔。這裡的寫入口有兩處（寫入口與
 *    `prepareJournal`），把佇列放進 {@link withFileLock} 一處，而不是各自在呼叫端排。差別只在位置，語意同 dsh。
 *    不排隊的時候，同一行程的 N 個寫入全靠鎖檔輪流、後面的每輪睡滿 200 毫秒，實測 25 筆要 4.4 秒，其中 4 秒是睡眠。
 *
 * @module
 */

import { createHash } from 'node:crypto';
import { constants, readFileSync } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { z } from 'zod';

/** 紀錄檔在 harness home 底下的檔名。 */
export const PLUGIN_JOURNAL_FILE_NAME = 'plugin-journal.jsonl';

/** 紀錄的格式版本。 */
export const PLUGIN_JOURNAL_VERSION = 1;

/** 紀錄壞了：訊息指名檔案與第幾行。 */
export class PluginJournalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginJournalError';
  }
}

const nonEmpty = z.string().min(1);

/**
 * 誰寫的。**沒有管理員身分**（#1385 排程第 3 步才有），所以記的是主機帳號：`effective` 是行程實際的有效帳號，
 * 作業系統給的；`invoker` 是 sudo 之前原本登入的帳號，**從環境變數自報**，任何人都改得了，`invokerSource` 寫它是從哪個
 * 變數讀來的。它不是身分認證。管理員身分落地後，wire 路由寫進同一份紀錄，actor 換成 `{ kind: 'admin', … }`。
 */
export const actorSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('host-account'),
    effective: nonEmpty,
    invoker: nonEmpty.nullable(),
    invokerSource: nonEmpty.nullable(),
  }),
  /** serve 寫的（#1414 的 `failed`）：行程的有效帳號，作業系統給的。 */
  z.strictObject({
    kind: z.literal('serve'),
    effective: nonEmpty,
  }),
  z.strictObject({
    kind: z.literal('migration'),
    /** 遷移的來源檔（絕對路徑）。 */
    source: nonEmpty,
    /** 來源檔全文的 SHA-256，讓遷移那一刻的內容對得上 `.migrated-*` 那份。 */
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
]);

/** 誰寫的，{@link actorSchema} 的輸出。 */
export type JournalActor = z.infer<typeof actorSchema>;

const configValue = z.record(z.string(), z.unknown());

const envelope = {
  v: z.literal(PLUGIN_JOURNAL_VERSION),
  seq: z.number().int().min(1),
  at: z.iso.datetime(),
  actor: actorSchema,
};

/** 一筆紀錄。`strictObject`：多一個欄位是壞掉的檔，不是擴充點。 */
export const journalRecordSchema = z.discriminatedUnion('op', [
  z.strictObject({
    ...envelope,
    op: z.literal('disable'),
    id: nonEmpty,
    name: nonEmpty,
    before: z.boolean(),
    after: z.literal(true),
  }),
  z.strictObject({
    ...envelope,
    op: z.literal('enable'),
    id: nonEmpty,
    name: nonEmpty,
    before: z.boolean(),
    after: z.literal(false),
  }),
  z.strictObject({
    ...envelope,
    op: z.literal('config-set'),
    id: nonEmpty,
    name: nonEmpty,
    before: configValue.nullable(),
    after: configValue,
  }),
  z.strictObject({
    ...envelope,
    op: z.literal('config-reset'),
    id: nonEmpty,
    name: nonEmpty,
    /** 被拿掉的那份覆蓋；紀錄裡原本沒有覆蓋就是 `null`（寫入口不會為此追加一筆）。 */
    before: configValue.nullable(),
    /** 當時的繼承值，**只給人看，折疊不用它**：用了就等於把出貨值抄了一份，下一版改預設會被釘住。 */
    after: configValue.nullable(),
    /**
     * 使用者實際下的是 `config-set`，而新值等於繼承值，所以記成恢復（照 dsh `config-editor/src/index.ts:119-125`：
     * 新值等於繼承值就拿掉那一列的覆蓋，不抄一份）。沒有這個欄位就是使用者直接下的 reset。
     */
    requested: z.literal('config-set').optional(),
  }),
  z.strictObject({
    ...envelope,
    op: z.literal('patch'),
    patch: z.record(z.string(), z.unknown()),
  }),
  /**
   * 寫入口拒絕的一次變更（#1414 Q1）。**不帶要寫入的設定值**：`reason` 是驗證器回的原文，可能引到值的一部分，逐字剔除
   * 做不可靠；紀錄是 0600、前後值本來就是明文（#1412 Q4），所以原文進紀錄沒有新增暴露面。
   *
   * `id` 與 `reason` 不用 `nonEmpty`：這一筆是「使用者要求了什麼」的記錄，id 是空字串也是一種被拒絕的要求；parse 失敗的話
   * 拒絕本身就會被一個 ZodError 吞掉。
   */
  z.strictObject({
    ...envelope,
    op: z.literal('rejected'),
    /** 使用者要做的操作；不能叫 `op`，那是這一筆自己的種類。 */
    requested: z.enum(['disable', 'enable', 'config-set', 'config-reset']),
    id: z.string(),
    reason: z.string(),
  }),
  /**
   * serve 發現這一列掛不上，而紀錄裡有一筆被接受的改動指到它（#1414 Q2）。
   *
   * **`triggerSeq` 是歸因，不是因果**：掉的那一刻，紀錄裡最後一筆碰到這一列、被接受的紀錄（含遷移的 `patch`）。它不保證
   * 是這次掛不上的原因，所以讀的人不要把責任算到那一筆的操作者頭上。例如 A 早年改過設定，後來因為 B 被停用而掉在
   * `requires`，歸因指到 A 那筆舊改動；出貨版本升級後才掉的列，也指到它最後一次被改的那一筆。
   *
   * 去重鍵是「列 id ＋ `triggerSeq`」：同一次歸因只記一次、跨重啟也不重複。
   */
  z.strictObject({
    ...envelope,
    op: z.literal('failed'),
    id: nonEmpty,
    triggerSeq: z.number().int().min(1),
    stage: z.enum(['module', 'config', 'apply', 'requires']),
    reason: z.string(),
  }),
  /**
   * 插件自己停用了自己（#1424，demian 2026-10-14 拍板 Q1 (b)、Q2 (a)）：Loader 的 case 7 在呼叫點發的事件，serve 寫。
   * **只記不折**：樹上那一列只在這個行程裡停著，清單不因它改變。去重在行程記憶裡（列 id ＋ 宣告），重啟後那一列重新掛上、
   * 又自己停用，算一次新的事件、再記一筆。actor 沿用 `serve`：寫這一筆的就是 serve，「是插件自己停的」由這個 op 承載。
   */
  z.strictObject({
    ...envelope,
    op: z.literal('self-disabled'),
    id: nonEmpty,
    name: nonEmpty,
  }),
]);

/** 一筆紀錄。 */
export type JournalRecord = z.infer<typeof journalRecordSchema>;

/** 折疊只看這些：寫入前驗證時，還沒有序號與時間的那一筆也折得了。 */
export type JournalBody = DistributiveOmit<JournalRecord, 'v' | 'seq' | 'at' | 'actor'>;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** 一份讀進來的紀錄。 */
export interface JournalContents {
  readonly records: readonly JournalRecord[];
  /** 最後一行沒有換行結尾，已略過。 */
  readonly incompleteTail: boolean;
  /** 完整那一段的位元組數（寫端截斷用）。 */
  readonly completeBytes: number;
}

/**
 * 解析紀錄全文。
 *
 * @param bytes - 檔案全文。
 * @param label - 訊息裡怎麼稱呼這個檔（路徑）。
 * @returns 紀錄、最後一行有沒有略過。
 * @throws {PluginJournalError} 中間某行壞了，或序號不是 1、2、3……。
 */
export function parseJournal(bytes: Uint8Array, label: string): JournalContents {
  const buffer = Buffer.from(bytes);
  const lastNewline = buffer.lastIndexOf(0x0a);
  const completeBytes = lastNewline + 1;
  const incompleteTail = completeBytes < buffer.length;
  const text = buffer.subarray(0, completeBytes).toString('utf8');
  const lines = text === '' ? [] : text.slice(0, -1).split('\n');
  const records: JournalRecord[] = [];
  for (const [index, line] of lines.entries()) {
    const where = `${label} 第 ${String(index + 1)} 行`;
    let raw: unknown;
    try {
      raw = JSON.parse(line) as unknown;
    } catch {
      throw new PluginJournalError(
        `${where}不是合法的 JSON（${line === '' ? '空行' : '解析失敗'}）。紀錄只增不改，這一行之後的內容讀不了；` +
          '救援步驟見 docs/operations.md「變更紀錄壞了」。',
      );
    }
    const parsed = journalRecordSchema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(根)'}：${issue.message}`)
        .join('；');
      throw new PluginJournalError(`${where}不是一筆合法的紀錄 — ${issues}`);
    }
    const expected = records.length + 1;
    if (parsed.data.seq !== expected) {
      throw new PluginJournalError(
        `${where}的序號是 ${String(parsed.data.seq)}，應該是 ${String(expected)}` +
          `（序號跳號或倒退：這份紀錄被改動過，或有人手動搬過行）。`,
      );
    }
    if (parsed.data.op === 'failed') {
      // 指向的必須是更早、而且被接受的那一筆：指向自己、未來或另一筆只記不折的，是被人手動動過的檔。
      const target = records[parsed.data.triggerSeq - 1];
      if (target === undefined || !isAcceptedRecord(target)) {
        throw new PluginJournalError(
          `${where}是一筆 failed，卻指向第 ${String(parsed.data.triggerSeq)} 筆` +
            `（${target === undefined ? '那一筆還不存在' : `那是 ${target.op}，不是被接受的改動`}）。`,
        );
      }
    }
    records.push(parsed.data);
  }
  return { records, incompleteTail, completeBytes };
}

/** 讀紀錄時多做的事。 */
export interface ReadJournalOptions {
  /** 讀完之後對這個路徑檢查權限（`plugin-config.ts` 的 `assertPrivateFile`）；不過就拋。 */
  readonly check?: (path: string) => void;
}

/**
 * 讀紀錄檔。檔案不在回 `undefined`，其餘讀不了一律拋。
 *
 * @param path - 紀錄檔的絕對路徑。
 * @param options - 權限檢查。
 * @returns 內容；檔案不在時 `undefined`。
 * @throws {PluginJournalError} 讀不了、壞掉的行、序號不連續。
 */
export function readJournal(
  path: string,
  options: ReadJournalOptions = {},
): JournalContents | undefined {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined;
    throw new PluginJournalError(`讀不到 ${path}：${String(error)}`);
  }
  options.check?.(path);
  return parseJournal(bytes, path);
}

/** 沒有 `id` 的 patch 不會出現在折疊裡（`insert` 之外的 patch 一定要有）。 */
function isOverrideOf(patch: Record<string, unknown>, id: string): boolean {
  return patch['id'] === id && patch['insert'] === undefined;
}

/**
 * 這條覆蓋項的 `name` 斷言跟這一列對得上嗎：沒寫就是沒有斷言，寫了就要相等。**折疊與 {@link journalOverrideOf} 共用這一個
 * 函式**，不然「哪一條是這一列的覆蓋項」會有兩套答案。
 *
 * 空字串**不**當成沒寫：`patchSchema` 的 `name` 是 `min(1)`（`plugin-config.ts`），含 `name: ''` 的覆蓋項過不了那一關，
 * 讀端讀到會拋、指名那一列，所以到不了這裡之後的任何一步。dsh 的 `!expectedName`（`plugin-manager/src/patch.ts:34-35`）
 * 把空字串也算沒斷言，但它的 patch 檔沒有這一關；我們的檔有，單獨留一支空字串的分支只會讓兩邊各說各話。
 */
function nameAssertionMatches(patch: Record<string, unknown>, name: string): boolean {
  return patch['name'] === undefined || patch['name'] === name;
}

/**
 * 把紀錄折成 patch 清單，**一列一條覆蓋項**（照 dsh）：
 *
 * - 開關：改**最後一條**相符的覆蓋項的 `disabled`，沒有就追加（`packages/boot/plugin-manager/src/patch.ts:14-43`，相符＝同 id、
 *   不是 `insert`、`name` 沒寫或等於這一列的；{@link nameAssertionMatches}）。
 * - 設定：改同一條的 `config`，沒有就追加 `{ id, name, config }`（`packages/boot/config-editor/src/index.ts:119-135`）。
 * - 恢復成繼承值：拿掉**那一列所有**覆蓋項的 `config`，只剩 `id`／`name` 的整條拿掉（`:120-129`）。**不是把出貨值抄一份。**
 * - 遷移來的 `patch` 原樣接上，保留它在清單裡的位置（`insert` 之後的 patch 才指得到插進來的列）。
 *
 * 同一列後來的操作蓋掉前面的，所以結果的長度不隨紀錄筆數長。純函式，不改輸入。
 *
 * @param records - 已讀進來的紀錄，或再加一筆還沒寫的。
 * @returns patch 清單，還沒驗形狀。
 */
export function foldJournal(records: readonly JournalBody[]): Record<string, unknown>[] {
  const patches: Record<string, unknown>[] = [];
  const lastOverride = (id: string, name: string): Record<string, unknown> | undefined =>
    patches.findLast((patch) => isOverrideOf(patch, id) && nameAssertionMatches(patch, name));
  for (const record of records) {
    switch (record.op) {
      case 'patch':
        patches.push(structuredClone(record.patch));
        break;
      case 'disable':
      case 'enable': {
        const disabled = record.op === 'disable';
        const target = lastOverride(record.id, record.name);
        if (target === undefined) patches.push({ id: record.id, disabled });
        else target['disabled'] = disabled;
        break;
      }
      case 'config-set': {
        const target = lastOverride(record.id, record.name);
        const config = structuredClone(record.after);
        if (target === undefined) patches.push({ id: record.id, name: record.name, config });
        else target['config'] = config;
        break;
      }
      case 'config-reset':
        for (let index = patches.length - 1; index >= 0; index -= 1) {
          const patch = patches[index];
          if (patch === undefined || !isOverrideOf(patch, record.id)) continue;
          Reflect.deleteProperty(patch, 'config');
          const rest = Object.keys(patch).filter((key) => key !== 'id' && key !== 'name');
          if (rest.length === 0) patches.splice(index, 1);
        }
        break;
      case 'rejected':
      case 'failed':
        // 只記不折：沒有任何改動生效過（#1414）。
        break;
      case 'self-disabled':
        // 同上：樹上只在行程裡停著，清單不變（#1424）。
        break;
    }
  }
  return patches;
}

/**
 * 紀錄裡這一列自己的覆蓋項（不含 `insert`），沒有就 `undefined`。寫入口拿它判斷「這一筆有沒有改變任何東西」。
 *
 * @param records - 已讀進來的紀錄。
 * @param id - 列 id。
 * @param name - 那一列的模組名。
 * @returns 折疊後那一列的覆蓋項。
 */
export function journalOverrideOf(
  records: readonly JournalBody[],
  id: string,
  name: string,
): { readonly disabled?: boolean; readonly config?: Record<string, unknown> } | undefined {
  const patch = foldJournal(records).findLast(
    (candidate) => isOverrideOf(candidate, id) && nameAssertionMatches(candidate, name),
  );
  if (patch === undefined) return undefined;
  const disabled = patch['disabled'];
  const config = patch['config'];
  return {
    ...(typeof disabled === 'boolean' && { disabled }),
    ...(typeof config === 'object' &&
      config !== null && { config: config as Record<string, unknown> }),
  };
}

// ── serve 記 `failed`：歸因到哪一筆（#1414）──────────────────────────────────────────────────

/** serve 掉了的一列：id，與那一列的模組名（沒寫 id 的 `insert` 列只能用模組名比）。 */
export interface FailedRowIdentity {
  readonly id: string;
  readonly module: string;
}

/** 在哪裡發現這一列掛不上。 */
export type FailureDiscovery = 'startup' | 'reread' | 'thread-assembly';

/** 判斷這一列要不要記 `failed` 時用得到的場面。 */
export interface FailureContext {
  readonly discoveredAt: FailureDiscovery;
  /**
   * 這一列掉在哪一步（#1423）：新規則只認 `requires`。放在場面而不是列的身分上：它是「這一次怎麼掉的」，不是「這一列是誰」。
   * 省略就不套新規則（舊的呼叫端與測試不帶）。
   */
  readonly stage?: 'module' | 'config' | 'apply' | 'requires';
  /**
   * 上一次組裝或重讀的時候這一列還掛著、這一次掉了（#1423）；上一次就已經掉了、或沒有資料，就是 `false`／`undefined`。
   * 啟動那一份的結果是起點。
   */
  readonly newlyDropped?: boolean;
}

/**
 * 這一筆是不是「被接受的」改動：生效過、折得進清單的那幾種。`rejected`（被攔下）、`failed`（掛不上）與 `self-disabled`（插件自己停用）是只記不折的筆，不是。
 *
 * **逐一列舉、不寫 `default`**：以後再加一種只記不折的 op（#1424 的 `self-disabled`），這裡不補一格就編不過；
 * 寫成「不是 `rejected` 也不是 `failed`」的排除法，新 op 會被靜靜當成被接受的。
 *
 * @param record - 一筆紀錄（或還沒有序號與時間的那一筆）。
 * @returns 被接受的改動是 `true`。
 */
export function isAcceptedRecord(record: Pick<JournalRecord, 'op'>): boolean {
  switch (record.op) {
    case 'disable':
    case 'enable':
    case 'config-set':
    case 'config-reset':
    case 'patch':
      return true;
    case 'rejected':
    case 'failed':
    case 'self-disabled':
      return false;
  }
}

/**
 * 紀錄裡這一筆是不是指到那一列：**跟折疊同一套規矩**（{@link isOverrideOf}、{@link nameAssertionMatches}），
 * 不然「哪些紀錄碰過這一列」會有兩套答案。`config-reset` 同折疊不看 `name`；`config-set` 折出來的覆蓋項帶 `name` 斷言，
 * 模組名對不上的那一筆在這一列上沒有作用；遷移進來的 `insert`，沒寫 id 的列（id 是載入器補的 `<name>#<n>`）用模組名比。
 */
function touchesRow(record: JournalRecord, row: FailedRowIdentity): boolean {
  switch (record.op) {
    case 'disable':
    case 'enable':
    case 'config-reset':
      return record.id === row.id;
    case 'config-set':
      return record.id === row.id && record.name === row.module;
    case 'patch': {
      const insert = record.patch['insert'];
      if (Array.isArray(insert)) {
        const inserted = insert.some((candidate: unknown) => {
          if (typeof candidate !== 'object' || candidate === null) return false;
          const fields = candidate as Record<string, unknown>;
          return (
            fields['id'] === row.id || (fields['id'] === undefined && fields['name'] === row.module)
          );
        });
        if (inserted) return true;
      }
      return record.patch['id'] === row.id && nameAssertionMatches(record.patch, row.module);
    }
    case 'rejected':
    case 'failed':
    case 'self-disabled':
      // 只記不折的筆不「碰」任何一列：它們沒有改變那一列的宣告，也不能被歸因（#1424）。
      return false;
  }
}

/**
 * **這一列要不要記 `failed`，答案只在這一處**（PM 2026-10-13；#1423 補了第二條規則）。
 *
 * **規則一（#1414 Q2）**：那一列在紀錄裡有被接受的改動才記，**歸因**到**最後一筆**碰到它的、被接受的紀錄
 * （含遷移的 `patch`）。只被出貨設定或 `--patch` 影響而掛不上的列，紀錄裡沒有任何一筆指到它，照今天只進日誌。
 *
 * **規則二（#1423，demian 拍板於 #1414 issuecomment-6157679809）**：A 依賴 B、用寫入口關掉 B，A 自己在紀錄裡沒有
 * 改動，掉在 `requires`。規則一回 `undefined`，這時下面四件事**同時**成立就歸因到紀錄裡**最新一筆被接受的**：
 *
 * 1. serve 跑著的期間：`discoveredAt` 是 `reread` 或 `thread-assembly`，不含 `startup`（啟動試組不套）；
 * 2. `newlyDropped === true`：上一次組裝或重讀時它還掛著；
 * 3. `stage === 'requires'`：`apply` 會因為每條 thread 的工作區不同而一條掛一條掉，不能一律當成紀錄造成的，
 *    只有 `requires`（依賴的列在不在）在 serve 跑著時只會因為紀錄改了而變；
 * 4. 規則一回 `undefined`（這一列自己沒有被接受的改動）。
 *
 * **這是歸因規則，不是因果**：回傳的 `seq` 不保證是這次掛不上的原因。規則一的例子：A 早年改過設定（seq 2），後來因為
 * B 被停用而 A 掉在 `requires`，歸因指到 seq 2。規則二的已知邊角：B 自己在某條 thread 因為工作區而 `apply` 失敗、
 * 連帶 A 掉在 `requires`，A 會被歸因到當時最新的那一筆紀錄，而那一筆跟這次掉落無關；這個邊角接受，不另外處理。
 * 欄位叫 `triggerSeq` 是格式只增不改、改名的成本以後只會更高（PM 2026-10-13）；讀的時候要當歸因讀。
 *
 * @param records - 現在紀錄檔裡的全部紀錄。
 * @param row - 掉了的那一列。
 * @param context - 在哪裡發現的、掉在哪一步、是不是剛掉的。
 * @returns 歸因到的那一筆的 `seq`；不記就 `undefined`。
 */
export function failureTriggerOf(
  records: readonly JournalRecord[],
  row: FailedRowIdentity,
  context: FailureContext,
): number | undefined {
  const own = records.findLast((record) => touchesRow(record, row))?.seq;
  if (own !== undefined) return own;
  if (
    context.discoveredAt === 'startup' ||
    context.newlyDropped !== true ||
    context.stage !== 'requires'
  ) {
    return undefined;
  }
  // 「被接受」見 `isAcceptedRecord`（遷移來的 `patch` 也算）。
  return records.findLast(isAcceptedRecord)?.seq;
}

/** 紀錄裡已經有同一列、歸因到同一筆的 `failed` 了嗎。 */
export function hasFailedRecord(
  records: readonly JournalRecord[],
  id: string,
  triggerSeq: number,
): boolean {
  return records.some(
    (record) => record.op === 'failed' && record.id === id && record.triggerSeq === triggerSeq,
  );
}

// ── 跨行程鎖，照 dsh `withFileLock`（packages/util/atomic-write/src/index.ts:235）────────────────

const LOCK_RETRY_INITIAL_MS = 20;
const LOCK_RETRY_MAX_MS = 200;
/** 預設等多久。dsh 是 2 秒；這裡持鎖時要驗證一筆變更，見檔頭偏離登記第 2 條。 */
export const DEFAULT_LOCK_WAIT_MS = 30_000;

async function isLockContention(error: unknown, lockPath: string): Promise<boolean> {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === 'EEXIST') return true;
  if (code !== 'EPERM') return false;
  try {
    await lstat(lockPath);
    return true;
  } catch {
    // 鎖存在與否查不出來：原本的 EPERM 才算數。
    return false;
  }
}

/** 鎖檔記的持有者行程證實不在了。其餘內容（正在寫、被截斷）什麼也證明不了。 */
function holderExited(record: string): boolean {
  if (!/^\d+\n$/u.test(record)) return false;
  const pid = Number(record.trim());
  if (pid === 0 || pid > 0x7fffffff || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // EPERM：行程在，屬於別的使用者。
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

async function readLockRecord(lockPath: string): Promise<string | undefined> {
  try {
    return await readFile(lockPath, 'utf8');
  } catch {
    // 鎖檔剛好消失：什麼也證明不了。
    return undefined;
  }
}

/**
 * 持有者行程已不在，就接手那把鎖。照 dsh（`:146`）：讀到同一筆紀錄的搶鎖者在「以該紀錄命名的 claim 檔」上排隊，
 * 拿到 claim 的重新確認紀錄與 PID 仍是那一筆才刪，所以不會刪掉別人在死掉的持有者之後拿到的鎖。
 */
async function takeOverExitedLock(lockPath: string): Promise<boolean> {
  const record = await readLockRecord(lockPath);
  if (record === undefined || !holderExited(record)) return false;
  const digest = createHash('sha256').update(record).digest('hex').slice(0, 16);
  const claim = `${lockPath}.takeover-${digest}`;
  try {
    await writeFile(claim, `${String(process.pid)}\n`, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST' || code === 'EPERM') return false;
    throw error;
  }
  try {
    if ((await readLockRecord(lockPath)) !== record || !holderExited(record)) return false;
    await rm(lockPath, { force: true });
    return true;
  } finally {
    // claim 留下來也只是指著一筆已不是鎖的紀錄，不擋後來的接手。
    await rm(claim, { force: true }).catch(() => undefined);
  }
}

/** 同一個行程裡每個鎖檔的佇列尾巴：新來的接在它後面，輪到才去搶鎖檔。見 {@link withFileLock}。 */
const inProcessTails = new Map<string, Promise<void>>();

function lockTimeoutError(lockPath: string, waitMs: number): PluginJournalError {
  return new PluginJournalError(
    `等不到 ${lockPath} 的寫入鎖（${String(waitMs)} 毫秒）。` +
      '另一個寫入口還在跑，或它當掉後鎖檔沒有被接手（持有者的 PID 還活著）；確認那個行程之後才可以手動刪鎖檔。',
  );
}

/** 等 `previous` 結束，但不超過 `deadline`；超過就拋。 */
async function waitForPredecessor(
  previous: Promise<void>,
  deadline: number,
  lockPath: string,
  waitMs: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => {
        reject(lockTimeoutError(lockPath, waitMs));
      },
      Math.max(0, deadline - Date.now()),
    );
  });
  try {
    await Promise.race([previous, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 在持有 `<filename>.lock` 的期間執行 `operation`。
 *
 * **同一個行程裡的呼叫先排隊，輪到才去搶鎖檔**（#1450，偏離登記第 3 條）：鎖檔只剩跨行程的那一層要爭，行程內不空睡。
 * 佇列以 `resolve(filename)` 為鍵；同一個檔的不同寫法（符號連結等）不會共用佇列，但照樣被鎖檔擋住，只是慢。
 * `waitMs` 從進來的那一刻算起，排隊的時間也算在裡面。
 *
 * **不可重入**：`operation` 裡不能再呼叫同一個檔的 {@link withFileLock}。鎖檔本來就擋它（等到逾時），佇列則是
 * 等前一個結束，所以會等到 `waitMs` 才拋，同鎖檔的行為。
 *
 * @param filename - 要序列化寫入的檔。
 * @param operation - 持鎖期間做的事；結束（含拋）才放鎖。
 * @param options.waitMs - 最多等多久（含排隊），預設 {@link DEFAULT_LOCK_WAIT_MS}。
 * @returns `operation` 的回傳值。
 * @throws 等不到鎖。
 */
export async function withFileLock<T>(
  filename: string,
  operation: () => Promise<T>,
  options: { readonly waitMs?: number } = {},
): Promise<T> {
  const lockPath = `${filename}.lock`;
  const waitMs = options.waitMs ?? DEFAULT_LOCK_WAIT_MS;
  const deadline = Date.now() + waitMs;

  const queueKey = resolve(lockPath);
  const previous = inProcessTails.get(queueKey) ?? Promise.resolve();
  let leave!: () => void;
  const mine = new Promise<void>((done) => {
    leave = done;
  });
  // 我之後的人等我、也等我前面的：就算我等不到逾時先離開，順序也不會亂。
  const tail = previous.then(() => mine);
  inProcessTails.set(queueKey, tail);
  try {
    await waitForPredecessor(previous, deadline, lockPath, waitMs);
    return await withLockFile(lockPath, operation, deadline, waitMs);
  } finally {
    leave();
    if (inProcessTails.get(queueKey) === tail) inProcessTails.delete(queueKey);
  }
}

/** 只管跨行程那一層：`wx` 建鎖檔、搶不到就退避、持有者不在了就接手。 */
async function withLockFile<T>(
  lockPath: string,
  operation: () => Promise<T>,
  deadline: number,
  waitMs: number,
): Promise<T> {
  let delay = LOCK_RETRY_INITIAL_MS;
  for (;;) {
    try {
      await writeFile(lockPath, `${String(process.pid)}\n`, { mode: 0o600, flag: 'wx' });
      break;
    } catch (error) {
      if (!(await isLockContention(error, lockPath))) throw error;
      if (await takeOverExitedLock(lockPath)) continue;
    }
    if (Date.now() >= deadline) throw lockTimeoutError(lockPath, waitMs);
    await new Promise((done) => setTimeout(done, delay));
    delay = Math.min(delay * 2, LOCK_RETRY_MAX_MS);
  }
  try {
    return await operation();
  } finally {
    await rm(lockPath, { force: true });
  }
}

// ── 寫端 ─────────────────────────────────────────────────────────────────────────────────────

/** {@link appendJournalRecord} 的選項。 */
export interface AppendJournalOptions {
  readonly actor: JournalActor;
  /** 算 `at` 用，測試給固定的。省略即現在。 */
  readonly now?: () => Date;
  /** 截掉半行時往哪裡講，省略即標準錯誤。 */
  readonly warn?: (message: string) => void;
  /** 拿到鎖之後、讀之前對紀錄檔跑的權限檢查。 */
  readonly check?: (path: string) => void;
  /** 等鎖多久，見 {@link withFileLock}。 */
  readonly waitMs?: number;
}

/** fsync 一個目錄：新建檔案之後，名字本身也要落盤。平台不給就算了。 */
async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, constants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Windows 開不了目錄；檔案內容已經 fsync，這一步只是更保守。
  }
}

/**
 * 追加一筆。**驗證與追加在同一把鎖裡**：兩個寫入口同時進來，後拿到鎖的驗證時已經看得到前一筆，序號嚴格遞增。
 *
 * @param path - 紀錄檔的絕對路徑；不在就建（0600，目錄 0700）。
 * @param options - 誰寫的、時間、警告出口。
 * @param prepare - 拿到鎖、讀完現有紀錄之後呼叫，回傳要追加的內容；回 `undefined` 就什麼都不寫。**驗證在這裡做，
 *   拋了就一個位元組都不寫**（只增不改沒有回滾，驗證必須在前面）。
 * @returns 寫進去的那一筆；`prepare` 回 `undefined` 時 `undefined`。
 * @throws {PluginJournalError} 現有紀錄壞了（不在壞掉的檔後面追加）、等不到鎖。
 */
export async function appendJournalRecord(
  path: string,
  options: AppendJournalOptions,
  prepare: (
    records: readonly JournalRecord[],
  ) => Promise<JournalBody | undefined> | JournalBody | undefined,
): Promise<JournalRecord | undefined> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const warn = options.warn ?? ((message: string) => process.stderr.write(`${message}\n`));
  const now = options.now ?? (() => new Date());
  return withFileLock(
    path,
    async () => {
      let bytes: Buffer | undefined;
      try {
        bytes = await readFile(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error;
      }
      const created = bytes === undefined;
      const handle = await open(path, 'a+', 0o600);
      try {
        options.check?.(path);
        const contents = parseJournal(bytes ?? Buffer.alloc(0), path);
        if (contents.incompleteTail) {
          // 寫到一半當掉留下的半行：它從來沒回報成功，截掉不丟任何稽核過的資料；不截的話下一筆會跟它黏成一行壞資料。
          await handle.truncate(contents.completeBytes);
          warn(
            `[變更紀錄] ${path} 的最後一行沒有寫完（上一次寫入中途當掉），已截掉那半行再追加；` +
              `那一筆從來沒有回報成功。`,
          );
        }
        const body = await prepare(contents.records);
        if (body === undefined) return undefined;
        const record = journalRecordSchema.parse({
          v: PLUGIN_JOURNAL_VERSION,
          seq: contents.records.length + 1,
          at: now().toISOString(),
          actor: options.actor,
          ...body,
        });
        await handle.write(`${JSON.stringify(record)}\n`);
        await handle.sync();
        if (created) await syncDirectory(directory);
        return record;
      } finally {
        await handle.close();
      }
    },
    options.waitMs === undefined ? {} : { waitMs: options.waitMs },
  );
}

/**
 * 一次建好整份紀錄檔（遷移與建空檔用）：寫暫存檔、fsync、rename 進位，讀端只會看到不存在或完整的那份。
 * **呼叫端要在 {@link withFileLock} 裡呼叫，並確認紀錄檔不存在。**
 *
 * @param path - 紀錄檔路徑。
 * @param records - 要寫的紀錄，序號必須是 1、2、3……。
 */
export async function createJournalFile(
  path: string,
  records: readonly JournalRecord[],
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const staging = `${path}.${String(process.pid)}.tmp`;
  const text = records
    .map((record) => `${JSON.stringify(journalRecordSchema.parse(record))}\n`)
    .join('');
  const handle = await open(staging, 'w', 0o600);
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(staging, { force: true });
    throw error;
  }
  await handle.close();
  await rename(staging, path);
  await syncDirectory(directory);
}

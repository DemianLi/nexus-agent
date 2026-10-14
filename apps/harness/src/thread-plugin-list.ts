/**
 * serve 每條 thread 組裝時重讀一次清單（[#1405](https://github.com/DemianLi/nexus-agent/issues/1405)）。
 *
 * ## 換得到的與換不到的
 *
 * 重讀用的是同一個 `loadDefaultPlugins`、同一份 env、home 層與 `--patch`，所以改了 home 層的 `cordis.yml`，下一條新 thread
 * 看得到：列的掛與不掛、組裝期讀的設定（`.docs/plugin-reload-classification-2026-10-08.md` 的 B、C 表）。**換不到程式碼版本**：
 * `import()` 有 ESM 快取，同一個 specifier 第二次拿到的是同一個模組物件；換版本是版本路由的事（決議 §3-2 第 6 條）。
 *
 * 起動期讀一次的列（{@link ThreadPluginListOptions.startupRead}）照舊到重啟才生效：重讀時它的值跟執行中的不同，就在伺服器
 * 日誌記一句「已儲存，待重啟」，同一個值只講一次，不讓它靜靜不生效。
 *
 * ## 掉了的列（demian 2026-10-11 拍板，#1405 Q1、Q2）
 *
 * - **必掛的列掉了，只讓這一條 thread 建不起來**：拋跟啟動那一次同一種 `StartupError`，伺服器照常，下一條再讀一次。
 *   不沿用上一份讀得起來的清單：那會讓「改壞了」靜靜不生效。
 * - **可少掛的列，同一列的設定沒變就一直算沒掛**：啟動試組掉了的列、讀清單時掉了的列，都以「列 id 加那一列疊完的宣告」
 *   記成已知，不每條 thread 重試、各印一次——同啟動那一段的性質。那一列的宣告一改，下一條 thread 就重新試它；重試又
 *   掉了，新的宣告也記成已知（{@link ThreadPluginReader.noteDropped}），讀清單時新掉的列在伺服器日誌記一次。
 *   啟動試組沒掉、某一條 thread 組裝時才掉的列不在這條規則裡，照舊只在那一條不掛。
 * - **試組掉在 `requires` 的列，紀錄有新的被接受改動時重試一次**（#1426，demian 2026-10-14 拍板 Q1 (a)）：#1405 問的是
 *   「設定修好的列要不要回來」，沒考慮「掉的原因在別的列」——A 自己什麼都沒錯、錯在它依賴的 B 不在，B 之後被打開，A 的
 *   宣告沒變，照上一條永遠不回來，要重啟 serve。所以這一階段記住的鍵多帶「當時紀錄裡最新一筆被接受的 `seq`」
 *   （{@link LoadedPluginConfig.acceptedSeq}）：serve 跑著時 `--patch`、出貨設定、環境變數都不變，依賴的列在不在只會因為紀錄
 *   改了而變。對得上就照上一條不重試；對不上，下一條 thread 重新組裝它一次，又掉了就用新的 `seq` 記住（只重試一次）。
 *   **只動 `requires` 這一階段**：`module`、`config`、`apply` 照上一條不變。相容層的 `requires` 檢查排在 `apply` 之後
 *   （`packages/nexus-core/src/load.ts`），重試一次就是真的跑一次 `apply` 再撤掉，所以不能每條 thread 都試。
 *   「被接受」用 `isAcceptedRecord`：`failed`、`rejected` 是只記不折的筆，要是算進去，重試又掉時記下的那一筆 `failed`
 *   就會讓下一條 thread 再試一次，永遠停不下來。不處理的邊角：B 因為工作區而 `apply` 失敗、連帶 A 掉在 `requires`，
 *   B 自己也照上一條不重試，所以 A 等到紀錄有改動才回來，跟 B 的待遇一致。
 *
 * 讀清單交出的警告（例如 patch 指到不存在的 id）也只記一次，進伺服器日誌。
 *
 * ## 已儲存 vs 執行中的對照（[#1406](https://github.com/DemianLi/nexus-agent/issues/1406)）
 *
 * 每次讀完清單、與啟動那一刻，這裡算一份「磁碟上現在的」對「啟動時讀進去的」逐列對照，交給 `publishSnapshot`（serve 寫成
 * home 底下的 JSON 檔，見 `plugin-snapshot.ts`）。**「已儲存，待重啟」的判定只有一處**：`plugin-row-state.ts` 的
 * `snapshotsDiffer`，日誌那一句（`reportStartupDrift`）與快照的 `sync` 同一支。`rowKey`、`snapshotOf` 也從那裡來。
 *
 * ## 偏離登記
 *
 * dsh 開 HMR 時設定一改立即影響使用那個 profile 的全部會話，沒開就保留到重啟（dsh
 * `packages/boot/plugin-manager/README.zh.md`〈概述〉）。我們是組 thread 時拉、只給新 thread：產品需求超出 dsh 的射程，
 * 歸在決議 `.docs/decisions-2026-10-11.md` §3-2 第 6 條（插件更新只給新對話）。清單由變更紀錄導出（#1412，決議 §3-5），
 * 重讀時一起讀；列不在 Loader 的樹上，因為插件還在相容層，上樹跟著逐顆搬出相容層一起做（`cordis-root.ts` 偏離登記）。
 *
 * ## 變更紀錄那一層的兩件事要讓人看得到（#1412）
 *
 * - **舊的 `cordis.patch.yml` 又出現**：紀錄檔在了，這個檔不讀、不自動再遷，警告一次（日誌＋快照 `layers.journal`）。
 * - **`--patch` 蓋到哪幾列**：它是部署端在命令列給的、不經過紀錄的路，稽核看不到，所以啟動與重讀時把它蓋到的列
 *   記進日誌（內容變了才再記）與快照（`layers.overlays`、每列 `unaudited`）。
 *
 * ## 掛不上的列也進變更紀錄（[#1414](https://github.com/DemianLi/nexus-agent/issues/1414)）
 *
 * 每次重讀把整份掉了的列交給記錄器（{@link ThreadPluginListOptions.recorder}），**不看上面那幾個「已知掉了」的集合**：
 * 它們的鍵是「列 id 加宣告」，紀錄的去重鍵是「列 id 加歸因到的 `seq`」；宣告改回舊值時這裡不重試、也就不會再掉，那一次的
 * `failed` 只有每次都交進去、由紀錄決定才記得到。必掛的列掉了要拋之前，先等它寫完（上限 2 秒）。規則在
 * `plugin-failure-recorder.ts`。
 *
 * @module
 */

import type { NexusPlugin, PluginEntry } from '@nexus/core';

import { failedRowsOf } from './plugin-failure-recorder.js';
import type { FailedRow, FailureRecorder } from './plugin-failure-recorder.js';
import { legacyPatchIgnoredMessage } from './plugin-config.js';
import type { LoadedPluginConfig, PluginConfigWarn, StartupDrop } from './plugin-config.js';
import { buildPluginSnapshot } from './plugin-snapshot.js';
import type { PluginSnapshot, SnapshotSource } from './plugin-snapshot.js';
import { rowKey, snapshotOf, snapshotsDiffer } from './plugin-row-state.js';
import {
  auditStartupEntries,
  describeDrop,
  optionalEntriesOf,
  StartupError,
  type StartupAuditOptions,
} from './startup-audit.js';

/** 一條 thread 組裝用的那份清單。 */
export interface ThreadPluginList {
  /**
   * 這一次讀出來的結果，`plugins` 與 `rows` 已換成標過已知掉了的列的那一份：查 id 與模組名（`assemblyDropsOf`、
   * `describeWarnings`）、會話 header 的清單與雜湊（`entries`）都從這裡拿。
   */
  readonly loaded: LoadedPluginConfig;
  /** 交給組裝的清單：已知掉了、宣告沒變的列標成 `disabled: true`。 */
  readonly plugins: readonly PluginEntry[];
  /** 這一份裡可以少掛的條目（`optionalEntriesOf`）。 */
  readonly optionalEntries: ReadonlySet<PluginEntry>;
}

/** {@link createThreadPluginList} 的輸入。 */
export interface ThreadPluginListOptions {
  /** 讀一次清單，同啟動那一次的 `loadDefaultPlugins` 與參數，警告交給 `warn`。 */
  readonly load: (warn: PluginConfigWarn) => Promise<LoadedPluginConfig>;
  /** 啟動那一次讀出來的結果。 */
  readonly startup: LoadedPluginConfig;
  /** 啟動試組掉了的條目（取自 `startup.plugins`；組裝點自己加的外掛不在清單上，略過）。 */
  readonly trialDropped: Iterable<PluginEntry>;
  /** 必掛名單怎麼算，同啟動那一次。 */
  readonly audit: StartupAuditOptions;
  /** 起動期讀一次的設定列：值以啟動那一份為準，重讀時不同就記「已儲存，待重啟」。 */
  readonly startupRead: readonly NexusPlugin<unknown>[];
  /** 伺服器日誌。 */
  readonly log: (line: string) => void;
  /**
   * 啟動試組掉了的列（`assemblyDropsOf(startup, trial.dropped)`），帶著掉在哪一步。省略時對照快照把它們記成 `apply`。
   */
  readonly trialDrops?: readonly (Pick<StartupDrop, 'id' | 'stage'> & {
    readonly message?: string;
  })[];
  /**
   * 把掉了的列記進變更紀錄（#1414）。**每次重讀都把整份掉了的列交進去**，包括被「已知掉了」壓成停用、這一條沒有重試的列：
   * 「已知」的鍵是列 id 加宣告，紀錄的去重鍵是列 id 加歸因到的 `seq`，兩個不是同一把尺；改了又改回舊值的宣告不會重試、
   * 也不會再掉，那一次的 `failed` 只有靠每次都交進去才記得到。要不要記由紀錄決定（`plugin-failure-recorder.ts`）。
   */
  readonly recorder?: Pick<FailureRecorder, 'note' | 'flush'>;
  /**
   * 每次讀完清單、啟動那一刻（{@link ThreadPluginReader.snapshot}）算出來的「已儲存 vs 執行中」對照（#1406）。
   * **不拋**：寫不出來不能讓一條 thread 建不起來，由實作自己吞掉並記日誌。省略就不算。
   */
  readonly publishSnapshot?: (snapshot: PluginSnapshot) => Promise<void> | void;
  /** 算快照用的時間，測試給固定的。省略即現在。 */
  readonly now?: () => Date;
}

/** 組裝時掉了的一個條目；`drop` 的形狀是 `AssemblyDrop`（`agent-factory.ts`）的子集，省略時對照快照記成 `apply`。 */
export interface AssemblyDropInput {
  readonly entry: PluginEntry;
  readonly drop?: {
    readonly stage: StartupDrop['stage'];
    readonly message?: string;
    readonly origin?: { readonly id: string };
  };
}

/** 讀清單的那一支。 */
export interface ThreadPluginReader {
  /**
   * 讀一次，給一條要組裝的 thread。
   *
   * @returns 那條 thread 用的清單。
   * @throws {PluginConfigError} 任何一層讀不了、形狀不合；必掛的列掉了是其中的 `StartupError`，訊息同啟動那一次。
   */
  read(): Promise<ThreadPluginList>;
  /**
   * 組裝之後交回這一條掉了的條目。啟動試組掉過的列，宣告改了重試又掉，新的宣告記成已知，之後的 thread 不再試。
   *
   * **同時記下每一列這一次組裝的結果**（掛上或掉了，#1423）：清單上沒停用、也不在 `dropped` 裡的列就是掛上了。
   * 「新掉」（上一次組裝或重讀還掛著、這一次掉了）要在更新之前算，所以由這裡一併回傳。
   *
   * @param list - 這一條用的那份（{@link read} 的回傳）。
   * @param dropped - 組裝時掉了的條目。
   * @returns 這一次**新掉**的列 id，交給變更紀錄的記錄器當 `newlyDropped`。
   */
  noteDropped(list: ThreadPluginList, dropped: readonly AssemblyDropInput[]): ReadonlySet<string>;
  /**
   * 組裝**失敗**（不能少掛的列掉了、拋之前）：算新掉的並記下它們掉了（#1423）。
   *
   * 跟 {@link noteDropped} 分開：組裝沒走完，其餘的列掛沒掛上不知道，所以只改掉了的那幾列；也不動「已知組裝掉了」
   * 的重試記憶（重試的行為不改）。
   *
   * @param dropped - `AssemblyDropError.dropped`。
   * @returns 這一次新掉的列 id。
   */
  noteAssemblyFailure(dropped: readonly AssemblyDropInput[]): ReadonlySet<string>;
  /**
   * 「已儲存 vs 執行中」的對照（#1406）。啟動時呼叫不帶引數：已儲存的就是啟動那一份，每一列都是 `same`。
   *
   * @param saved - 這一刻磁碟上的那一份；省略即啟動那一份。
   * @returns 快照。
   */
  snapshot(saved?: ThreadPluginList): PluginSnapshot;
}

/**
 * 建一支每條 thread 重讀清單的讀取器。
 *
 * @param options - 啟動那一份、試組掉了的列、起動期讀的列、伺服器日誌。
 * @returns 讀取器。
 */
export function createThreadPluginList(options: ThreadPluginListOptions): ThreadPluginReader {
  const { startup, audit, log } = options;
  // 已知掉了的列，鍵是列 id 加那一列疊完的宣告，宣告一改鍵就不同。讀清單時掉的（`known`）由 `loadDefaultPlugins` 自己
  // 標成停用，這裡只管講不講；試組在組裝時才掉的（`knownAssembly`）要這裡標成停用，以後的 thread 才不重試。
  const known = new Set<string>();
  for (const drop of startup.dropped) known.add(rowKey(startup, drop.id));
  const knownAssembly = new Set<string>();
  // **掉在 `requires` 的那幾格當時紀錄裡最新一筆被接受的 `seq`**（#1426）：鍵同 `knownAssembly`（列 id 加宣告），沒有那一格
  // 的就是掉在別的階段（`module`、`config`、`apply`），宣告不變就一直算沒掛。有那一格的，讀清單時紀錄裡最新被接受的
  // `seq` 跟它不同，就不標成停用、讓下一條 thread 組裝它一次。
  const requiresSeq = new Map<string, number | null>();
  // 啟動試組掉過的列 id：只有它們重試又掉時記新的宣告。
  const assemblyIds = new Set<string>();
  const trialDropById = new Map((options.trialDrops ?? []).map((drop) => [drop.id, drop]));
  for (const entry of options.trialDropped) {
    const id = startup.rows.get(entry)?.id;
    if (id === undefined) continue;
    assemblyIds.add(id);
    const key = rowKey(startup, id);
    knownAssembly.add(key);
    if (trialDropById.get(id)?.stage === 'requires') requiresSeq.set(key, startup.acceptedSeq);
  }
  /** 這一格在這一份清單上還算不算「已知組裝掉了」：掉在 `requires` 的，紀錄有新的被接受改動就不算（#1426）。 */
  function stillKnownAssembly(
    loaded: Pick<LoadedPluginConfig, 'acceptedSeq'>,
    key: string,
  ): boolean {
    if (!knownAssembly.has(key)) return false;
    return !requiresSeq.has(key) || requiresSeq.get(key) === loaded.acceptedSeq;
  }
  // **每一列上一次組裝或重讀的結果**（#1423）：鍵是列 id，值是掛上（`mounted`）或掉了（`dropped`）。起點是啟動那一份。
  // 「新掉」就是這裡是 `mounted`、這一次掉了。**跟 `known` 不是同一件事**：`known` 只管日誌講不講（鍵含宣告，只增不刪），
  // 這裡要能在掛回來之後再掉一次還算新掉。重讀只會把掉了的列記成 `dropped`，不會把列記成 `mounted`：純相容層的列
  // 掛不掛得上要等組裝才知道，重讀把它當掛上的話，組裝又掉就每條 thread 都算新掉、歸因到無關的最新一筆。
  const lastResult = new Map<string, 'mounted' | 'dropped'>();
  const trialDroppedIds = new Set<string>();
  for (const entry of options.trialDropped) {
    const id = startup.rows.get(entry)?.id;
    if (id !== undefined) trialDroppedIds.add(id);
  }
  const startupDroppedIds = new Set(startup.dropped.map((drop) => drop.id));
  for (const entry of startup.plugins) {
    const id = startup.rows.get(entry)?.id;
    if (id === undefined) continue;
    if (startupDroppedIds.has(id) || trialDroppedIds.has(id)) lastResult.set(id, 'dropped');
    else if (entry.disabled !== true) lastResult.set(id, 'mounted');
  }
  for (const id of startupDroppedIds) lastResult.set(id, 'dropped');
  for (const id of trialDroppedIds) lastResult.set(id, 'dropped');
  /** 這幾列這一次掉了：回新掉的（上一次還是 `mounted`），並記成掉了。 */
  function noteDroppedIds(ids: Iterable<string>): Set<string> {
    const fresh = new Set<string>();
    for (const id of ids) {
      if (lastResult.get(id) === 'mounted') fresh.add(id);
      lastResult.set(id, 'dropped');
    }
    return fresh;
  }
  // 試組掉了的列掉在哪一步：只給對照快照用（`dropStage`）。鍵同 `knownAssembly`，宣告一改就是另一格。
  const assemblyStage = new Map<string, StartupDrop['stage']>();
  // 同一格的原因原文，只給變更紀錄的 `failed` 用（#1414）。
  const assemblyMessage = new Map<string, string>();
  for (const id of assemblyIds) {
    const trial = trialDropById.get(id);
    assemblyStage.set(rowKey(startup, id), trial?.stage ?? 'apply');
    if (trial?.message !== undefined) assemblyMessage.set(rowKey(startup, id), trial.message);
  }
  const now = options.now ?? (() => new Date());
  // 讀清單的警告，同一句只記一次。
  const warned = new Set<string>();
  const warn: PluginConfigWarn = (message) => {
    if (warned.has(message)) return;
    warned.add(message);
    log(`[清單] ${message}`);
  };
  // 變更紀錄那一層的兩件事要讓人在伺服器日誌看得到（#1412）：舊的 patch 檔出現了、沒讀；`--patch` 蓋到哪幾列（不經過紀錄，
  // 稽核看不到）。啟動那一刻講一次，之後每次重讀只在內容變了才再講。
  const reportedLayers = new Set<string>();
  function reportLayers(layers: LoadedPluginConfig['layers']): void {
    const journal = layers.journal;
    if (journal?.ignoredLegacyPatch !== undefined) {
      warn(legacyPatchIgnoredMessage(journal.ignoredLegacyPatch, journal.path));
    }
    for (const overlay of layers.overlays) {
      if (overlay.rows.length === 0) continue;
      const line =
        `有未稽核的覆蓋層在作用：--patch ${overlay.file} 指到 ${overlay.rows.join('、')}` +
        '（這一層不經過變更紀錄，稽核看不到；開關回 overridden、設定被它蓋掉的改設定會被拒）';
      if (reportedLayers.has(line)) continue;
      reportedLayers.add(line);
      log(`[清單] ${line}`);
    }
  }
  reportLayers(startup.layers);
  const running = options.startupRead.map((plugin) => ({
    plugin,
    snapshot: snapshotOf(startup.plugins, plugin),
  }));
  // 已經講過「待重啟」的那個值，同一個值不再講；改回執行中的值就清掉。
  const reported = new Map<string, unknown>();
  // 啟動時那一份的「執行中」：讀清單那一步掉的，加試組那一步掉的。
  const runningSource: SnapshotSource = {
    entries: startup.entries,
    ids: startup.ids,
    plugins: startup.plugins,
    rows: startup.rows,
    drops: [
      ...startup.dropped.map(({ id, stage }) => ({ id, stage })),
      ...[...assemblyIds].map((id) => ({
        id,
        stage: assemblyStage.get(rowKey(startup, id)) ?? 'apply',
      })),
    ],
    layers: startup.layers,
  };
  /** 一份讀出來的清單換成快照的來源：讀清單那一步掉的，加已知組裝掉了的（`plugins` 裡被標成停用、宣告沒寫停用的）。 */
  function savedSourceOf(list: ThreadPluginList): SnapshotSource {
    const { loaded, plugins } = list;
    const droppedIds = new Set(loaded.dropped.map((drop) => drop.id));
    const drops = loaded.dropped.map(({ id, stage }) => ({ id, stage }));
    for (const entry of plugins) {
      const row = loaded.rows.get(entry);
      if (row === undefined || entry.disabled !== true || droppedIds.has(row.id)) continue;
      const declared = loaded.entries.find((candidate) => candidate.id === row.id);
      if (declared?.disabled === true) continue;
      const stage = assemblyStage.get(rowKey(loaded, row.id));
      if (stage !== undefined) drops.push({ id: row.id, stage });
    }
    return {
      entries: loaded.entries,
      ids: loaded.ids,
      plugins,
      rows: loaded.rows,
      drops,
      layers: loaded.layers,
    };
  }
  function snapshotFor(saved?: ThreadPluginList): PluginSnapshot {
    return buildPluginSnapshot({
      running: runningSource,
      saved: saved === undefined ? runningSource : savedSourceOf(saved),
      generatedAt: now(),
    });
  }

  return {
    async read() {
      const loaded = await options.load(warn);
      try {
        auditStartupEntries(loaded, audit);
      } catch (error) {
        // 必掛的列掉了，這一條 thread 建不起來：先把那一筆記進紀錄，再拋（#1414；等鎖上限 2 秒）。
        if (error instanceof StartupError) {
          const fresh = noteDroppedIds(error.dropped.map((drop) => drop.id));
          options.recorder?.note(failedRowsOf(error.dropped, fresh), 'reread');
          await options.recorder?.flush();
        }
        throw error;
      }
      const toRecord: FailedRow[] = [];
      // **新掉照字面算**（#1423）：上一次組裝或重讀還掛著、這一次掉了；跟下面「日誌講不講」的 `known` 不是同一把尺。
      const newlyDropped = noteDroppedIds(loaded.dropped.map((drop) => drop.id));
      for (const drop of loaded.dropped) {
        const key = rowKey(loaded, drop.id);
        const fresh = !known.has(key);
        toRecord.push({
          id: drop.id,
          module: drop.module,
          stage: drop.stage,
          message: drop.message,
          newlyDropped: newlyDropped.has(drop.id),
        });
        if (!fresh) continue;
        known.add(key);
        log(`[清單] 這一列沒掛上，之後的 thread 也不掛，直到它的設定改了：${describeDrop(drop)}`);
      }
      const rows = new Map(loaded.rows);
      const plugins = loaded.plugins.map((entry) => {
        const row = loaded.rows.get(entry);
        if (row === undefined || entry.disabled === true) return entry;
        const key = rowKey(loaded, row.id);
        if (!stillKnownAssembly(loaded, key)) return entry;
        const off: PluginEntry = { ...entry, disabled: true };
        rows.set(off, row);
        // 已知組裝掉了、這一條沒有重試的列：照樣交給紀錄，原因取它掉的那一次。
        toRecord.push({
          id: row.id,
          module: row.module,
          stage: assemblyStage.get(key) ?? 'apply',
          message: assemblyMessage.get(key) ?? '',
          newlyDropped: false,
        });
        return off;
      });
      options.recorder?.note(toRecord, 'reread');
      reportStartupDrift(plugins);
      reportLayers(loaded.layers);
      const view: LoadedPluginConfig = { ...loaded, plugins, rows };
      const list: ThreadPluginList = {
        loaded: view,
        plugins,
        optionalEntries: optionalEntriesOf(view, audit),
      };
      await options.publishSnapshot?.(snapshotFor(list));
      return list;
    },
    noteDropped(list, dropped) {
      const droppedIds = new Set<string>();
      for (const { entry, drop } of dropped) {
        const id = drop?.origin?.id ?? list.loaded.rows.get(entry)?.id;
        if (id !== undefined) droppedIds.add(id);
        const rowId = list.loaded.rows.get(entry)?.id;
        if (rowId === undefined || !assemblyIds.has(rowId)) continue;
        const key = rowKey(list.loaded, rowId);
        knownAssembly.add(key);
        const stage = drop?.stage ?? assemblyStage.get(key) ?? 'apply';
        assemblyStage.set(key, stage);
        // 掉在 `requires`：用**這一條 thread 讀到的**那個 `seq` 記住（#1426），紀錄再有新的被接受改動才又試一次；
        // 這一次掉在別的階段，就照 #1405 Q2 只看宣告。
        if (stage === 'requires') requiresSeq.set(key, list.loaded.acceptedSeq);
        else requiresSeq.delete(key);
        if (drop?.message !== undefined) assemblyMessage.set(key, drop.message);
      }
      const fresh = noteDroppedIds(droppedIds);
      // 清單上沒停用、這一次也沒掉的列就是掛上了。
      for (const entry of list.plugins) {
        const id = list.loaded.rows.get(entry)?.id;
        if (id === undefined || entry.disabled === true || droppedIds.has(id)) continue;
        lastResult.set(id, 'mounted');
      }
      return fresh;
    },
    noteAssemblyFailure(dropped) {
      const ids: string[] = [];
      for (const { drop } of dropped) {
        if (drop?.origin?.id !== undefined) ids.push(drop.origin.id);
      }
      return noteDroppedIds(ids);
    },
    snapshot: snapshotFor,
  };

  function reportStartupDrift(plugins: readonly PluginEntry[]): void {
    for (const { plugin, snapshot } of running) {
      const next = snapshotOf(plugins, plugin);
      if (!snapshotsDiffer(snapshot, next)) {
        reported.delete(plugin.name);
        continue;
      }
      if (reported.has(plugin.name) && !snapshotsDiffer(reported.get(plugin.name), next)) continue;
      reported.set(plugin.name, next);
      log(
        `[清單] 「${plugin.name}」改了，已儲存，待重啟：這一列在啟動時讀一次，新對話照舊用啟動時的值`,
      );
    }
  }
}

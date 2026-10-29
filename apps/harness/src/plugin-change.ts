/**
 * 後台插拔的寫入口：停用、啟用、整份替換一列的設定、恢復成繼承值，每一次追加一筆進變更紀錄
 * （[#1412](https://github.com/DemianLi/nexus-agent/issues/1412)，Part of #1385）。
 *
 * 入口是主機端的 `plugin-cli.ts`。沒有管理員身分，所以不開 wire 路由（見 `plugin-snapshot.ts` 偏離登記第 1 條同一個理由）；
 * 進得了主機的人本來就能手改 `cordis.patch.yml`，這裡沒有放寬任何權限，只是把改動記下來。
 *
 * ## 語意照 dsh
 *
 * | 操作 | dsh | 被更高層（`--patch`）蓋掉時 |
 * |---|---|---|
 * | 停用／啟用 | `writePluginEnabled`（`packages/boot/plugin-manager/src/patch.ts:14-43`） | **照寫、回報 `overridden`**（`plugin-manager/src/index.ts:460-466`） |
 * | 改設定／恢復 | `configEditor.edit`（`packages/boot/config-editor/src/index.ts:136-150`） | **寫入前就拒絕**（`:140-143`）；寫入後協調失敗寫回舊文件（`:145-150`，我們沒有協調這一步，見下） |
 *
 * 新值**等於繼承值**時照 dsh 拿掉那一列的覆蓋（`:119-125`），不抄一份：紀錄裡記成恢復、帶 `requested: 'config-set'`
 * （PM 2026-10-13）。
 *
 * ## 寫入前先驗
 *
 * 只增不改沒有回滾，所以驗證在追加之前、**在同一把鎖裡**（兩個寫入口同時進來，後拿到鎖的驗證時已經看得到前一筆）：
 * 折完、疊完（含 `--patch`）、`validateEntries`（關不掉的名單）、那一列的設定格式、模組載得進來。驗不過就**在同一把鎖裡
 * 追加一筆 `rejected`**（操作者、要做的操作、列 id、原因原文，**不帶要寫入的值**，#1414），再拋 {@link PluginChangeRejected}；
 * 它不折，清單不變。「沒有改變任何東西，沒有寫」（已經是那個狀態）不是拒絕，照舊什麼都不寫。
 *
 * `apply` 裡才會發生的事（值檢查、`requires` 缺件、撞名）靠試掛（`plugin-trial.ts`，#2073）：照 serve 啟動試組那一次組一份寫下去之後的
 * 清單，有新冒出的失敗就拒收。「新」的判法：必掛的列一律算新；樹上的列缺服務是等提供者，不算；同一列、同一步、同一句原因、
 * 宣告也沒變的失敗不算。寫下去之後的那一份有列掉了，才再試掛一次現在的清單當基準。試掛的環境只有呼叫端給的 `--patch` 與
 * `--workspace`，只在 serve 環境裡掉的列照舊到 thread 組裝時才掉（`thread-plugin-list.ts`）。
 *
 * **試掛在鎖外跑**：MCP 握手卡住時一次要等到 SDK 逾時（約 120 秒），比紀錄鎖的等待上限長。所以先在鎖裡算出要寫的那一筆、
 * 記下最後一筆的序號，放開鎖去試掛，再進鎖核對序號：沒變才照試掛的結果收或拒（紀錄只增不改，序號沒變就是試掛看到的那一份）；
 * 變了就放開鎖、照新的紀錄重試，累計重試 {@link TRIAL_RETRY_LIMIT} 次還是變了就拒收，請人重下。
 *
 * ## 偏離登記
 *
 * 1. **記「誰」**：dsh 沒有使用者身分（`ChangeResult` 與 `plugin-manager/changed` 只帶 `reason`，`plugin-manager/src/types.ts:244-246`）。
 *    這裡記主機帳號；sudo 前原本登入的帳號是從環境變數自報的，標在 `invokerSource`，不是身分認證（加 4）。
 * 2. **變更歷史**：dsh 完全沒有；這是產品需求（決議 §3-5 第 18 條）。
 * 3. **寫入回報帶 actor、序號、前後值**：dsh 的 `ChangeResult` 只有 `reason`。CLI 與日誌**不印設定值**，只印哪幾個欄位變了（加 7）。
 * 4. **沒有「寫入後協調失敗就寫回舊文件」**：dsh 的 `edit` 寫完立刻在同一個行程裡 reconcile 活的 Loader 樹，失敗寫回。
 *    我們的寫入口是另一個行程，樹在 serve 裡，下一條 thread 才重讀；紀錄追加之後沒有可以協調的對象，所以把驗證全部
 *    搬到追加之前，`apply` 那一段在這個行程裡另建一棵樹試掛。
 * 5. **紀錄裡留著舊的 `disable`、而那一列後來改成關不掉時，救得回來**（[#1619](https://github.com/DemianLi/nexus-agent/issues/1619)）：
 *    找列與找繼承值不檢查保護名單，只有寫入之後的整份清單才檢查，所以 `enable` 寫得進去、新的 `disable` 照樣被拒；
 *    清單還壞著時別的改動也被拒，訊息帶 `plugin enable <id>` 那一句修法（`plugin-config.ts` 的 `assertNotProtected`）。
 *    dsh 沒有變更紀錄，這一條跟第 2 條同屬寫入口本身那條理由 2（稽核）。
 *
 * @module
 */

import { userInfo } from 'node:os';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { resolveEntriesPerEntry } from '@nexus/core';

import { resolveHarnessHome } from './harness-home.js';
import {
  assertPrivateFile,
  composeEntries,
  defaultSources,
  JOURNAL_FILE_ROLE,
  loadPluginConfig,
  PluginConfigError,
  prepareJournal,
  resolveEntryModule,
} from './plugin-config.js';
import type { ConfigEntry } from './plugin-config.js';
import {
  appendJournalRecord,
  journalOverrideOf,
  PLUGIN_JOURNAL_FILE_NAME,
} from './plugin-journal.js';
import type { JournalActor, JournalBody, JournalRecord } from './plugin-journal.js';
import { pluginSnapshotPath } from './plugin-snapshot.js';
import { classOfRow } from './plugin-row-classes.js';
import { trialMount } from './plugin-trial.js';
import type { TrialFailure } from './plugin-trial.js';

/** 一次變更。 */
export type PluginChange =
  | { readonly op: 'disable' | 'enable'; readonly id: string }
  | { readonly op: 'config-set'; readonly id: string; readonly config: Record<string, unknown> }
  | { readonly op: 'config-reset'; readonly id: string };

/**
 * 這一筆驗不過、沒有生效。訊息指名原因。
 *
 * 驗證那一段的拒絕會在同一把鎖裡追加一筆 `rejected`（#1414），{@link seq} 是那一筆的序號；
 * 還沒進到驗證的錯（參數解析、`--file` 讀不到、紀錄壞了）不是這個類別，也不記。
 */
export class PluginChangeRejected extends Error {
  /** 記進紀錄的那一筆 `rejected` 的序號；沒有記就 `undefined`。 */
  seq?: number;

  constructor(message: string) {
    super(message);
    this.name = 'PluginChangeRejected';
  }
}

/** 什麼時候生效。 */
export type ChangeEffect =
  /** 新對話生效。 */
  | 'next-thread'
  /** 已儲存，待重啟（起動期讀一次的列，或掛不掛要重啟的列）。 */
  | 'restart'
  /** 被更高層（`--patch`）蓋掉，這一筆寫了但清單上看不到效果。 */
  | 'overridden';

/** {@link changePlugin} 的選項。 */
export interface PluginChangeOptions {
  /** 決定 harness home 落在哪，省略即 `process.env`。 */
  readonly env?: NodeJS.ProcessEnv;
  /** serve 帶的 `--patch`，照命令列順序。不給就看不到那一層（偵測不到 `overridden`）。 */
  readonly patches?: readonly string[];
  /** 算 `at`，測試給固定的。 */
  readonly now?: () => Date;
  /** 誰寫的；省略即 {@link hostActor}。 */
  readonly actor?: JournalActor;
  /** 其他警告往哪裡講，省略即收進結果。 */
  readonly warn?: (message: string) => void;
  /** serve 帶的 `--workspace`：試掛時照它組。不給就照沒有 `--workspace` 的 serve 組。 */
  readonly workspace?: string;
  /** `--workspace` 的解析基準，省略即行程的工作目錄。 */
  readonly cwd?: string;
  /** 試掛那一步，省略即 {@link trialMount}。 */
  readonly trial?: typeof trialMount;
}

/** {@link changePlugin} 的結果。**record 裡有明文設定值，呼叫端不要印它。** */
export interface PluginChangeResult {
  readonly outcome: 'recorded' | 'unchanged';
  /** 紀錄檔的完整路徑。 */
  readonly path: string;
  /** 寫進去的那一筆；`unchanged` 時沒有。 */
  readonly record?: JournalRecord;
  /** 什麼時候生效；`unchanged` 時沒有。 */
  readonly effect?: ChangeEffect;
  /** 哪幾個欄位變了：開關是 `['disabled']`，設定是頂層鍵名，**不帶值**。 */
  readonly fields: readonly string[];
  /** `unchanged` 的原因，或 `recorded` 的補充（例如「新值等於繼承值，已記成恢復成繼承值」）。 */
  readonly notes: readonly string[];
  /** 要給操作的人看的警告。 */
  readonly warnings: readonly string[];
  /** 這個 home 底下有沒有 `plugin-snapshot.json`：沒有，這份紀錄可能不是 serve 在讀的那份。 */
  readonly snapshotPresent: boolean;
}

/**
 * 這個行程的主機帳號。`effective` 是作業系統給的有效帳號；`invoker` 是 sudo 之前的帳號，**從環境自報**。
 *
 * @param env - 讀 `SUDO_USER`、`LOGNAME`。
 * @param current - 有效帳號從哪來，測試換得掉。
 * @returns 要寫進紀錄的 actor。
 */
export function hostActor(
  env: NodeJS.ProcessEnv = process.env,
  current: () => string = () => userInfo().username,
): Extract<JournalActor, { kind: 'host-account' }> {
  const sudo = env['SUDO_USER'];
  const login = env['LOGNAME'];
  const fromSudo = sudo !== undefined && sudo.trim() !== '';
  const fromLogin = login !== undefined && login.trim() !== '';
  return {
    kind: 'host-account',
    effective: current(),
    invoker: fromSudo ? (sudo as string) : fromLogin ? (login as string) : null,
    invokerSource: fromSudo ? 'SUDO_USER' : fromLogin ? 'LOGNAME' : null,
  };
}

/** 關掉會讓有 `--workspace` 的 serve 之後每條新 thread 都建不起來的列（`assembly-root.ts:803-818`）。 */
const WORKSPACE_REQUIRED_ROWS: ReadonlySet<string> = new Set([
  'sandbox-policy',
  'permission-presets',
]);

/** 試掛期間紀錄被追加時，最多重試幾次。 */
const TRIAL_RETRY_LIMIT = 5;

/** 同一列、同一步、同一句原因，宣告也沒變：不算新冒出的。 */
function sameFailure(previous: TrialFailure, failure: TrialFailure): boolean {
  return (
    previous.id === failure.id &&
    previous.stage === failure.stage &&
    previous.message === failure.message &&
    isDeepStrictEqual(previous.declaration, failure.declaration)
  );
}

function changedKeys(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): string[] {
  const left = before ?? {};
  const right = after ?? {};
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].filter((key) => !isDeepStrictEqual(left[key], right[key])).sort();
}

/**
 * 寫一次變更。
 *
 * **先 {@link prepareJournal}**：紀錄檔還不在、舊的 `cordis.patch.yml` 在的時候，寫入口直接建出紀錄檔卻不遷移的話，
 * 舊檔就變成「遷移後又出現」被略過，使用者的改動靜靜失效。
 *
 * @param change - 要做什麼。
 * @param options - env、`--patch`、時間、誰。
 * @returns 結果；`recorded` 或 `unchanged`（沒有改變任何東西，沒寫）。
 * @throws {PluginChangeRejected} 驗不過：不存在的 id、關不掉的列、設定格式不合、被 `--patch` 蓋掉的設定、試掛時有新冒出的失敗。
 *   已記成 `rejected`。
 * @throws {PluginConfigError} 清單本身讀不了，或舊的 patch 檔壞了。
 * @throws {PluginJournalError} 紀錄壞了（不在壞掉的檔後面追加）、等不到鎖。
 */
export async function changePlugin(
  change: PluginChange,
  options: PluginChangeOptions = {},
): Promise<PluginChangeResult> {
  const env = options.env ?? process.env;
  const collected: string[] = [];
  const warn = options.warn ?? ((message: string) => void collected.push(message));
  const warnings: string[] = [];
  const notes: string[] = [];
  await prepareJournal({ env, warn });
  const path = join(resolveHarnessHome(env), PLUGIN_JOURNAL_FILE_NAME);
  const base = {
    serve: true,
    env,
    ...(options.patches !== undefined && { patches: options.patches }),
    warn,
  };

  const trial = options.trial ?? trialMount;
  const trialOptions = {
    env,
    cwd: options.cwd ?? process.cwd(),
    ...(options.workspace !== undefined && { workspace: options.workspace }),
  };
  const quiet = { ...base, warn: () => {} };
  const introducedFailures = async (body: JournalBody): Promise<{ rejection?: string }> => {
    const failing = (
      await trial(defaultSources({ ...quiet, pending: [body] }), trialOptions)
    ).filter((failure) => !failure.pending);
    if (failing.length === 0) return {};
    const before = await trial(defaultSources(quiet), trialOptions);
    const introduced = failing.filter(
      (failure) => failure.required || !before.some((previous) => sameFailure(previous, failure)),
    );
    if (introduced.length === 0) return {};
    return {
      rejection: [
        '這一筆寫下去之後，試掛時有新的列掛不上：',
        ...introduced.map(
          (failure) =>
            `  ${JSON.stringify(failure.id)}（${failure.stage}${failure.required ? '，必掛' : ''}）：${failure.message}`,
        ),
        'serve 帶了 --patch 或 --workspace 的話，這裡也要帶同一組，試掛的結果才對得上 serve。',
      ].join('\n'),
    };
  };

  let effect: ChangeEffect | undefined;
  let fields: string[] = [];
  let unchangedReason: string | undefined;
  // 驗不過的那一次：在鎖裡換成一筆 `rejected` 寫下去，寫完再拋這個錯（#1414）。
  let rejection: PluginChangeRejected | undefined;
  // 上一次放開鎖時要試掛的那一筆，與當時最後一筆的序號。
  let pending: { body: JournalBody; seq: number | undefined } | undefined;
  // 那一筆的試掛結果：有新冒出的失敗時是拒收訊息。
  let verdict: { body: JournalBody; seq: number | undefined; rejection?: string } | undefined;

  let record: JournalRecord | undefined;
  for (let pass = 0; ; pass += 1) {
    if (pending !== undefined) {
      verdict = { ...pending, ...(await introducedFailures(pending.body)) };
      pending = undefined;
    }
    notes.length = 0;
    warnings.length = 0;
    record = await appendJournalRecord(
      path,
      {
        actor: options.actor ?? hostActor(env),
        ...(options.now !== undefined && { now: options.now }),
        warn: (message) => warnings.push(message),
        check: (file) => assertPrivateFile(file, JOURNAL_FILE_ROLE),
      },
      async (records): Promise<JournalBody | undefined> => {
        // 驗不過不在這裡拋：換成一筆 `rejected` 交給 `appendJournalRecord` 寫進去，寫完才在下面拋（#1414）。
        // 原文進紀錄（0600，前後值本來就是明文）；要寫入的值一個位元組都不進來。
        const reject = (message: string): JournalBody => {
          rejection = new PluginChangeRejected(message);
          return { op: 'rejected', requested: change.op, id: change.id, reason: message };
        };

        // 1. 這一列。用不含 `--patch` 的清單找：寫入口看的是「紀錄加出貨」。
        // **找列這一步不檢查保護名單**（#1619）：紀錄裡留著一筆舊的 `disable`（那一列以前關得掉）時，這裡也拋的話連 `enable`
        // 都寫不進去，沒有任何指令救得回來。這一步只拿 target 與 name；寫入之後的整份清單照樣在第 3 步完整驗過。
        const own = defaultSources({ serve: true, env, warn });
        const current = composeEntries(own, { allowDisabledProtected: true });
        const target: ConfigEntry | undefined = current.find((entry) => entry.id === change.id);
        if (target === undefined) {
          return reject(
            `沒有 id 為 ${JSON.stringify(change.id)} 的列。` +
              '清單上有哪些 id，用 `--dump-config`（serve 的清單另含 cordis.serve.yml 那幾列）。',
          );
        }
        const name = target.name;
        const override = journalOverrideOf(records, change.id, name);

        // 2. 這一筆長什麼樣、有沒有改變任何東西。
        let body: JournalBody | undefined;
        let inheritedConfig: Record<string, unknown> | undefined;
        const inheritedWithout = (): Record<string, unknown> => {
          if (inheritedConfig !== undefined) return inheritedConfig;
          // 同第 1 步：只拿繼承值，保護名單交給第 3 步（不然紀錄裡留著舊 `disable` 時，這裡拋的錯不會記成 `rejected`）。
          const without = composeEntries(
            defaultSources({
              serve: true,
              env,
              warn,
              pending: [{ op: 'config-reset', id: change.id, name, before: null, after: null }],
            }),
            { allowDisabledProtected: true },
          ).find((entry) => entry.id === change.id);
          inheritedConfig = without?.config ?? {};
          return inheritedConfig;
        };

        switch (change.op) {
          case 'disable':
          case 'enable': {
            const want = change.op === 'disable';
            if (override?.disabled === want) {
              unchangedReason = `紀錄裡這一列已經是${want ? '停用' : '啟用'}，沒有寫。`;
              return undefined;
            }
            body =
              change.op === 'disable'
                ? {
                    op: 'disable',
                    id: change.id,
                    name,
                    before: target.disabled === true,
                    after: true,
                  }
                : {
                    op: 'enable',
                    id: change.id,
                    name,
                    before: target.disabled === true,
                    after: false,
                  };
            fields = ['disabled'];
            break;
          }
          case 'config-set': {
            const inherited = inheritedWithout();
            if (isDeepStrictEqual(change.config, inherited)) {
              // 照 dsh `config-editor/src/index.ts:119-125`：新值等於繼承值，就是拿掉那一列的覆蓋。
              if (override?.config === undefined) {
                unchangedReason = '新值等於繼承值，而紀錄裡這一列本來就沒有設定覆蓋，沒有寫。';
                return undefined;
              }
              body = {
                op: 'config-reset',
                id: change.id,
                name,
                before: override.config,
                after: inherited,
                requested: 'config-set',
              };
              fields = changedKeys(override.config, inherited);
              notes.push('新值等於繼承值，已記成「恢復成繼承值」。');
            } else {
              if (
                override?.config !== undefined &&
                isDeepStrictEqual(override.config, change.config)
              ) {
                unchangedReason = '新值與紀錄裡這一列的設定相同，沒有寫。';
                return undefined;
              }
              body = {
                op: 'config-set',
                id: change.id,
                name,
                before: target.config ?? null,
                after: change.config,
              };
              fields = changedKeys(target.config ?? null, change.config);
            }
            break;
          }
          case 'config-reset': {
            if (override?.config === undefined) {
              unchangedReason = '紀錄裡這一列沒有設定覆蓋，已經是繼承值，沒有寫。';
              return undefined;
            }
            const inherited = inheritedWithout();
            body = {
              op: 'config-reset',
              id: change.id,
              name,
              before: override.config,
              after: inherited,
            };
            fields = changedKeys(override.config, inherited);
            break;
          }
        }

        // 3. 寫入前驗證：整份疊完（含 `--patch`）、驗形狀與關不掉的名單、那一列載得進來。
        let loaded;
        try {
          loaded = await loadPluginConfig(defaultSources({ ...base, pending: [body] }));
        } catch (error) {
          if (error instanceof PluginConfigError) return reject(error.message);
          throw error;
        }
        const drop = loaded.dropped.find((candidate) => candidate.id === change.id);
        if (drop !== undefined) {
          return reject(
            `這一筆寫下去之後，${JSON.stringify(change.id)} 會在「${drop.stage}」這一步掉：${drop.message}`,
          );
        }
        const composed = loaded.entries.find((entry) => entry.id === change.id);
        if (composed === undefined) {
          return reject(`疊完之後找不到 ${JSON.stringify(change.id)}，這一筆不會有作用。`);
        }
        // 停用的列不經過 `loadPluginConfig` 的設定驗證：新設定要照樣驗，不然寫進去的是下次啟用才爆的東西。
        let pluginName: string | undefined;
        try {
          const entry = await resolveEntryModule({ ...composed, disabled: false });
          pluginName = entry.plugin.name;
          if (body.op === 'config-set') {
            const [resolution] = resolveEntriesPerEntry([entry]);
            if (resolution?.configError !== undefined) {
              return reject(
                `新設定驗不過 ${JSON.stringify(change.id)} 的格式：${resolution.configError.message}`,
              );
            }
          }
        } catch (error) {
          if (error instanceof PluginConfigError) {
            if (body.op === 'config-set' || body.op === 'enable') return reject(error.message);
          } else {
            throw error;
          }
        }

        // 4. 被更高層蓋掉。
        const coveredBy = loaded.layers.overlays
          .filter((overlay) => overlay.rows.includes(change.id))
          .map((overlay) => overlay.file);
        let overridden = false;
        if (body.op === 'disable' || body.op === 'enable') {
          overridden = (composed.disabled === true) !== (body.op === 'disable');
        } else {
          const expected = body.op === 'config-set' ? body.after : inheritedWithout();
          if (!isDeepStrictEqual(composed.config ?? {}, expected)) {
            return reject(
              `${JSON.stringify(change.id)} 的設定被 --patch 蓋掉了` +
                `${coveredBy.length > 0 ? `（${coveredBy.join('、')}）` : ''}，` +
                '寫進紀錄也不會生效，所以沒寫（照 dsh：config-editor/src/index.ts:140-143）。要改就改那個 --patch 檔。',
            );
          }
        }

        // 5. 試掛：寫下去之後有沒有新冒出的失敗。試掛在鎖外，這裡只認同一份紀錄、同一筆的結果。
        const seq = records.at(-1)?.seq;
        if (
          verdict === undefined ||
          verdict.seq !== seq ||
          !isDeepStrictEqual(verdict.body, body)
        ) {
          if (pass > TRIAL_RETRY_LIMIT) {
            return reject(
              `試掛期間變更紀錄一直被別人追加（重試 ${TRIAL_RETRY_LIMIT} 次），有人同時在改插件設定。這一筆沒寫；等對方改完，照新的清單重下一次。`,
            );
          }
          pending = { body, seq };
          return undefined;
        }
        if (verdict.rejection !== undefined) return reject(verdict.rejection);

        // 6. 什麼時候生效。
        const kind = classOfRow(change.id, pluginName);
        const needsRestart =
          kind === 'startup-read' ||
          (kind === 'mount-restart' && (body.op === 'disable' || body.op === 'enable'));
        effect = overridden ? 'overridden' : needsRestart ? 'restart' : 'next-thread';
        if (overridden) {
          warnings.push(
            `${JSON.stringify(change.id)} 的 disabled 被 --patch 蓋掉${coveredBy.length > 0 ? `（${coveredBy.join('、')}）` : ''}：` +
              '紀錄照寫，但清單上的效果不變。',
          );
        }
        if (body.op === 'disable' && WORKSPACE_REQUIRED_ROWS.has(change.id)) {
          warnings.push(
            `停用 ${change.id}：serve 帶 --workspace 時，之後每條新 thread 都會建不起來` +
              '（assembly-root.ts:803-818）。照寫了；要救回來就啟用它。',
          );
        }
        return body;
      },
    );
    if (pending === undefined) break;
  }
  if (rejection !== undefined) {
    if (record !== undefined) rejection.seq = record.seq;
    throw rejection;
  }

  const snapshotPresent = existsSync(pluginSnapshotPath(env));
  if (!snapshotPresent) {
    warnings.push(
      `${resolveHarnessHome(env)} 底下沒有 plugin-snapshot.json：serve 可能用的是另一個 home` +
        '（sudo 會改環境，NEXUS_AGENT_HOME 沒帶過去的話這裡就是預設位置）。紀錄寫了，但 serve 讀不讀得到這一份，請自己確認。',
    );
  }
  for (const message of collected) if (!warnings.includes(message)) warnings.push(message);

  if (record === undefined) {
    return {
      outcome: 'unchanged',
      path,
      fields: [],
      notes: unchangedReason === undefined ? [] : [unchangedReason],
      warnings,
      snapshotPresent,
    };
  }
  return {
    outcome: 'recorded',
    path,
    record,
    ...(effect !== undefined && { effect }),
    fields,
    notes,
    warnings,
    snapshotPresent,
  };
}

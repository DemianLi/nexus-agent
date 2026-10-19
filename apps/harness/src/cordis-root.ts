/**
 * serve 與 CLI 的 Cordis 根（[#1401](https://github.com/DemianLi/nexus-agent/issues/1401)，決議 §3-1 第 5 條的第一步）。
 *
 * ## 照 dsh 的 `boot()`
 *
 * dsh `packages/boot/app-boot/src/index.ts:975-1010`：`new Context()`、根上 provide 宿主的值（dsh 的 `dshHomePath`，
 * launcher 的 `cmdlineArgs`／`appExit`）、`await ctx.plugin(Loader)`、掛列、`loader.await()`、`auditStartupEntries`。
 * 這裡同一個順序。宿主的值是 {@link COMPAT_HOST_SERVICE}：這一次啟動的清單與解析基準，相容層 inject 它。樹上有這幾列：
 *
 * | 列 id | 是什麼 | dsh 對應 |
 * |---|---|---|
 * | `nexus-compat` | 相容層：`assembly-root.ts` 的整個組裝流程包成一顆插件，提供服務 {@link ASSEMBLY_SERVICE}「組一個 agent」 | `agent-loop`（提供 `agents`） |
 * | `cli`／`serve` | 入口那一列，`inject: [ASSEMBLY_SERVICE]` | `headless-runner`／`webserver` |
 * | `tools` | 行程級的工具登記處（`@nexus/tools/provider`，契約服務；#1416 PR 2） | `tools` 服務的提供者 |
 * | `projections` | 行程級的投影登記處（`@nexus/projections/provider`，契約服務；#1421），只收定義、不推動 | `sessionProjections` 服務的提供者 |
 * | `skill-sources` | 行程級的技能來源登記處（`@nexus/skills/provider`，契約服務；#1446），只收路徑、不掃描 | `skills` 服務的提供者 |
 * | `commands` | 行程級的命令登記處（`@nexus/commands/provider`，契約服務；#1456），只收定義、不執行 | `commands` 服務的提供者 |
 * | `approval-channel` | 行程級的預設答題管道（`@nexus/approval-channel/provider`，契約服務；#1458），**值由入口在建樹時給** | （無對應，偏離登記在 `@nexus/approval-channel`） |
 * | `session-lookup` | 行程級的會話查找（`@nexus/session/provider`，契約服務；#1463），**挑法由宿主給**：行程裡每一條活著的 thread 綁上的註冊表（`thread-sessions.ts`） | （無對應，偏離登記在 `@nexus/session`） |
 * | `fs` | 行程級的 fs 查找（`@nexus/fs/provider`，契約服務；#1466），**挑法由宿主給**：同一張登記表、同一支 `pickBoundForCall`，一筆登記同時帶這條 thread 的 fs 把手（就是那次組裝 host-services 裡的 `fs` 服務） | （dsh 的 `fs` 是行程全域一份、每個 agent 不同的東西以參數傳入；偏離登記在 `@nexus/fs`） |
 * | `pre-step` | 行程級的 `agent/pre-step` 登記處（`@nexus/agent-loop/provider`，契約服務；#1474），**插件登記 listener、宿主建 middleware**（`pre-step-middleware.ts`） | `agent/pre-step` 事件（偏離登記在 `@nexus/agent-loop`；列 id 刻意不叫 `agent-loop`，那個名字對到相容層） |
 * | `include` | vendor 的 Include：讀出貨的 `cordis.yml`、疊 patch、把函式插件掛起來（#1416 PR 2，`plugin-tree.ts`） | `include` |
 * | `include:<id>` | Include 底下的函式插件，模組有 `manifest` 匯出的才上樹（遷出了哪幾顆以 `migrated-plugin-gate.test.ts` 的 `EXPECTED_MIGRATED` 為準，不在這裡列名單） | 各插件 |
 *
 * `nexus-compat`、入口、`tools`、`projections`、`skill-sources`、`commands`、`approval-channel`、`session-lookup`、`fs`、`pre-step`、`include` 都必掛（`startup-audit.ts` 的 {@link auditTreeEntries}）；`include:<id>` 不在名單上，
 * 它掉了是清單那一列掉了，走 `dropped`。入口的程式碼經入口那一列的 inject 拿到服務，所有組 agent 的地方都走它。`tools`、
 * `projections`、`skill-sources`、`commands`、`approval-channel`、`session-lookup`、`fs`、`pre-step` 與 `include` 是**懶建**的（`PluginTree.context()` 第一次被叫到才建），`include` 要等第一次讀清單才有。
 *
 * **收尾**：相容層組出來的每一個 agent 都用 `ctx.effect` 登記收尾，登記完才交出去；agent 的 `dispose` 就是那筆 effect 的
 * 處置函式，所以正常收掉時那筆登記一起撤下，不會一條 thread 留一筆。根卸載時還沒收的 agent 由相容層的 fiber 收掉。這是 dsh
 * `agent-loop` 把 agent 綁在 `ownerCtx.effect` 上的同一招（`packages/core/agent-loop/src/index.ts:603-622`）。根由入口持有，
 * 照 dsh launcher 的 `app.current?.fiber.dispose()`（`apps/cli/src/profile-boot.ts:256-263`）：起不來與關掉時都卸載它。
 *
 * ## 偏離登記
 *
 * - **清單由變更紀錄導出（#1412），清單上只有函式插件的列在 Loader 的樹上（#1416 PR 2）**：dsh 的整棵樹本來就由一份 patch
 *   清單導出（`packages/boot/app-boot/src/index.ts:291`，`entry.update({ config: { ...includeConfig, patches } })`），所以
 *   「Cordis 不管插件」不是理由。我們的清單由 `loadDefaultPlugins` 疊出來——第二層是變更紀錄折出來的 patch
 *   （`plugin-journal.ts`、`plugin-config.ts`），經 {@link COMPAT_HOST_SERVICE} 交給相容層。**其餘的列不上樹的理由是插件
 *   還在相容層**：上樹跟著「逐顆搬出相容層」一起做（地圖終點第 1 項），現在放上去只會在相容層底下多一層轉接，而且 Loader
 *   對每列 `config` 跑 `interpolate` 深複製，清單項目的身分留不住（見下）。舊插件一行不改。**函式插件（模組有 `manifest` 匯出的才上樹；
 *   遷出了哪幾顆見 `docs/plugin-contract.md` 的「接進清單」與 `migrated-plugin-gate.test.ts` 的 `EXPECTED_MIGRATED`）**經 `plugin-tree.ts` 的 Include 上樹：patch 原樣推給 Include，相容層那一側仍然疊一份、驗一份、當清單的權威，兩邊疊出來
 *   對不上那一列就算掉了。
 * - **Include 的寫回全關（#1416 PR 2，`vendor/README.md` 第 7 條）**：上游 Include 會把樹側的變更寫回 `cordis.yml`，那是
 *   第二個寫入口，會繞過變更紀錄。vendor 時關掉三條寫回路徑，寫入口只有變更紀錄一個。這是對 dsh 做法的偏離，理由是我們的
 *   出貨檔是 repo 裡的檔、使用者的改動要留稽核軌跡。
 * - **橋接列（過渡）**：函式插件在相容層清單上有一個外殼（同 id、同位置），因為清單上其餘的列還是 `NexusPlugin`，要排在同
 *   一份清單、同一個順序裡。卡上寫「拿掉」，這是對字面的偏離；最後一顆搬出相容層時橋接連同相容層一起拿掉
 *   （`docs/plugin-contract.md` 的「接進清單」）。
 * - **入口的工作不在入口那一列裡**：dsh 的 `headless-runner` 在 `apply` 裡 `void run(...)`，跑在那一列的 fiber 底下。
 *   我們的入口那一列只把服務交回 `runCli`／`runServe`，對話迴圈與 HTTP 伺服器照舊跑在呼叫端的流程裡，理由是驗收 C：
 *   入口一路以來的錯誤（`StartupError`、旗標矛盾、續接失敗）要在同一個時刻、以同一個類別與同一句話拋給呼叫端。搬進
 *   `run` 的話，錯誤得改經 `appExit` 那一類通道出去，每一條的形狀都要重新對一遍，那是「每個 thread 重讀清單」之後的卡。
 *
 * 列的設定只能是 YAML 那種資料：Loader 對每一列的 `config` 跑一次 `interpolate`（vendor `loader/src/index.ts:79-87`），
 * 物件與陣列整份重建，清單項目的身分（`optionalEntries` 用它比對）留不住。所以清單走根上的 provide，不走列的設定。
 *
 * @module
 */

import type { Context } from '@nexus/cordis';
import type { EntryOptions } from '@nexus/cordis-plugin-loader';
import { deriveApprovalChannel } from '@nexus/core';
import type { ApprovalChannel, ApprovalPolicy, PluginEntry } from '@nexus/core';

import { createCliAgent } from './assembly-root.js';
import type { CreateCliAgentSession } from './assembly-root.js';
import { PluginTree } from './plugin-tree.js';
import type { SessionLookupRegistrar } from './thread-sessions.js';
import { auditTreeEntries } from './startup-audit.js';

/** 相容層提供的服務名。 */
export const ASSEMBLY_SERVICE = 'assembly';

/** 宿主在根上 provide 給相容層的服務名，值是 {@link CompatConfig}。 */
export const COMPAT_HOST_SERVICE = 'compatHost';

/** 相容層那一列的 id。 */
export const COMPAT_ENTRY_ID = 'nexus-compat';

/** 入口那一列的 id，也是它的種類。 */
export type Surface = 'cli' | 'serve';

type CliAgent = Awaited<ReturnType<typeof createCliAgent>>;

/** 相容層要的宿主值：這一次啟動的清單與解析基準。走根上的 provide，不走列的設定，理由見檔頭。 */
export interface CompatConfig {
  /** `loadDefaultPlugins` 解出來的清單。 */
  readonly plugins: readonly PluginEntry[];
  /** `--workspace` 的解析基準，省略即行程的工作目錄；原樣交給 `createCliAgent`。 */
  readonly cwd?: string;
  /**
   * 這棵樹上會話查找的登記面（#1463）。**`createCordisRoot().boot` 自己填，呼叫端不用傳**：每一次組裝的 `attachSession`
   * 綁上之後往它登記，樹上 `session-lookup` 那一列問的就是它。直接用 `compatLayer`（測試）不給就是沒有樹的組裝。
   */
  readonly sessionLookup?: SessionLookupRegistrar;
}

/** 組一個 agent 的選項。 */
export interface AssembleOptions {
  /** 換一份清單組：serve 每條 thread 用的是試組掉了的列標成沒掛的那一份。省略即相容層那一列的清單。 */
  readonly plugins?: readonly PluginEntry[];
  /** 入口身分的選項，見 {@link CreateCliAgentSession}。 */
  readonly session?: CreateCliAgentSession;
}

/** 相容層提供的服務：組一個 agent。 */
export interface NexusAssembly {
  /**
   * 組一個 agent，參數與回傳同 `createCliAgent`。回傳的 `dispose` 收掉 agent 並撤下相容層那筆收尾登記。
   *
   * @throws 同 `createCliAgent`。
   */
  create(
    invocation: Parameters<typeof createCliAgent>[0],
    options?: AssembleOptions,
  ): Promise<CliAgent>;
}

declare module '@nexus/cordis' {
  interface Context {
    [ASSEMBLY_SERVICE]: NexusAssembly;
    [COMPAT_HOST_SERVICE]: CompatConfig;
  }
}

/**
 * 相容層：一顆 Cordis 插件包住整個組裝流程。
 *
 * 在 `provide` 之前什麼資源都不開；每個 agent 組好就登記收尾、登記完才交出去，所以探針 ③ 量到的「收尾排在 provide 之後
 * 會漏」在這裡沒有可漏的東西。
 */
export const compatLayer = {
  name: COMPAT_ENTRY_ID,
  inject: [COMPAT_HOST_SERVICE],
  apply(ctx: Context) {
    const config = ctx[COMPAT_HOST_SERVICE];
    ctx.provide(ASSEMBLY_SERVICE, {
      create: async (invocation, options = {}) => {
        const built = await createCliAgent(
          invocation,
          options.plugins ?? config.plugins,
          config.cwd,
          // 樹上的會話查找（#1463）：兩個產品入口的每一次組裝都往它登記；呼叫端自己給的 `session.sessionLookup` 優先（測試）。
          config.sessionLookup === undefined
            ? options.session
            : { sessionLookup: config.sessionLookup, ...options.session },
        );
        // 組好就登記、登記完才交出去：交出去之後的任何一步失敗，根卸載時都收得到它。
        const release = ctx.effect(() => () => built.dispose(), 'nexus-compat/agent');
        return {
          ...built,
          dispose: async () => {
            await release();
          },
        };
      },
    } satisfies NexusAssembly);
  },
};

/** 入口那一列：拿到相容層的服務就交回入口的程式碼。 */
function surfacePlugin(surface: Surface, handoff: (assembly: NexusAssembly) => void) {
  return {
    name: surface,
    inject: [ASSEMBLY_SERVICE],
    apply(ctx: Context) {
      handoff(ctx[ASSEMBLY_SERVICE]);
    },
  };
}

/** 入口持有的根。 */
export interface CordisRoot {
  /**
   * 樹上的函式插件那一面（#1416 PR 2）：入口把它交給 `loadDefaultPlugins`，清單上的函式插件從這棵長壽的樹來。
   * 根在第一次用到時才建（讀清單早於 {@link boot}），所以讀清單那一步拋的錯照舊發生在同一個時刻。
   */
  readonly tree: PluginTree;
  /**
   * 建根、掛相容層與入口那一列、等樹結算、跑啟動結算。起不來就先卸載再拋。
   *
   * @returns 相容層的服務，經入口那一列的 inject 拿到的那一份。
   * @throws {StartupError} 有必掛的列沒起來，訊息指名那一列與原因。
   */
  boot(surface: Surface, config: CompatConfig): Promise<NexusAssembly>;
  /** 卸載整棵樹；還沒建或已卸載時什麼都不做。 */
  dispose(): Promise<void>;
}

/**
 * 這個入口的預設答題管道：從入口的核准政策算（#1458 Q1 (c)）。
 *
 * CLI 傳 `HEADLESS_APPROVALS`（沒有人在）、serve 傳 `undefined`（有人在）：入口知道自己的情境，ask-user 只消費。
 * 兩個入口的組裝一律給 `PrunedMemorySaver`，所以「有存檔點」是常數 `true`；那一格與組裝根（`assembly-root.ts`）用同一支
 * `deriveApprovalChannel`，驗收 E 的測試對一次。
 *
 * @param approvals - 這個入口給組裝的核准政策（`createCliAgent` 的 `session.approvals`）。
 */
export function entryApprovalChannel(approvals?: ApprovalPolicy): ApprovalChannel {
  return deriveApprovalChannel({
    ...(approvals?.enabled !== undefined && { approvalsEnabled: approvals.enabled }),
    hasCheckpointer: true,
  });
}

/** {@link createCordisRoot} 的選項。 */
export interface CordisRootOptions {
  /**
   * 這棵樹預設的答題管道（`approval-channel` 那一列的值）。**入口明確交進來，這裡不自己算**：不給就是「宿主沒有指定」，
   * ask-user 在呼叫當下拒絕（fail-closed）——拿掉入口那一行交接，serve 與 CLI 的測試都會紅，這就是驗收 E 要的。
   */
  readonly channel?: ApprovalChannel;
  /**
   * 這個行程的工作區根（`fs` 那一列的 `workspaceRoot()`；#1491 Q4 (a)）。**入口明確交進來，這裡不自己算**：入口照
   * `resolveWorkspaceRoot(invocation.workspace, cwd)` 算（跟組裝點是同一支函式、同一個 cwd），沒有 `--workspace` 就不給。
   * 拿掉入口那一行交接，`permission-presets` 以為沒有圍堵、整顆不註冊 `/permission`——CLI 與 serve 的測試都會紅。
   */
  readonly workspaceRoot?: string;
}

/** 一個還沒建的根。入口先拿到它，失敗與關掉的收尾才有東西可收，照 dsh launcher 的 `app.current`。 */
export function createCordisRoot(options: CordisRootOptions = {}): CordisRoot {
  const tree = new PluginTree({
    ...(options.channel !== undefined && { channel: options.channel }),
    ...(options.workspaceRoot !== undefined && { workspaceRoot: options.workspaceRoot }),
  });
  let booted = false;
  const dispose = async (): Promise<void> => {
    await tree.dispose();
  };
  return {
    tree,
    async boot(surface, config) {
      if (booted) throw new Error('Cordis 根已經建過了');
      booted = true;
      let assembly: NexusAssembly | undefined;
      try {
        const root: Context = await tree.context();
        root.provide(COMPAT_HOST_SERVICE, { ...config, sessionLookup: tree.threadSessions });
        Object.assign(root.loader.builtins, {
          [COMPAT_ENTRY_ID]: compatLayer,
          [surface]: surfacePlugin(surface, (provided) => {
            assembly = provided;
          }),
        });
        // `EntryTree.create` 的型別不收 id，執行期照用（探針 `tree.ts` 的 `createEntry`）：列 id 要由我們決定。
        const create = (options: EntryOptions) =>
          root.loader.create(options as Omit<EntryOptions, 'id'>);
        await create({ id: COMPAT_ENTRY_ID, name: `cordis:${COMPAT_ENTRY_ID}` });
        await create({ id: surface, name: `cordis:${surface}` });
        await root.loader.await();
        // 回傳的是可少掛而沒起來的列：今天樹上兩列都必掛，沒有東西可印；有了可少掛的列再接進 `startupWarning`。
        await auditTreeEntries(root.loader);
      } catch (error) {
        await dispose().catch(() => {});
        throw error;
      }
      if (assembly === undefined) {
        await dispose();
        throw new Error(`入口那一列（${surface}）起來了卻沒拿到 ${ASSEMBLY_SERVICE}`);
      }
      return assembly;
    },
    dispose,
  };
}

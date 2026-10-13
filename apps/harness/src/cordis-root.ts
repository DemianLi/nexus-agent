/**
 * serve 與 CLI 的 Cordis 根（[#1401](https://github.com/DemianLi/nexus-agent/issues/1401)，決議 §3-1 第 5 條的第一步）。
 *
 * ## 照 dsh 的 `boot()`
 *
 * dsh `packages/boot/app-boot/src/index.ts:975-1010`：`new Context()`、根上 provide 宿主的值（dsh 的 `dshHomePath`，
 * launcher 的 `cmdlineArgs`／`appExit`）、`await ctx.plugin(Loader)`、掛列、`loader.await()`、`auditStartupEntries`。
 * 這裡同一個順序。宿主的值是 {@link COMPAT_HOST_SERVICE}：這一次啟動的清單與解析基準，相容層 inject 它。樹上有兩列：
 *
 * | 列 id | 是什麼 | dsh 對應 |
 * |---|---|---|
 * | `nexus-compat` | 相容層：`assembly-root.ts` 的整個組裝流程包成一顆插件，提供服務 {@link ASSEMBLY_SERVICE}「組一個 agent」 | `agent-loop`（提供 `agents`） |
 * | `cli`／`serve` | 入口那一列，`inject: [ASSEMBLY_SERVICE]` | `headless-runner`／`webserver` |
 *
 * 兩列都必掛（`startup-audit.ts` 的 {@link auditTreeEntries}）。入口的程式碼經入口那一列的 inject 拿到服務，所有組 agent 的地方
 * 都走它。
 *
 * **收尾**：相容層組出來的每一個 agent 都用 `ctx.effect` 登記收尾，登記完才交出去；agent 的 `dispose` 就是那筆 effect 的
 * 處置函式，所以正常收掉時那筆登記一起撤下，不會一條 thread 留一筆。根卸載時還沒收的 agent 由相容層的 fiber 收掉。這是 dsh
 * `agent-loop` 把 agent 綁在 `ownerCtx.effect` 上的同一招（`packages/core/agent-loop/src/index.ts:603-622`）。根由入口持有，
 * 照 dsh launcher 的 `app.current?.fiber.dispose()`（`apps/cli/src/profile-boot.ts:256-263`）：起不來與關掉時都卸載它。
 *
 * ## 偏離登記
 *
 * - **清單由變更紀錄導出（#1412），但清單上的列不在 Loader 的樹上**：dsh 的整棵樹本來就由一份 patch 清單導出
 *   （`packages/boot/app-boot/src/index.ts:291`，`entry.update({ config: { ...includeConfig, patches } })`），所以「Cordis 不管
 *   插件」不是理由。我們的清單由 `loadDefaultPlugins` 疊出來——第二層是變更紀錄折出來的 patch（`plugin-journal.ts`、
 *   `plugin-config.ts`），經 {@link COMPAT_HOST_SERVICE} 交給相容層。**列不上樹的理由是插件還在相容層**：上樹跟著
 *   「逐顆搬出相容層」一起做（地圖終點第 1 項），現在放上去只會在相容層底下多一層轉接，而且 Loader 對每列 `config` 跑
 *   `interpolate` 深複製，清單項目的身分留不住（見下）。舊插件一行不改。
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

import { Context } from '@nexus/cordis';
import Loader from '@nexus/cordis-plugin-loader';
import type { EntryOptions } from '@nexus/cordis-plugin-loader';
import type { PluginEntry } from '@nexus/core';

import { createCliAgent } from './assembly-root.js';
import type { CreateCliAgentSession } from './assembly-root.js';
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
          options.session,
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
   * 建根、掛相容層與入口那一列、等樹結算、跑啟動結算。起不來就先卸載再拋。
   *
   * @returns 相容層的服務，經入口那一列的 inject 拿到的那一份。
   * @throws {StartupError} 有必掛的列沒起來，訊息指名那一列與原因。
   */
  boot(surface: Surface, config: CompatConfig): Promise<NexusAssembly>;
  /** 卸載整棵樹；還沒建或已卸載時什麼都不做。 */
  dispose(): Promise<void>;
}

/** 一個還沒建的根。入口先拿到它，失敗與關掉的收尾才有東西可收，照 dsh launcher 的 `app.current`。 */
export function createCordisRoot(): CordisRoot {
  let current: Context | undefined;
  const dispose = async (): Promise<void> => {
    const root = current;
    current = undefined;
    await root?.fiber.dispose();
  };
  return {
    async boot(surface, config) {
      if (current !== undefined) throw new Error('Cordis 根已經建過了');
      const root = new Context();
      current = root;
      let assembly: NexusAssembly | undefined;
      try {
        root.provide(COMPAT_HOST_SERVICE, config);
        await root.plugin(Loader);
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

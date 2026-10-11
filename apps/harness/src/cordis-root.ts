/**
 * serve 與 CLI 的 Cordis 根（[#1401](https://github.com/DemianLi/nexus-agent/issues/1401)，決議 §3-1 第 5 條的第一步）。
 *
 * ## 照 dsh 的 `boot()`
 *
 * dsh `packages/boot/app-boot/src/index.ts:975-1010`：`new Context()`、`await ctx.plugin(Loader)`、掛列、`loader.await()`、
 * `auditStartupEntries`。這裡同一個順序，樹上有兩列：
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
 * - **清單不是 Loader 讀的**：dsh 的樹由 Include 讀 YAML 長出來；我們的清單仍由 `loadDefaultPlugins` 解（樹由變更紀錄
 *   導出是後台插拔那幾張卡的事，決議 §3-5）。**而且不經那一列的 `config` 進來**：Loader 對每一列的設定跑一次
 *   `interpolate`（vendor `loader/src/index.ts:79-87`），物件與陣列整份重建，清單項目的身分（`optionalEntries` 用它比對）
 *   與外掛物件都留不住——列的設定只能是 YAML 那種資料。表達不出來的是「把執行期物件交給一列」，退到最接近的：相容層
 *   那一列的內建插件由這一次啟動的閉包帶著清單，列本身不帶設定。
 * - **入口的工作不在 `apply` 裡**：dsh 的 `headless-runner` 在 `apply` 裡 `void run(...)`。我們的入口那一列只把服務交回
 *   `runCli`／`runServe`，對話迴圈與 HTTP 伺服器照舊跑在呼叫端的流程裡。表達不出來的是「入口的錯誤原樣拋給呼叫端」：
 *   `apply` 裡拋的錯會變成那一列 FAILED，入口一路以來的錯誤（`StartupError`、旗標矛盾、續接失敗）就得換一種形狀出去，
 *   使用者看到的字會變（驗收 C）。退到最接近的：入口那一列只負責 inject，生命週期仍歸根。
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

/** 相容層那一列的 id。 */
export const COMPAT_ENTRY_ID = 'nexus-compat';

/** 入口那一列的 id，也是它的種類。 */
export type Surface = 'cli' | 'serve';

type CliAgent = Awaited<ReturnType<typeof createCliAgent>>;

/** 相容層手上的東西：這一次啟動的清單與解析基準。不是列的設定，理由見檔頭的偏離登記。 */
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
  }
}

/** 相容層：一顆 Cordis 插件包住整個組裝流程。掛上樹時由 {@link createCordisRoot} 綁上這一次的 {@link CompatConfig}。 */
export const compatLayer = {
  name: COMPAT_ENTRY_ID,
  apply(ctx: Context, config: CompatConfig) {
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
        await root.plugin(Loader);
        Object.assign(root.loader.builtins, {
          // 箭頭函式：沒有 `prototype`，Cordis 不會把它當 class `new`。
          [COMPAT_ENTRY_ID]: {
            name: COMPAT_ENTRY_ID,
            apply: (ctx: Context) => compatLayer.apply(ctx, config),
          },
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

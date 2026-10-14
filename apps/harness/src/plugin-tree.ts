/**
 * Cordis 樹上的插件那一面（[#1416](https://github.com/DemianLi/nexus-agent/issues/1416) PR 2，決議 §3-1 第 5 條的第二步）。
 *
 * `cordis-root.ts` 的樹上本來只有兩列（相容層與入口）。這一刀起還有三種東西：
 *
 * | 列 | 是什麼 | dsh 對應 |
 * |---|---|---|
 * | `tools` | 行程級的工具登記處（`@nexus/tools/provider`），契約服務，一列 | `tools` 服務的提供者 |
 * | `projections` | 行程級的投影登記處（`@nexus/projections/provider`，#1421），契約服務，一列 | `sessionProjections` 服務的提供者 |
 * | `include` | vendor 的 Include：讀出貨的 `cordis.yml`，疊上 patch，把樹掛起來 | `include`（`app-boot` 的 `entry.update({ config: { ...includeConfig, patches } })`） |
 * | `include:<id>` | Include 底下的列，今天是 echo 與 token-meter（模組有 `manifest` 匯出的才上樹） | 各插件 |
 *
 * ## 清單怎麼進樹
 *
 * 變更紀錄折出來的 patch 與 `--patch` 的 patch，原樣推給 Include（`entry.update({ config: { ...config, patches } })`），
 * 樹上的列由 Include 自己疊（上游 `applyPatches`）。**Include 不寫回任何檔**（`vendor/README.md` 第 7 條）：寫入口只有變更紀錄一個。Loader 上游會在安裝樹建 `.cordis/` 輔助檔，這裡給了解析函式（{@link resolveBareSpecifier}，第 9 條）就不建：產品路徑不依賴安裝樹可寫。
 * 疊的規則跟相容層那邊（`applyEntryPatches`）是兩支，所以每次推完都對一次：樹上那一列的 `disabled` 與 `config` 跟相容層
 * 疊出來的不一致，那一列就算掉了，不靜靜地各走各的（`diverged`）。
 *
 * ## 臨界區
 *
 * 「讀清單 → 推給樹 → 等收斂 → 取工具快照」是一段（{@link PluginTree.run}）：兩條 thread 同時組裝時各自要拿到
 * **跟自己讀到的清單相符**的工具，不能一條讀到舊清單、另一條推了新清單、它又取到新的。**只包這一段，不包整個組裝**。
 * 清單沒變時（簽章同上一次）不推，只重取快照。
 *
 * ## 收斂的語意（實測，`vendor/include/nexus-tests/convergence.spec.ts`）
 *
 * `await entry.update({ config })` 回來時 Include 底下的樹已經收斂：停用的那一列已卸載、登記處已撤；啟用的已重掛；
 * 改設定的舊值已撤、新值已進；同值的什麼都沒動。所以快照在這之後取，不必再輪詢。
 *
 * ## 偏離登記
 *
 * - **插件自我停用只在行程裡停著，紀錄只記不折**（#1424，demian 2026-10-14 拍板 Q1 (b)、Q2 (a)；PM 決議 Q-C 的後續）：Loader 的
 *   case 7 把那一列在樹上標成 `disabled`，Include 不寫檔，也不折進清單。樹把「這一列自我停用過、當時的宣告是什麼」記在
 *   記憶體裡（{@link PluginTree}`.#selfDisabled`）：**宣告沒變就不推 `epoch`、不重掛，判成 `off`**，所以不再每條 thread 重掛一次
 *   再停一次（閃動）；serve 重啟、或那一列的宣告改了（模組名或設定），下一次同步才再試。Loader 在 case 7 呼叫點發的
 *   `loader/self-disable`（`vendor/loader` 本地修改第 10 條，只有 case 7 發；`ctx.fiber.update()` 走的 `internal/commit` 不發）
 *   經 {@link PluginTree.onSelfDisable} 交給宿主，serve 把它記成 `self-disabled`（`plugin-failure-recorder.ts`）。
 *   **偏離 dsh（未實測的推論，撤除條件：讀清單改成不是每條 thread 都推）**：dsh 任何一次協調（plugin-manager 操作、HMR 偵測到
 *   patch 檔改了）都會把 Include 的樹重疊一遍、把自我停用的列蓋回啟用；這裡只在那一列自己的宣告改了才重試，因為 nexus 每條
 *   thread 都重推一次——照 dsh「每次協調都蓋回」就是原本的閃動。
 * - **`cordis.serve.yml` 不經 Include**：Include 只有一個 `path`，serve 專屬那一層是相容層疊在出貨層後面的另一個檔。
 *   那一層裡的函式插件上不了樹（它們會在這裡被判成 `absent`，指名原因）；今天那一層沒有函式插件。
 *
 * @module
 */

import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';

import type { StructuredToolInterface } from '@langchain/core/tools';
import type { ProjectionUnit } from '@nexus/core';
import { Context } from '@nexus/cordis';
import type { Message } from '@nexus/cordis';
import Include from '@nexus/cordis-plugin-include';
import Loader from '@nexus/cordis-plugin-loader';
import type { EntryOptions } from '@nexus/cordis-plugin-loader';
import { createProjectionsProvider } from '@nexus/projections/provider';
import type { ProjectionEntry } from '@nexus/projections/provider';
import { ContractError, FIBER_STATE, missingServices } from '@nexus/sdk';
import { createToolsProvider } from '@nexus/tools/provider';
import type { ToolEntry } from '@nexus/tools/provider';

/** 工具登記處那一列的 id。 */
export const TOOLS_ROW_ID = 'tools';

/** 投影登記處那一列的 id。 */
export const PROJECTIONS_ROW_ID = 'projections';

/** Include 那一列的 id。 */
export const INCLUDE_ROW_ID = 'include';

/** Include 底下每一列 id 的前綴（上游 Include 的命名空間規則）。 */
const NAMESPACE = `${INCLUDE_ROW_ID}:`;

/** 一顆函式插件模組：有 `manifest` 具名匯出。 */
export interface FunctionPluginModule {
  readonly name?: unknown;
  readonly manifest: unknown;
  readonly [key: string]: unknown;
}

/**
 * 這個模組是不是樹上的函式插件。
 *
 * **這是唯一的判別式**：`resolveEntryModule` 用它決定一列走橋接還是走 `NexusPlugin`，Include 的允許名單
 * （`only`）是從走橋接的那幾列算出來的，所以兩邊不會漂移。判別看的是「有沒有 `manifest` 具名匯出」，不看 default：
 * 函式插件不能有 default（一致性套件的 `export-form` 格），所以有 `manifest` 又有 default 的模組是寫壞的函式插件，
 * 該報的是 manifest／匯出形式的錯，不是把它當 `NexusPlugin` 悄悄掛上。
 *
 * @param namespace - `import()` 回來的模組命名空間。
 */
export function isFunctionPluginModule(namespace: unknown): namespace is FunctionPluginModule {
  if (typeof namespace !== 'object' || namespace === null) return false;
  return (namespace as { manifest?: unknown }).manifest !== undefined;
}

/** 一列要上樹的：相容層解析後的 id、模組名、最終宣告。 */
export interface TreeRowInput {
  /** 相容層解析後的列 id（補過號）。樹上那一列是 `include:<id>`。 */
  readonly id: string;
  /** 模組 specifier，即那一列的 `name`；Include 的允許名單比它。 */
  readonly module: string;
  /** 相容層疊完之後這一列是停用的（含設定驗不過被標成停用）。 */
  readonly disabled: boolean;
  /** 相容層疊完之後這一列的 `config`（原始的，沒驗過）。 */
  readonly config: unknown;
}

/** 交給樹的一份輸入。 */
export interface TreeInput {
  /** 出貨 `cordis.yml` 的絕對路徑；Include 讀它。 */
  readonly shipped: string;
  /** 推給 Include 的 patch，已過濾、已補 id、已補 `config: {}`。 */
  readonly patches: readonly Record<string, unknown>[];
  /** 這一份清單上走橋接的每一列。 */
  readonly rows: readonly TreeRowInput[];
}

/** 一列在樹上的結果。 */
export type RowVerdict =
  | {
      readonly kind: 'active';
      /** 登記者就是這一列的工具。 */
      readonly tools: readonly StructuredToolInterface[];
      /**
       * **這一列負責折進這條 thread 的**投影單元（#1421）：登記者是這一列、而且這一列是那個 key 目前還活著的第一個登記者。
       * 同一個 key 由兩列共用時（提供者那一層引用計數共用，PM 決策 1），每個 key 只交給其中一列，這條 thread 的登記處才
       * 不會撞上它自己的重複拒絕（`NamedEntries`，照舊）。
       */
      readonly projections: readonly ProjectionUnit[];
    }
  | { readonly kind: 'off' }
  | {
      readonly kind: 'dropped';
      /** 對到 `startup-audit.ts` 的 stage：FAILED／缺席是 `apply`，PENDING（缺服務、契約不相容）是 `requires`。 */
      readonly stage: 'apply' | 'requires';
      readonly message: string;
    };

/** 一次同步之後每一列的結果。 */
export interface TreeSnapshot {
  verdict(id: string): RowVerdict;
}

/** 推不上樹：Include 起不來，或清單裡有樹不收的東西。整份的錯，不是某一列的。 */
export class PluginTreeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PluginTreeError';
  }
}

/**
 * 樹上裸 specifier（`@nexus/plugin-echo`）的解析：錨在這個檔所在的專案（`apps/harness`），跟 Loader 預設的輔助檔
 * 錨在 `cordis.yml` 所在目錄是同一個專案。**給了它 Loader 就不在安裝樹裡寫 `.cordis/{.gitignore,resolve.mjs}`**
 * （`vendor/loader` 本地修改第 9 條）：唯讀的安裝樹、別的帳號建過的目錄，都不該讓插件掛不上，也不該在
 * 安裝樹裡多出檔案。
 */
const resolveBareSpecifier = (specifier: string): string => import.meta.resolve(specifier);

const treeId = (id: string): string => `${NAMESPACE}${id}`;

/** `undefined` 與 `{}` 在這裡是同一件事：相容層沒寫 `config` 就是 `{}`，樹那一側為了 strictObject 補的也是 `{}`。 */
const normalized = (config: unknown): unknown => config ?? {};

/**
 * 樹上帶 `__jsExpr` 的物件會被 Loader 的 `interpolate` 當 JavaScript `eval` 掉（`vendor/loader/src/config/utils.ts`），
 * 而設定來自變更紀錄與 `--patch`：寫入口的使用者、部署端都不該有「經設定檔執行任意程式」的路。
 *
 * 兩個地方各擋一次：相容層讀清單時掃走橋接那幾列的最終 `config`（寫入前驗證走同一條，所以寫入口當場擋下、
 * 不會把會讓之後每次啟動都失敗的東西寫進紀錄）；推上樹之前再把整份 patch 掃一遍，是「演算法對不上」時的後盾。
 *
 * @param value - 要掃的東西（設定或 patch）。
 * @param where - 訊息裡怎麼稱呼它的位置。
 * @returns 第一個帶 `__jsExpr` 的位置；沒有就是 `undefined`。
 */
export function findJsExpr(value: unknown, where: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findJsExpr(item, `${where}[${String(index)}]`);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === '__jsExpr') return where;
    const found = findJsExpr(item, `${where}.${key}`);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** {@link findJsExpr} 找到了就拋。 */
function assertNoJsExpr(value: unknown, where: string): void {
  const found = findJsExpr(value, where);
  if (found === undefined) return;
  throw new PluginTreeError(
    `${found} 帶了 \`__jsExpr\`：樹上的設定不接受表達式（Loader 會把它 eval 掉）。拒絕這一份清單。`,
  );
}

/** 一列插件自己停用了自己（#1424）：Loader 在 case 7 的呼叫點發的，經 {@link PluginTree.onSelfDisable} 交給宿主。 */
export interface SelfDisableEvent {
  /** 相容層解析後的列 id（不帶樹上的 `include:` 前綴）。 */
  readonly id: string;
  /** 模組 specifier，即那一列的 `name`。 */
  readonly module: string;
}

/** 穩定的序列化（物件鍵排序）：宣告簽章與去重鍵用，兩邊疊出來的鍵順序不同也算同一份。 */
function stableStringify(value: unknown): string {
  if (typeof value !== 'object' || value === null) return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
}

/** 一列的宣告：模組名與（正規化後的）設定。自我停用的記憶與去重都以它為準。 */
interface RowDeclaration {
  readonly module: string;
  readonly config: unknown;
}

const declarationSignature = (declaration: RowDeclaration): string =>
  stableStringify({ module: declaration.module, config: normalized(declaration.config) });

/** 一棵 Cordis 樹加上它的工具登記處與 Include。 */
export class PluginTree {
  #context?: Promise<Context>;
  #provider = createToolsProvider();
  #projections = createProjectionsProvider();
  /** 串行化 {@link run}。 */
  #chain: Promise<unknown> = Promise.resolve();
  /** 最後一次推給 Include 的設定簽章；一樣就不推。 */
  #signature?: string;
  #epoch = 0;
  /** 契約不相容的錯誤，以消費者那一列的 id 為鍵：Cordis 把它交給提供者的 logger，要對回消費者得自己收。 */
  readonly #contractErrors = new Map<string, ContractError>();
  #disposed = false;
  /**
   * **自我停用過的列**（#1424，Q1 (b)）：鍵是樹上的列 id，值是它**停用當時**的宣告。宣告沒變就一直算停著（不推 `epoch`、
   * 判成 `off`）；宣告改了、或那一列又起來了就忘掉。只活在這個行程裡：重啟就是新的一棵樹，那一列重新試一次。
   */
  readonly #selfDisabled = new Map<string, RowDeclaration>();
  /** 已經交給 {@link onSelfDisable} 的（列 id ＋ 宣告簽章）：同一個行程裡同一件事只講一次（#1424 推導 4）。 */
  readonly #announced = new Set<string>();

  /**
   * 宿主掛上來的接收者：插件自己停用了自己時呼叫（同一個行程裡、同一列同一份宣告只呼叫一次）。**同步呼叫，不要拋、
   * 不要等**：它在 Loader 卸載那一列的路上被叫到。今天只有 serve 掛它，把這件事記進變更紀錄；CLI 與沒有樹的呼叫端不掛，
   * 閃動照樣止住（記憶體那一頭）。
   */
  onSelfDisable?: (event: SelfDisableEvent) => void;

  /**
   * 這棵樹的根 context。第一次呼叫才建：根、Loader 與 `tools`、`projections` 那兩列。
   *
   * @returns 已掛好 Loader 與 `tools`、`projections` 列的根。
   */
  context(): Promise<Context> {
    this.#context ??= this.#build();
    return this.#context;
  }

  async #build(): Promise<Context> {
    const root = new Context();
    root.logger.exporter({
      export: (message: Message) => {
        if (message.type !== 'error') return;
        for (const arg of message.args) {
          if (arg instanceof ContractError) this.#contractErrors.set(arg.consumer, arg);
        }
      },
    });
    await root.plugin(Loader);
    root.loader.resolver = resolveBareSpecifier;
    // Loader 的 case 7 呼叫點發的（`vendor/loader` 本地修改第 10 條）：只有插件自己 `ctx.fiber.dispose()` 才有。
    root.on('loader/self-disable', (entry, legacy) => this.#noteSelfDisable(root, entry, legacy));
    Object.assign(root.loader.builtins, {
      [TOOLS_ROW_ID]: this.#provider.Provider,
      [PROJECTIONS_ROW_ID]: this.#projections.Provider,
      [INCLUDE_ROW_ID]: Include,
    });
    await this.#create(root, { id: TOOLS_ROW_ID, name: `cordis:${TOOLS_ROW_ID}` });
    await this.#create(root, { id: PROJECTIONS_ROW_ID, name: `cordis:${PROJECTIONS_ROW_ID}` });
    await root.loader.await();
    return root;
  }

  #noteSelfDisable(
    root: Context,
    entry: { readonly options: { readonly id: string; readonly name: string } },
    legacy: { readonly config?: unknown },
  ): void {
    // 只管 Include 底下的列（橋接列）：它們在 Include 的群組裡，`entry.options.id` 是不帶前綴的本地 id，樹上的完整 id 是
    // `include:<id>`；`tools`、`projections`、`include` 自己是樹的骨架，不在這一組。用身分比，不用字串猜。
    const id = entry.options.id;
    const treeRowId = treeId(id);
    try {
      if (root.loader.resolve(treeRowId) !== entry) return;
    } catch {
      return;
    }
    const declaration: RowDeclaration = {
      module: entry.options.name,
      config: structuredClone(normalized(legacy.config)),
    };
    this.#selfDisabled.set(treeRowId, declaration);
    const key = `${id}\0${declarationSignature(declaration)}`;
    if (this.#announced.has(key)) return;
    this.#announced.add(key);
    try {
      this.onSelfDisable?.({ id, module: declaration.module });
    } catch {
      // 接收者不該拋；拋了也不能讓 Loader 卸載那一列的路上多一種結局。
    }
  }

  /** `EntryTree.create` 的型別不收 id，執行期照用（探針 `tree.ts` 的 `createEntry`）：列 id 要由我們決定。 */
  #create(root: Context, options: EntryOptions): Promise<unknown> {
    return root.loader.create(options as Omit<EntryOptions, 'id'>);
  }

  /**
   * 跑一段臨界區：同一棵樹上的 {@link run} 一次只跑一段。
   *
   * @param work - 臨界區的內容，通常是「讀清單、{@link sync}、取快照」。
   */
  run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#chain.then(work, work);
    this.#chain = next.catch(() => undefined);
    return next;
  }

  /**
   * 把清單推給 Include、等收斂、取每一列的結果。**呼叫端要在 {@link run} 裡。**
   *
   * @param input - 這一份清單。
   * @returns 每一列的結果。
   * @throws {PluginTreeError} Include 起不來，或清單帶了樹不收的東西。
   */
  async sync(input: TreeInput): Promise<TreeSnapshot> {
    const root = await this.context();
    assertNoJsExpr(input.patches, 'patch');
    const only = [...new Set(input.rows.map((row) => row.module))];
    const forced = this.#needsRetry(root, input);
    if (forced) this.#epoch += 1;
    const config = {
      path: pathToFileURL(input.shipped).href,
      patches: structuredClone(input.patches),
      only,
      ...(this.#epoch === 0 ? {} : { epoch: this.#epoch }),
    };
    const signature = JSON.stringify(config);
    const loader = root.loader;
    const existing = this.#includeEntry(root);
    if (existing === undefined) {
      await this.#create(root, { id: INCLUDE_ROW_ID, name: `cordis:${INCLUDE_ROW_ID}`, config });
      await loader.await();
    } else if (signature !== this.#signature) {
      if (this.#includeState(root) !== FIBER_STATE.ACTIVE) {
        // 上一次沒起來（檔壞了又好了）：整列拆掉重建，不在 FAILED 的 fiber 上更新。
        await existing.fiber?.ctx.fiber.dispose();
        loader.remove(INCLUDE_ROW_ID);
        await this.#create(root, { id: INCLUDE_ROW_ID, name: `cordis:${INCLUDE_ROW_ID}`, config });
      } else {
        await existing.update({ config } as never);
      }
      await loader.await();
    }
    this.#signature = signature;
    if (this.#includeState(root) !== FIBER_STATE.ACTIVE) {
      const message = await this.#failureOf(root, INCLUDE_ROW_ID);
      throw new PluginTreeError(`Include 那一列沒有起來，清單推不上樹：${message}`);
    }
    return this.#snapshot(root, input.rows);
  }

  #includeEntry(root: Context) {
    try {
      return root.loader.resolve(INCLUDE_ROW_ID);
    } catch {
      return undefined;
    }
  }

  #includeState(root: Context): number | undefined {
    return this.#includeEntry(root)?.fiber?.ctx.fiber.state;
  }

  /**
   * 這一份清單要不要強推一次（推 `epoch`）：有一列清單想要它起來、樹上卻是停用的，而且**不是**「自我停用過、宣告沒變」那一種。
   *
   * 自我停用過的列（#1424）宣告沒變就一直停著，不強推——這就是止住閃動的那一處；宣告變了就忘掉記憶、強推一次，插件重新
   * 掛上、重新試一次。樹上停用卻沒有記憶的（不是 case 7 留下的，或是兩邊疊出來的不一致）照舊強推，`#verdictOf` 會報成掉了。
   */
  #needsRetry(root: Context, input: TreeInput): boolean {
    if (this.#includeEntry(root) === undefined) return false;
    let retry = false;
    for (const row of input.rows) {
      if (row.disabled) continue;
      let disabled = false;
      try {
        disabled = root.loader.resolve(treeId(row.id)).options.disabled === true;
      } catch {
        continue;
      }
      if (!disabled) continue;
      if (this.#stillSelfDisabled(treeId(row.id), row)) continue;
      this.#selfDisabled.delete(treeId(row.id));
      retry = true;
    }
    return retry;
  }

  /** 這一列自我停用過、而且清單上它現在的宣告跟停用當時一樣。 */
  #stillSelfDisabled(id: string, row: TreeRowInput): boolean {
    const remembered = this.#selfDisabled.get(id);
    return (
      remembered !== undefined &&
      remembered.module === row.module &&
      isDeepStrictEqual(normalized(remembered.config), normalized(row.config))
    );
  }

  async #failureOf(root: Context, id: string): Promise<string> {
    try {
      const fiber = root.loader.resolve(id).fiber?.ctx.fiber;
      if (fiber === undefined) return '模組載不進來';
      const error = await fiber.await().then(
        () => undefined,
        (reason: unknown) => reason,
      );
      return error instanceof Error
        ? error.message
        : String(error ?? `fiber 狀態 ${String(fiber.state)}`);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  async #snapshot(root: Context, rows: readonly TreeRowInput[]): Promise<TreeSnapshot> {
    const entries = this.#provider.entries();
    const verdicts = new Map<string, RowVerdict>();
    for (const row of rows) verdicts.set(row.id, await this.#verdictOf(root, row, entries));
    this.#assignProjections(rows, verdicts, this.#projections.entries());
    return {
      verdict: (id) =>
        verdicts.get(id) ?? {
          kind: 'dropped',
          stage: 'apply',
          message: `樹上沒有 ${id} 這一列的結果（它不在這一次推給樹的清單裡）`,
        },
    };
  }

  /**
   * 把共用的投影單元分給列（#1421）：每個 key 只給**這一份清單上起來了的**第一個登記者。
   *
   * 提供者那一層引用計數共用：同 key 同 `stateVersion` 的兩列都起來，登記處只有一份。這條 thread 的登記處每個 key 只收
   * 一份（重複拒絕照舊），所以折進去的人只能有一個——取「登記順序上第一個、在這份清單上是 `active` 的列」，而不是提供者
   * 記的第一個：登記者在提供者那裡還在、在清單上卻掉了（設定與樹上對不上）時，單元不能跟著它一起丟掉，要換下一個。
   */
  #assignProjections(
    rows: readonly TreeRowInput[],
    verdicts: Map<string, RowVerdict>,
    entries: readonly ProjectionEntry[],
  ): void {
    const owned = new Map<string, ProjectionUnit[]>();
    const rowIdOf = new Map(rows.map((row) => [treeId(row.id), row.id]));
    for (const entry of entries) {
      // 登記順序上第一個、在這份清單上是 `active` 的登記者。
      const owner = entry.sources
        .map((source) => rowIdOf.get(source))
        .find((id) => id !== undefined && verdicts.get(id)?.kind === 'active');
      if (owner === undefined) continue;
      const units = owned.get(owner) ?? [];
      units.push(entry.unit);
      owned.set(owner, units);
    }
    for (const row of rows) {
      const verdict = verdicts.get(row.id);
      if (verdict?.kind !== 'active') continue;
      verdicts.set(row.id, { ...verdict, projections: owned.get(row.id) ?? [] });
    }
  }

  async #verdictOf(
    root: Context,
    row: TreeRowInput,
    entries: readonly ToolEntry[],
  ): Promise<RowVerdict> {
    const id = treeId(row.id);
    if (row.disabled) {
      // 關掉的列不再等契約：留著舊的錯，之後重新啟用時會把別的原因講成它。
      this.#contractErrors.delete(id);
      return { kind: 'off' };
    }
    let entry;
    try {
      entry = root.loader.resolve(id);
    } catch {
      this.#contractErrors.delete(id);
      return {
        kind: 'dropped',
        stage: 'apply',
        message:
          `樹上沒有 ${id} 這一列：Include 只讀出貨的 cordis.yml，` +
          '寫在 cordis.serve.yml 的函式插件、或出貨檔裡沒寫 id 的列上不了樹',
      };
    }
    // 兩支疊 patch 的演算法對不上時，不靜靜地各走各的。
    if (entry.options.disabled === true) {
      // 自我停用過、宣告沒變：不是掉了，是它自己停的（#1424）。判成 `off`，不進 `failed` 的記錄器。
      if (this.#stillSelfDisabled(id, row)) return { kind: 'off' };
      return {
        kind: 'dropped',
        stage: 'apply',
        message:
          '樹上這一列是停用的，清單疊出來卻是啟用的（插件自己停用了自己，或兩邊疊出來的不一致）',
      };
    }
    if (!isDeepStrictEqual(normalized(entry.options.config), normalized(row.config))) {
      return {
        kind: 'dropped',
        stage: 'apply',
        message: '樹上這一列的設定與清單疊出來的不一致（兩邊疊 patch 的結果對不上）',
      };
    }
    const fiber = entry.fiber?.ctx.fiber;
    if (fiber === undefined) {
      return { kind: 'dropped', stage: 'apply', message: '模組載不進來' };
    }
    if (fiber.state === FIBER_STATE.ACTIVE) {
      // 起來了：之前記的契約錯誤作廢（只有仍在等服務的列才用得到它）；自我停用的記憶也作廢。
      this.#contractErrors.delete(id);
      this.#selfDisabled.delete(id);
      return {
        kind: 'active',
        tools: entries.filter((item) => item.source === id).map((item) => item.tool),
        // 投影單元由 `#assignProjections` 在所有列的結果都有了之後再分：共用的 key 只能給一列。
        projections: [],
      };
    }
    if (fiber.state === FIBER_STATE.FAILED) {
      return { kind: 'dropped', stage: 'apply', message: await this.#failureOf(root, id) };
    }
    if (fiber.state === FIBER_STATE.PENDING) {
      const contract = this.#contractErrors.get(id);
      if (contract !== undefined) {
        return { kind: 'dropped', stage: 'requires', message: contract.message };
      }
      const missing = missingServices(fiber);
      return {
        kind: 'dropped',
        stage: 'requires',
        message: `等不到 ${missing.join('、') || '（不明）'}`,
      };
    }
    return {
      kind: 'dropped',
      stage: 'apply',
      message: `fiber 狀態停在 ${String(fiber.state)}`,
    };
  }

  /** 卸載整棵樹；還沒建或已卸載時什麼都不做。 */
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const pending = this.#context;
    this.#context = undefined;
    const root = await pending?.catch(() => undefined);
    await root?.fiber.dispose();
  }
}

/** {@link mountDetached} 的輸入。 */
export interface DetachedMount {
  /** 列 id。 */
  readonly id: string;
  /** 模組命名空間（`import()` 的結果）。 */
  readonly module: FunctionPluginModule;
  /** 那一列的設定（原始的）。 */
  readonly config: unknown;
}

/** {@link mountDetached} 取出的東西：這一列登記的工具與投影單元。 */
export interface DetachedContributions {
  readonly tools: readonly StructuredToolInterface[];
  readonly projections: readonly ProjectionUnit[];
}

/**
 * 不經產品的樹，把一顆函式插件單獨掛一次、取出它登記的工具與投影單元、立刻卸載。
 *
 * 給**沒有樹的呼叫端**用：手搭 `PluginEntry` 清單、直接 `createCliAgent` 的測試與基準任務，以及 `shippedPlugins()`。
 * 走的是跟產品同一條路（真的 Loader、真的 `tools` 提供者、真的 `ctx.effect`），差別只在樹是用完即丟的。
 * **產品路徑不走這裡**：`cli.ts`／`serve.ts` 把 {@link PluginTree} 交給 `loadDefaultPlugins`，工具從那棵長壽的樹來。
 *
 * 卸載之後拿出去的工具物件照樣能用——它們是閉包了設定值的純函式（決議 §3-2 第 6 條）。
 *
 * @throws {Error} 那一列沒有起來，訊息同樹上的判定。
 */
export async function mountDetached(mount: DetachedMount): Promise<DetachedContributions> {
  const provider = createToolsProvider();
  const projections = createProjectionsProvider();
  const root = new Context();
  const contractErrors = new Map<string, ContractError>();
  root.logger.exporter({
    export: (message: Message) => {
      if (message.type !== 'error') return;
      for (const arg of message.args) {
        if (arg instanceof ContractError) contractErrors.set(arg.consumer, arg);
      }
    },
  });
  try {
    await root.plugin(Loader);
    root.loader.resolver = resolveBareSpecifier;
    Object.assign(root.loader.builtins, {
      [TOOLS_ROW_ID]: provider.Provider,
      [PROJECTIONS_ROW_ID]: projections.Provider,
      plugin: mount.module,
    });
    const create = (options: EntryOptions) =>
      root.loader.create(options as Omit<EntryOptions, 'id'>);
    await create({ id: TOOLS_ROW_ID, name: `cordis:${TOOLS_ROW_ID}` });
    await create({ id: PROJECTIONS_ROW_ID, name: `cordis:${PROJECTIONS_ROW_ID}` });
    await create({
      id: mount.id,
      name: 'cordis:plugin',
      config: normalized(mount.config) as Record<string, unknown>,
    });
    await root.loader.await();
    const fiber = root.loader.resolve(mount.id).fiber?.ctx.fiber;
    if (fiber?.state === FIBER_STATE.ACTIVE) {
      return {
        tools: provider
          .entries()
          .filter((entry) => entry.source === mount.id)
          .map((entry) => entry.tool),
        projections: projections
          .entries()
          .filter((entry) => entry.sources.includes(mount.id))
          .map((entry) => entry.unit),
      };
    }
    if (fiber?.state === FIBER_STATE.FAILED) {
      const error = await fiber.await().then(
        () => undefined,
        (reason: unknown) => reason,
      );
      throw error instanceof Error ? error : new Error(String(error));
    }
    const contract = contractErrors.get(mount.id);
    if (contract !== undefined) throw contract;
    const missing = fiber === undefined ? [] : missingServices(fiber);
    throw new Error(
      `${mount.id} 沒有起來（狀態 ${String(fiber?.state ?? '沒有 fiber')}）：等不到 ${missing.join('、') || '（不明）'}`,
    );
  } finally {
    await root.fiber.dispose();
  }
}

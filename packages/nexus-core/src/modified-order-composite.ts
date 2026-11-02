/**
 * 產品用的 `CompositeBackend`：`glob` 的結果照**修改時間（舊的在前）**交給模型（[#1605](https://github.com/DemianLi/nexus-agent/issues/1605) N0345），
 * 並把 {@link FILE_VERSION} 照路由轉給子 backend（[#2030](https://github.com/DemianLi/nexus-agent/issues/2030)），
 * 複製的兩半（{@link COPY_SOURCE}、{@link COPY_INTO}）也一樣（[#2289](https://github.com/DemianLi/nexus-agent/issues/2289)）。
 *
 * ## 為什麼要有它
 *
 * `ContainedFilesystemBackend.glob` 交出來的已經是 `rg --files --sort=modified` 的順序（dsh `glob.ts` 的契約），但產品的 backend 一定
 * 包在 `CompositeBackend` 裡（歷史、工具結果暫存、附件各一格路由，外加外掛的掛載點）。基座的 `CompositeBackend.glob` 在起點不落在任何路由底下時
 * （`/`、`/src` 這類）會合併 default 與各路由的結果，再 `results.sort((a, b) => a.path.localeCompare(b.path))`
 * （`deepagents@1.13.1`，`dist/langsmith-zm0ILQsV.js:1292`），把 rg 排好的順序照路徑重排一次。模型拿到的就是路徑序，超過 `globMaxResults` 時
 * `withListCap` 切的也是路徑序前段。
 *
 * ## 做什麼
 *
 * 合併之後用 `modified_at` 穩定排序一次：舊的在前，同一刻或沒有 `modified_at` 的保持路徑序。
 * 路由的結果與 default 的結果合在一起排，所以跨路由也是同一個時間軸。
 *
 * ## 路由出錯時整筆回錯誤（[#2158](https://github.com/DemianLi/nexus-agent/issues/2158)）
 *
 * 基座的 `glob` 合併時略過路由的錯誤（`if (result.error) continue`），`grep` 卻整筆回錯誤。沒有工作區時 default 是記憶體，
 * `SANDBOX_UNAVAILABLE` 就變成「No files found」。所以起點不落在路由底下時，合併這一段在這裡重寫，其餘照基座。`GlobResult` 沒有帶
 * 警告的欄位，回部分結果模型會當成完整的，因此已搜到的命中一起丟掉，模型要工作區的結果就縮小起點重搜。
 *
 * ## 與 dsh 的偏離（理由 1：基座表達不出來）
 *
 * dsh 的 `glob` 沒有這一層，它的 backend 不經 composite 重排。`CompositeBackend` 沒有排序選項，這裡退到：子類別，結果事後穩定排序。
 *
 * @module
 */

import { CompositeBackend } from 'deepagents';
import type { AnyBackendProtocol, GlobResult } from 'deepagents';
import { COPY_INTO, COPY_SOURCE, copyIntoOf, copySourceOf } from './backend-copy.js';
import type { CopyIntoResult, CopyRequest, CopySource } from './backend-copy.js';
import { FILE_VERSION, fileVersionOf } from './observation.js';
import type { FileVersionLookup } from './observation.js';

type GlobEntry = NonNullable<GlobResult['files']>[number];

/** 舊的在前；缺 `modified_at` 的當作同一刻（排序是穩定的，保持原本相對順序）。 */
function byModifiedAt(a: GlobEntry, b: GlobEntry): number {
  const left = a.modified_at;
  const right = b.modified_at;
  if (left === undefined || right === undefined || left === right) return 0;
  return left < right ? -1 : 1;
}

/** 基座轉接過的子 backend，一定有 `glob`。 */
interface GlobBackend {
  glob(pattern: string, path?: string): Promise<GlobResult>;
}

/** 基座的私有成員。基座改了名字，`glob` 會當場拋，`modified-order-composite.test.ts` 會紅。 */
interface CompositeInternals {
  readonly default: GlobBackend;
  readonly routes: Record<string, GlobBackend>;
  isPathWithinRoute(path: string, routePrefix: string): boolean;
  isRouteUnderPath(routePrefix: string, path: string): boolean;
}

/**
 * `glob` 照修改時間排、路由出錯就回錯誤，{@link FILE_VERSION} 與複製的兩半照路由轉的 `CompositeBackend`，見檔頭。其餘方法與基座逐位元組相同。
 *
 * `modified_at` 是 `Date.prototype.toISOString()` 的形狀（基座與 `ContainedFilesystemBackend` 都是），字串比較等於時間比較。
 */
export class ModifiedOrderCompositeBackend extends CompositeBackend {
  /**
   * 基座建構時把每個子 backend 換成轉接物件（`adaptBackendProtocol`），{@link FILE_VERSION} 這類基座不認得的方法會掉。
   * 這裡記「轉接物件 → 交進來的原物件」，路由仍走基座的 `getBackendAndKey`，只在最後換回原物件。
   * 讀的是基座私有的 `default`／`routes`。基座改了 `routes` 的名字，建構時就拋；改了 `default` 的名字，落在 default 的路徑換不回原物件：
   * 寫前比對退回 `readRaw` 算內容雜湊，但 `read_file` 照樣回報 stat token，兩邊對不上，讀過再改一律被擋成 `FS_STALE_VERSION`；
   * 複製回「不支援」（`contained-read-window.test.ts` 的驗收 2b 與 `backend-copy.test.ts` 都會紅）。
   */
  private readonly originals = new Map<unknown, AnyBackendProtocol>();

  constructor(defaultBackend: AnyBackendProtocol, routes: Record<string, AnyBackendProtocol>) {
    super(defaultBackend, routes);
    const adapted = this as unknown as {
      readonly default: unknown;
      readonly routes: Record<string, unknown>;
    };
    this.originals.set(adapted.default, defaultBackend);
    for (const [prefix, backend] of Object.entries(routes))
      this.originals.set(adapted.routes[prefix], backend);
  }

  override async glob(pattern: string, path = '/'): Promise<GlobResult> {
    const internals = this as unknown as CompositeInternals;
    const prefixes = Object.keys(internals.routes);
    const result = prefixes.some((prefix) => internals.isPathWithinRoute(path, prefix))
      ? await super.glob(pattern, path)
      : await this.globAcrossRoutes(internals, pattern, path);
    if (result.error !== undefined || result.files === undefined) return result;
    return { ...result, files: [...result.files].sort(byModifiedAt) };
  }

  /** 基座 `glob` 的合併段，只差路由的錯誤往外傳，見檔頭。 */
  private async globAcrossRoutes(
    internals: CompositeInternals,
    pattern: string,
    path: string,
  ): Promise<GlobResult> {
    const fromDefault = await internals.default.glob(pattern, path);
    if (fromDefault.error !== undefined) return fromDefault;
    const files: GlobEntry[] = [...(fromDefault.files ?? [])];
    let truncated = fromDefault.truncated === true;
    for (const [prefix, route] of Object.entries(internals.routes)) {
      if (!internals.isRouteUnderPath(prefix, path)) continue;
      const fromRoute = await route.glob(pattern, '/');
      if (fromRoute.error !== undefined) return fromRoute;
      for (const file of fromRoute.files ?? []) {
        files.push({ ...file, path: prefix.slice(0, -1) + file.path });
      }
      truncated = truncated || fromRoute.truncated === true;
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    return { files, truncated };
  }

  /**
   * stat 版本照路由分派（[#2030](https://github.com/DemianLi/nexus-agent/issues/2030)）：前綴剝法跟 `readRaw` 同一支 `getBackendAndKey`，
   * 子 backend 沒有這一格就回 `undefined`，observation 退回整份 `readRaw`。子 backend 也是這個類別時一層層照轉；基座的 `CompositeBackend`
   * 沒有這一格，接在它底下的都退回 `readRaw`。
   *
   * @param path - 這一層座標系的路徑（最外層是模型給的原路徑）。
   */
  async [FILE_VERSION](path: string): Promise<FileVersionLookup> {
    const [backend, key] = this.route(path);
    return fileVersionOf(this.originals.get(backend), key);
  }

  /**
   * 複製的來源那一半照路由分派，前綴剝法同 {@link FILE_VERSION}。子 backend 沒有這一半就回固定錯誤（`copySourceOf`）。
   *
   * @param path - 這一層座標系的來源路徑。
   * @param request - 模型給的原路徑，原樣往下傳。
   */
  async [COPY_SOURCE](
    path: string,
    request: CopyRequest,
  ): Promise<CopySource | { readonly error: string }> {
    const [backend, key] = this.route(path);
    return copySourceOf(this.originals.get(backend), key, request);
  }

  /**
   * 複製的目的地那一半照路由分派。子 backend 回的路徑是它自己座標系的，補回路由前綴再往上交，其餘欄位原樣帶出。
   * 落在那一格的根（`/`）時回不帶結尾斜線的前綴：模型給 `/plugin` 或 `/plugin/` 都回 `/plugin`。
   *
   * @param path - 這一層座標系的目的地路徑。
   * @param source - 開好的來源，可能來自另一個子 backend。
   * @param request - 模型給的原路徑，原樣往下傳。
   */
  async [COPY_INTO](
    path: string,
    source: CopySource,
    request: CopyRequest,
  ): Promise<CopyIntoResult> {
    const [backend, key] = this.route(path);
    const result = await copyIntoOf(this.originals.get(backend), key, source, request);
    if ('error' in result) return result;
    const prefix = Object.entries((this as unknown as CompositeInternals).routes).find(
      ([, route]) => route === backend,
    )?.[0];
    if (prefix === undefined) return result;
    const root = prefix.slice(0, -1);
    return { ...result, path: result.path === '/' ? root : root + result.path };
  }

  /** 基座的 `getBackendAndKey`：回轉接物件與剝過前綴的路徑。 */
  private route(path: string): [unknown, string] {
    return (
      this as unknown as { getBackendAndKey(key: string): [unknown, string] }
    ).getBackendAndKey(path);
  }
}

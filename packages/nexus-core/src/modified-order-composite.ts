/**
 * 把 `glob` 的結果照**修改時間（舊的在前）**交給模型的 `CompositeBackend`（[#1605](https://github.com/DemianLi/nexus-agent/issues/1605) N0345）。
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
 * 叫基座的 `glob`（路由分派與合併照舊），結果再用 `modified_at` 穩定排序一次：舊的在前，同一刻或沒有 `modified_at` 的保持基座給的相對順序（路徑序）。
 * 路由的結果與 default 的結果合在一起排，所以跨路由也是同一個時間軸。
 *
 * ## 與 dsh 的偏離（理由 1：基座表達不出來）
 *
 * dsh 的 `glob` 沒有這一層，它的 backend 不經 composite 重排。`CompositeBackend` 沒有排序選項，這裡退到：子類別，結果事後穩定排序。
 *
 * @module
 */

import { CompositeBackend } from 'deepagents';
import type { GlobResult } from 'deepagents';

type GlobEntry = NonNullable<GlobResult['files']>[number];

/** 舊的在前；缺 `modified_at` 的當作同一刻（排序是穩定的，保持原本相對順序）。 */
function byModifiedAt(a: GlobEntry, b: GlobEntry): number {
  const left = a.modified_at;
  const right = b.modified_at;
  if (left === undefined || right === undefined || left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * 結果照修改時間排的 `CompositeBackend`，見檔頭。其餘方法與基座逐位元組相同。
 *
 * `modified_at` 是 `Date.prototype.toISOString()` 的形狀（基座與 `ContainedFilesystemBackend` 都是），字串比較等於時間比較。
 */
export class ModifiedOrderCompositeBackend extends CompositeBackend {
  override async glob(pattern: string, path = '/'): Promise<GlobResult> {
    const result = await super.glob(pattern, path);
    if (result.error !== undefined || result.files === undefined) return result;
    return { ...result, files: [...result.files].sort(byModifiedAt) };
  }
}

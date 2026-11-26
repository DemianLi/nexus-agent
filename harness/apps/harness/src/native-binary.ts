import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * 從 `from` 往上找產物裡的原生執行檔 `relativePath`（例如 `native/nexus-supervisor`）；找不到回 `undefined`。
 *
 * 發版包裡沒有 `pnpm-workspace.yaml`，一路往上找到檔案系統根。原始碼樹裡執行檔放在 `harness/native/`，找的範圍到 repo 根再往上一層
 * 為止：repo 根與它的上一層（本地 git 在外層時會放在那裡）的 `relativePath` 都是搬到 `harness/` 之前的舊位置，
 * 不拿來用，存在就拋錯講要搬去哪裡，免得既有的 checkout 悄悄跑著舊執行檔。
 */
export function findNativeBinary(from: string, relativePath: string): string | undefined {
  let repoRoot: string | undefined;
  for (let dir = dirname(from); ; dir = dirname(dir)) {
    const candidate = join(dir, relativePath);
    if (existsSync(candidate)) {
      if (repoRoot !== undefined || existsSync(join(dir, 'pnpm-workspace.yaml'))) {
        throw new Error(
          `${candidate} 是搬到 harness/ 之前的舊位置，已經不再使用：請把它搬到 ${join(repoRoot ?? dir, 'harness', relativePath)}。`,
        );
      }
      return candidate;
    }
    if (repoRoot !== undefined) return undefined;
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) repoRoot = dir;
    if (dirname(dir) === dir) return undefined;
  }
}

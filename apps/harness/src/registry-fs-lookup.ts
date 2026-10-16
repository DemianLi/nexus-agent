/**
 * **沒有樹的組裝**怎麼回答「這次呼叫該讀寫哪一個 fs」（[#1466](https://github.com/DemianLi/nexus-agent/issues/1466)）。
 *
 * 兩個呼叫者，同一支：`plugin-config.ts` 的 `bindDetached`（沒有樹的呼叫端單獨掛一次函式插件時給樹上 `fs` 那一列的查找）與
 * `submit-record.fixture.ts`（還在相容層組裝的測試用的舊外殼）。**只看這一次組裝自己的 registry**：同一個行程裡兩份無樹組裝
 * 各用各的 fs、互不相見。
 *
 * 與樹上的行程級查找（`thread-sessions.ts` 的 `fsForCall`）的差別只有一個：不必依 `thread_id` 挑。無樹的組裝一份 registry
 * 就是一個 backend（`createNexusAgent` 每次組裝各建一份），沒有「別的 thread 的 fs」可以挑錯。仍要算得出位址——與樹上同一個
 * `unknown-caller` 判準，所以兩條路對「這次呼叫不在圖裡」的回答一致。
 *
 * @module
 */

import { FS_SERVICE, toolCallSessionAddress } from '@nexus/core';
import type { FsService } from '@nexus/core';
import type { FsLookup } from '@nexus/fs';

/**
 * @param registry - 這一次組裝的 registry（只用 `services`）。
 * @returns 查找函式：**每次呼叫都讀** `fs` 服務，所以提供它的那一列排在前面或後面都一樣。
 */
export function registryFsLookup(registry: {
  readonly services: { get(name: string): unknown };
}): (config: unknown) => FsLookup {
  return (config) => {
    const fs = registry.services.get(FS_SERVICE);
    if (typeof fs !== 'object' || fs === null) return { kind: 'not-attached' };
    const address = toolCallSessionAddress(config);
    if (address === undefined) return { kind: 'unknown-caller' };
    return { kind: 'ok', fs: fs as FsService, address };
  };
}

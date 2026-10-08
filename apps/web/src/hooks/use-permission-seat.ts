import type { PermissionCatalog, WireClient, WireProjection } from '@nexus/wire';
import { PERMISSIONS_PROJECTION_KEY } from '@nexus/wire';
import { useEffect, useState } from 'react';

import { parsePermissionView } from '@/lib/permission-presets';

export interface PermissionSeat {
  readonly catalog: PermissionCatalog;
  /** 現在的有效值：目錄裡的一個 `value`，或 `custom`。 */
  readonly currentValue: string;
}

export { PERMISSIONS_PROJECTION_KEY };

/**
 * 權限座的資料（[#437](https://github.com/DemianLi/nexus-agent/issues/437)）。回 `null` 就是這一檔沒有權限座：
 * 還在讀、目錄回 `rejected`（含還沒實作的 `not_supported`）、讀的時候拋錯，**或投影沒有送來**（契約：投影缺席＝這個組裝
 * 沒有權限組合）——一律不顯示。
 *
 * 目錄在這條 thread 打開時讀一次（換 thread 整個畫面重掛）；目前是哪一組只看伺服器推的投影，**切換後不在本地先改**：
 * 送出 `/permission` 到伺服器改完推新值之間，座位寫的還是舊的，不會騙人。
 */
export function usePermissionSeat(
  client: WireClient,
  threadId: string,
  projection: WireProjection | undefined,
): PermissionSeat | null {
  const [catalog, setCatalog] = useState<PermissionCatalog | null>(null);

  useEffect(() => {
    let live = true;
    client.permissionCatalog(threadId).then(
      (outcome) => {
        if (!live || outcome.kind !== 'ok' || !outcome.result.ok) return;
        setCatalog(outcome.result.value.catalog);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [client, threadId]);

  const currentValue = parsePermissionView(projection);
  if (catalog === null || currentValue === undefined) return null;
  return { catalog, currentValue };
}

import type { ModelCatalog, ModelSelection, WireClient, WireProjection } from '@nexus/wire';
import { useCallback, useEffect, useRef, useState } from 'react';

import { effectiveSelection, parseSelectionProjection } from '@/lib/model-selection';

/** 模型選擇投影的 key（伺服器推的那份，多分頁同步用）。 */
export const MODEL_SELECTION_PROJECTION = 'model-selection';

export interface ModelSeat {
  readonly catalog: ModelCatalog;
  /** 現在生效（下一步會用）的選擇。 */
  readonly selection: ModelSelection;
  /** 選一個；成功回 `undefined`，失敗回一句講得出來的原因，選擇不變。 */
  readonly select: (next: ModelSelection) => Promise<string | undefined>;
}

/**
 * 模型座的資料（[#723](https://github.com/DemianLi/nexus-agent/issues/723)）。回 `null` 就是這一檔沒有模型座——
 * 還在讀、伺服器回 `rejected`（含還沒實作的 `not_supported`）、或讀的時候拋錯，**一律不顯示**：座位與 `/model`
 * 一起沒有，不留一顆按了沒用的鈕。
 *
 * 型錄在這條 thread 打開時讀一次（換 thread 整個畫面重掛，所以不用管換身分）。選擇的來源與先後見
 * `lib/model-selection.ts` 的 `effectiveSelection`：伺服器的投影一推來就以它為準；這個分頁自己剛選的，在投影更新前先頂著。
 */
export function useModelSeat(
  client: WireClient,
  threadId: string,
  projection: WireProjection | undefined,
): ModelSeat | null {
  const [read, setRead] = useState<{
    readonly catalog: ModelCatalog;
    readonly next: ModelSelection | null;
    readonly lastUsed: ModelSelection | null;
  } | null>(null);
  // 剛選的，連同選的當下看到的投影：投影之後又變了，就是伺服器講了更新的話。
  const [local, setLocal] = useState<{
    readonly selection: ModelSelection;
    readonly seen: WireProjection | undefined;
  } | null>(null);
  const ticket = useRef(0);

  useEffect(() => {
    let live = true;
    client.modelCatalog(threadId).then(
      (outcome) => {
        if (!live || outcome.kind !== 'ok' || !outcome.result.ok) return;
        const { catalog, selection } = outcome.result.value;
        setRead({ catalog, next: selection.next, lastUsed: selection.lastUsed });
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [client, threadId]);

  const seen = projection;
  const select = useCallback(
    async (next: ModelSelection): Promise<string | undefined> => {
      ticket.current += 1;
      const mine = ticket.current;
      let outcome;
      try {
        outcome = await client.selectModel(threadId, next);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      if (outcome.kind !== 'ok') return outcome.message;
      if (!outcome.result.ok) return '這顆模型現在選不了（型錄上沒有它，或它不支援那個推理強度）。';
      if (mine === ticket.current) {
        setLocal({ selection: outcome.result.value.selected, seen });
      }
      return undefined;
    },
    [client, threadId, seen],
  );

  if (read === null) return null;
  const pushed = parseSelectionProjection(projection);
  const fromLocal = local !== null && local.seen === projection ? local.selection : undefined;
  return {
    catalog: read.catalog,
    selection: effectiveSelection(read.catalog, [
      fromLocal,
      pushed?.next ?? pushed?.lastUsed,
      read.next,
      read.lastUsed,
    ]),
    select,
  };
}

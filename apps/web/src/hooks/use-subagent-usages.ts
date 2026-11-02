import { useCallback, useEffect, useMemo, useState } from 'react';

import type { SubagentUsage, SubagentUsageLoader } from '@/lib/subagent-usage';

export interface SubagentUsageSlot {
  /** 正在讀（含重讀）。重讀時 {@link usage} 還是上一次讀到的，不先清成空白。 */
  readonly loading: boolean;
  readonly usage?: SubagentUsage;
  /** 最近一次讀失敗的原因；有的話那一列講原因，不畫數字。 */
  readonly error?: string;
}

/**
 * 讀背景子代理各自的總帳（[#1032](https://github.com/DemianLi/nexus-agent/issues/1032)）。
 *
 * **只在看得見時讀**，而且只在三件事發生時讀：分頁變成看得見、子代理的名單變了、人按了重讀（`reload`）。串流的逐字片段不會
 * 觸發它——名單靠的是 `runIds` 的內容，不是身分。不輪詢：子代理還在跑時數字會變舊，畫面上寫明「讀取當下」，由人按重讀。
 * 後到的舊回應不覆蓋新的（`live` 旗標，同 `useSubagentHistory`）。
 */
export function useSubagentUsages(
  load: SubagentUsageLoader | undefined,
  runIds: readonly string[],
  visible: boolean,
): { readonly slots: ReadonlyMap<string, SubagentUsageSlot>; readonly reload: () => void } {
  const key = runIds.join('\n');
  const ids = useMemo(() => (key === '' ? [] : key.split('\n')), [key]);
  const [slots, setSlots] = useState<ReadonlyMap<string, SubagentUsageSlot>>(new Map());
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!visible || load === undefined || ids.length === 0) return;
    let live = true;
    setSlots((previous) => {
      const next = new Map<string, SubagentUsageSlot>();
      for (const id of ids) {
        const old = previous.get(id);
        next.set(id, { loading: true, ...(old?.usage === undefined ? {} : { usage: old.usage }) });
      }
      return next;
    });
    for (const id of ids) {
      void load(id).then((outcome) => {
        if (!live) return;
        setSlots((previous) =>
          new Map(previous).set(
            id,
            outcome.ok
              ? { loading: false, usage: outcome.usage }
              : { loading: false, error: outcome.message },
          ),
        );
      });
    }
    return () => {
      live = false;
    };
  }, [visible, load, ids, tick]);
  const reload = useCallback(() => setTick((value) => value + 1), []);
  return { slots, reload };
}

/**
 * 一輪改動摘要的讀取與快取（[#443](https://github.com/DemianLi/nexus-agent/issues/443)）。
 *
 * 照 dsh `ChangesSummaryStore`（`packages/client/ui-deliverables/src/client/changes-summary.ts`，`ddefc45`）：
 * **每個 `seq` 只讀一次**，結果留到這條 thread 的畫面卸掉為止。拿不到就是 `'missing'`，不重試：
 *
 * - **404 是正常路徑**：摘要只活到會話結束，serve 重開後從歷史重播出來的那一格一定拿到 404，卡片就不畫。
 * - 其他失敗（400、500、斷線、形狀不對）一樣當成沒有——dsh 的 `failed: 'missing'`、`retryable: () => false`。
 *
 * 網址與回應的形狀檢查都用 `@nexus/wire` 的 `changesSummaryUrl`、`isChangesSummary`（[#684](https://github.com/DemianLi/nexus-agent/issues/684)），
 * 跟 harness 同一個來源；會話認證靠同源的 cookie（#424）。
 *
 * @module
 */

import type { WorkspaceChangesSummary } from '@nexus/wire';
import { changesSummaryUrl, isChangesSummary } from '@nexus/wire';

/** 讀到的摘要，`'missing'`＝這台 server 不再服務它（或讀壞了），`'loading'`＝還在讀。 */
export type ChangesSummaryState = WorkspaceChangesSummary | 'missing' | 'loading';

export interface ChangesSummaryStore {
  /** 目前的狀態；還沒讀過是 `undefined`。 */
  read(seq: number): ChangesSummaryState | undefined;
  /** 讀一次；讀過或正在讀就不再發。 */
  load(seq: number): void;
  subscribe(listener: () => void): () => void;
}

export function createChangesSummaryStore({
  threadId,
  baseUrl,
  fetch: doFetch = globalThis.fetch.bind(globalThis),
}: {
  readonly threadId: string;
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
}): ChangesSummaryStore {
  const states = new Map<number, ChangesSummaryState>();
  const listeners = new Set<() => void>();
  const publish = (seq: number, state: ChangesSummaryState) => {
    states.set(seq, state);
    for (const listener of listeners) listener();
  };
  const base = baseUrl.replace(/\/+$/, '');

  const request = async (seq: number): Promise<ChangesSummaryState> => {
    try {
      const response = await doFetch(`${base}${changesSummaryUrl(threadId, seq)}`, {
        method: 'GET',
        // 同 wire client 的 `listThreads`：沒有它就是不發 preflight 的跨來源 simple request（見 `THREADS_PATH`）。
        headers: { 'content-type': 'application/json' },
      });
      if (!response.ok) return 'missing';
      const body: unknown = await response.json();
      return isChangesSummary(body) ? body : 'missing';
    } catch {
      return 'missing';
    }
  };

  return {
    read: (seq) => states.get(seq),
    load(seq) {
      if (states.has(seq)) return;
      publish(seq, 'loading');
      void request(seq).then((state) => publish(seq, state));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

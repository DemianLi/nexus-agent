/**
 * 一輪改動摘要的讀取與快取（[#443](https://github.com/DemianLi/nexus-agent/issues/443)）。
 *
 * 照 dsh `ChangesSummaryStore`（`packages/client/ui-deliverables/src/client/changes-summary.ts`，`ddefc45`）：
 * **每個 `seq` 只讀一次**，結果留到這條 thread 的畫面卸掉為止。拿不到就是 `'missing'`，不重試：
 *
 * - **404 是正常路徑**：摘要只活到會話結束，serve 重開後從歷史重播出來的那一格一定拿到 404，卡片就不畫。
 * - 其他失敗（400、500、斷線、形狀不對）一樣當成沒有——dsh 的 `failed: 'missing'`、`retryable: () => false`。
 *
 * 讀的是 `@nexus/wire` 的 `changesSummaryPath`，跟 wire client 同一個來源；會話認證靠同源的 cookie（#424）。
 *
 * @module
 */

import type { WorkspaceChangedFile, WorkspaceChangesSummary } from '@nexus/wire';
import { changesSummaryPath } from '@nexus/wire';

/** 讀到的摘要，`'missing'`＝這台 server 不再服務它（或讀壞了），`'loading'`＝還在讀。 */
export type ChangesSummaryState = WorkspaceChangesSummary | 'missing' | 'loading';

export interface ChangesSummaryStore {
  /** 目前的狀態；還沒讀過是 `undefined`。 */
  read(seq: number): ChangesSummaryState | undefined;
  /** 讀一次；讀過或正在讀就不再發。 */
  load(seq: number): void;
  subscribe(listener: () => void): () => void;
}

function isChangedFile(value: unknown): value is WorkspaceChangedFile {
  const file = value as Partial<WorkspaceChangedFile> | null;
  return (
    typeof file?.path === 'string' &&
    typeof file.display === 'string' &&
    typeof file.added === 'number' &&
    typeof file.deleted === 'number'
  );
}

/** 形狀檢查，同 dsh `isChangesSummary`：對不上就當成沒有，不讓半截的東西進畫面。 */
export function isChangesSummary(value: unknown): value is WorkspaceChangesSummary {
  const summary = value as Partial<WorkspaceChangesSummary> | null;
  return (
    Array.isArray(summary?.files) &&
    summary.files.every(isChangedFile) &&
    typeof summary.total === 'number' &&
    typeof summary.added === 'number' &&
    typeof summary.deleted === 'number'
  );
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
      const response = await doFetch(`${base}${changesSummaryPath(threadId)}?seq=${seq}`, {
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

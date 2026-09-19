/**
 * 一個改動檔案的比較的讀取與快取（[#443](https://github.com/DemianLi/nexus-agent/issues/443) web 第二刀）。
 *
 * 照 dsh `ChangesDiffStore`（`packages/client/ui-deliverables/src/client/changes-diff.ts`，`ddefc45`），**跟摘要的讀法不一樣**：
 *
 * - **404 是 `'missing'`，不再讀**：這台 server 不再服務這份比較（serve 重開了，或沒有那個 index）。
 * - **其他失敗是 `'error'`，可以重讀**：非 2xx、斷線、形狀不對。畫面給一顆「重試」，同 dsh `retryable: state => state === 'error'`。
 * - 讀到了就留著，每個 `(seq, index)` 只讀一次。
 *
 * 摘要那邊（`changes-summary.ts`）任何失敗都不重試，因為卡片拿不到就不畫、沒有地方放重試；比較是使用者點開才讀，
 * 讀壞了有地方講。
 *
 * @module
 */

import type { WorkspaceDiffHunk, WorkspaceFileDiff } from '@nexus/wire';
import { changesDiffPath } from '@nexus/wire';

import type { ChangesSummaryStore } from '@/lib/changes-summary';
import { createChangesSummaryStore } from '@/lib/changes-summary';

/** 讀到的比較；`'missing'`＝server 不再服務它，`'error'`＝讀壞了、可以重讀，`'loading'`＝還在讀。 */
export type ChangesDiffState = WorkspaceFileDiff | 'missing' | 'error' | 'loading';

export interface ChangesDiffStore {
  /** 目前的狀態；還沒讀過是 `undefined`。 */
  read(seq: number, index: number): ChangesDiffState | undefined;
  /** 讀一次：還沒讀過、或上次讀壞了才發；讀到了、正在讀、或是 404 就不發。 */
  load(seq: number, index: number): void;
  subscribe(listener: () => void): () => void;
}

/** 一條 thread 的改動讀取：卡片讀摘要，審查頁讀比較。 */
export interface ChangesStores {
  readonly summary: ChangesSummaryStore;
  readonly diff: ChangesDiffStore;
}

function isHunk(value: unknown): value is WorkspaceDiffHunk {
  const hunk = value as Partial<WorkspaceDiffHunk> | null;
  return (
    [hunk?.oldStart, hunk?.oldLines, hunk?.newStart, hunk?.newLines].every(
      (field) => Number.isSafeInteger(field) && (field as number) >= 0,
    ) &&
    Array.isArray(hunk?.lines) &&
    hunk.lines.every((line) => typeof line === 'string' && /^[+ -]/.test(line))
  );
}

/** 形狀檢查，同 dsh `isChangesDiff`：對不上就當成讀壞了。 */
export function isFileDiff(value: unknown): value is WorkspaceFileDiff {
  const diff = value as Record<string, unknown> | null;
  if (typeof diff?.path !== 'string' || diff.path === '') return false;
  if (typeof diff.display !== 'string' || diff.display === '') return false;
  if (diff.kind === 'binary' || diff.kind === 'oversized') return true;
  return (
    diff.kind === 'text' &&
    typeof diff.before === 'boolean' &&
    typeof diff.after === 'boolean' &&
    typeof diff.coarse === 'boolean' &&
    Array.isArray(diff.hunks) &&
    diff.hunks.every(isHunk)
  );
}

export function createChangesDiffStore({
  threadId,
  baseUrl,
  fetch: doFetch = globalThis.fetch.bind(globalThis),
}: {
  readonly threadId: string;
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
}): ChangesDiffStore {
  const states = new Map<string, ChangesDiffState>();
  const listeners = new Set<() => void>();
  const key = (seq: number, index: number) => `${seq}:${index}`;
  const publish = (at: string, state: ChangesDiffState) => {
    states.set(at, state);
    for (const listener of listeners) listener();
  };
  const base = baseUrl.replace(/\/+$/, '');

  const request = async (seq: number, index: number): Promise<ChangesDiffState> => {
    try {
      const response = await doFetch(
        `${base}${changesDiffPath(threadId)}?seq=${seq}&index=${index}`,
        // content-type 的理由同 `changes-summary.ts`。
        { method: 'GET', headers: { 'content-type': 'application/json' } },
      );
      if (response.status === 404) return 'missing';
      if (!response.ok) return 'error';
      const body: unknown = await response.json();
      return isFileDiff(body) ? body : 'error';
    } catch {
      return 'error';
    }
  };

  return {
    read: (seq, index) => states.get(key(seq, index)),
    load(seq, index) {
      const at = key(seq, index);
      const state = states.get(at);
      if (state !== undefined && state !== 'error') return;
      publish(at, 'loading');
      void request(seq, index).then((next) => publish(at, next));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** 一條 thread 的兩個讀取，跟著 thread 走。 */
export function createChangesStores(options: {
  readonly threadId: string;
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
}): ChangesStores {
  return { summary: createChangesSummaryStore(options), diff: createChangesDiffStore(options) };
}

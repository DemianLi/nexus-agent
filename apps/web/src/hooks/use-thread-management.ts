import type { CommandOutcome, ThreadActivityKind, ThreadListResult, WireClient } from '@nexus/wire';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { ThreadDirectory } from '@/hooks/use-thread-directory';
import { explainThreadFailure, normalizeTitle, readSets } from '@/lib/thread-management';
import type { ThreadActionResult, ArchiveAnswer, ThreadManagement } from '@/lib/thread-management';

/** 這份列表之後、下一份列表之前，動作回應裡的整份集合與 server 受理的標題。 */
interface Overlay {
  readonly base: ThreadListResult | undefined;
  readonly pinned?: readonly string[];
  readonly archived?: readonly string[];
  readonly titles: ReadonlyMap<string, string>;
}

const NO_TITLES: ReadonlyMap<string, string> = new Map();

type Outcome<V> =
  | { readonly value: V }
  | {
      readonly message: string;
      /** 業務失敗的原始內容（線路層失敗沒有）；封存要從這裡讀 `thread_active` 的 `activity`。 */
      readonly error?: { readonly code: string; readonly activity?: readonly ThreadActivityKind[] };
    };

/**
 * 一支動作的結果換成「值或一句人話」。`rejected` 是這條線收不了（含沒實作的 `not_supported`），業務失敗在 `result` 裡。
 */
async function settle<V>(
  call: () => Promise<
    CommandOutcome<
      | { readonly ok: true; readonly value: V }
      | {
          readonly ok: false;
          readonly error: {
            readonly code: string;
            readonly message?: string;
            readonly activity?: readonly ThreadActivityKind[];
          };
        }
    >
  >,
): Promise<Outcome<V>> {
  let outcome;
  try {
    outcome = await call();
  } catch (error) {
    return { message: error instanceof Error ? error.message : String(error) };
  }
  if (outcome.kind !== 'ok') {
    return {
      message: outcome.code === 'not_supported' ? '這個伺服器還不支援這個動作。' : outcome.message,
    };
  }
  return outcome.result.ok
    ? { value: outcome.result.value }
    : { message: explainThreadFailure(outcome.result.error), error: outcome.result.error };
}

/**
 * 側欄的釘選、封存、改名（[#633](https://github.com/DemianLi/nexus-agent/issues/633)）。回 `undefined` 就是這一檔沒有這個功能：
 * 列表沒帶釘選與封存兩個集合（還沒實作的 server）、還在讀、或讀失敗，側欄什麼都不多畫。規則見 `lib/thread-management.ts`。
 *
 * **集合一律以 server 為準**：畫面上的集合是最近一份列表帶的；動作成功就拿回應裡的整份取代（蓋在列表上，直到下一份列表
 * 來為止），**本機不推**。封存之後 server 可能順手取消釘選，回應只帶封存集合，所以封存與改名之後重抓一次列表。
 * 同一個集合上連續的動作，回得慢的舊回應不蓋掉新的。
 */
export function useThreadManagement(
  client: WireClient,
  directory: ThreadDirectory,
): ThreadManagement | undefined {
  const { listing, refresh } = directory;
  const base = listing.kind === 'ok' ? listing.result : undefined;
  const sets = readSets(base);
  const baseRef = useRef(base);
  useLayoutEffect(() => {
    baseRef.current = base;
  });
  const [overlay, setOverlay] = useState<Overlay>({ base: undefined, titles: NO_TITLES });
  // 新一份列表來了，蓋在上面的就作廢：列表是 server 剛講的話。
  const current = overlay.base === base ? overlay : undefined;
  const tickets = useRef({ pinned: 0, archived: 0 });

  const patch = useCallback((update: (previous: Overlay) => Overlay) => {
    setOverlay((previous) => {
      const at = baseRef.current;
      return update(previous.base === at ? previous : { base: at, titles: NO_TITLES });
    });
  }, []);

  const pinCall = useCallback(
    async (call: () => ReturnType<typeof client.threadPin>): ThreadActionResult => {
      tickets.current.pinned += 1;
      const mine = tickets.current.pinned;
      const result = await settle(call);
      if ('message' in result) return result.message;
      if (mine === tickets.current.pinned) {
        patch((previous) => ({ ...previous, pinned: result.value.pinnedThreadIds }));
      }
      return undefined;
    },
    [patch],
  );
  const archiveCall = useCallback(
    async (call: () => ReturnType<typeof client.threadArchive>): ArchiveAnswer => {
      tickets.current.archived += 1;
      const mine = tickets.current.archived;
      const result = await settle(call);
      if ('message' in result) {
        return result.error?.code === 'thread_active'
          ? { needsStop: result.error.activity ?? [] }
          : result.message;
      }
      if (mine === tickets.current.archived) {
        patch((previous) => ({ ...previous, archived: result.value.archivedThreadIds }));
      }
      return undefined;
    },
    [patch],
  );

  const onPin = useCallback(
    (threadId: string) => pinCall(() => client.threadPin(threadId)),
    [client, pinCall],
  );
  const onUnpin = useCallback(
    (threadId: string) => pinCall(() => client.threadUnpin(threadId)),
    [client, pinCall],
  );
  const onArchive = useCallback(
    async (threadId: string, options?: { readonly stopActivity?: boolean }) => {
      const failure = await archiveCall(() =>
        client.threadArchive(
          threadId,
          options?.stopActivity === true ? { stopActivity: true } : undefined,
        ),
      );
      // 回應只帶封存集合；封存順手取消釘選是 server 的規則，釘選集合重抓列表才拿得到。
      if (failure === undefined) refresh();
      return failure;
    },
    [client, archiveCall, refresh],
  );
  const onUnarchive = useCallback(
    async (threadId: string) => {
      const answer = await archiveCall(() => client.threadUnarchive(threadId));
      // 取消封存不會回 `thread_active`；型別上收窄掉。
      return typeof answer === 'object' ? undefined : answer;
    },
    [client, archiveCall],
  );
  const onRename = useCallback(
    async (threadId: string, raw: string) => {
      const title = normalizeTitle(raw);
      if (title === undefined) return '標題不能是空的。';
      const result = await settle(() => client.threadRename(threadId, title));
      if ('message' in result) return result.message;
      // 先用 server 受理的標題頂著，重抓的列表來了就換成列表上的。
      patch((previous) => ({
        ...previous,
        titles: new Map(previous.titles).set(threadId, result.value.title),
      }));
      refresh();
      return undefined;
    },
    [client, patch, refresh],
  );

  const pinned = current?.pinned ?? sets?.pinned;
  const archived = current?.archived ?? sets?.archived;
  const titles = current?.titles ?? NO_TITLES;
  const archivedIds = useMemo(() => new Set(archived), [archived]);

  return useMemo(
    () =>
      pinned === undefined || archived === undefined
        ? undefined
        : {
            pinnedIds: pinned,
            archivedIds,
            titles,
            onPin,
            onUnpin,
            onArchive,
            onUnarchive,
            onRename,
          },
    [pinned, archived, archivedIds, titles, onPin, onUnpin, onArchive, onUnarchive, onRename],
  );
}

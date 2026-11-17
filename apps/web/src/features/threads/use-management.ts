import type {
  CommandOutcome,
  DeletedThread,
  ThreadActivityKind,
  ThreadListResult,
  WireClient,
} from '@nexus/wire';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { ThreadDirectory } from '@/features/threads/use-directory';
import { refusalText } from '@/shared/connection/refusal-text';
import { explainThreadFailure, normalizeTitle, readSets } from '@/features/threads/management';
import type {
  ThreadActionResult,
  ArchiveAnswer,
  ThreadDeletion,
  ThreadManagement,
} from '@/features/threads/management';

/** 這份列表之後、下一份列表之前，動作回應裡的整份集合。 */
interface Overlay {
  readonly base: ThreadListResult | undefined;
  readonly pinned?: readonly string[];
  readonly archived?: readonly string[];
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
    // thread 數滿了（改名經 server 的 `threadFor`，冷會話也算）：message 是給管理者的原文，換成給使用者看的那一句（#1483）。
    // 歷史太深（#1753）、日誌超過額度（#2203）、被別處握著（#2214）、開在別的 home 或工作區（#2222）同理。
    return {
      message:
        refusalText(outcome.code, 'reading') ??
        (outcome.code === 'not_supported' ? '這個伺服器還不支援這個動作。' : outcome.message),
    };
  }
  return outcome.result.ok
    ? { value: outcome.result.value }
    : { message: explainThreadFailure(outcome.result.error), error: outcome.result.error };
}

/**
 * server 受理過的標題，按 id（`useThreadManagement` 的改名與分叉的改名共用一份，#1581）。放在 hook 外面，是因為列表沒帶
 * 兩個集合時整個會話管理是 `undefined`，分叉照樣要改名、照樣要頂著。
 */
export interface AcceptedTitles {
  readonly renamed: ReadonlyMap<string, string>;
  readonly accept: (threadId: string, title: string) => void;
}

export function useAcceptedTitles(): AcceptedTitles {
  const [renamed, setRenamed] = useState<ReadonlyMap<string, string>>(NO_TITLES);
  const accept = useCallback((threadId: string, title: string) => {
    setRenamed((previous) => new Map(previous).set(threadId, title));
  }, []);
  return useMemo(() => ({ renamed, accept }), [renamed, accept]);
}

/**
 * 改名一條 thread，回 server 受理的標題或一句人話。標題不正規化：呼叫端給的就是要送的（分叉的遞增名字由來源標題算出來）。
 */
export async function renameThread(
  client: WireClient,
  threadId: string,
  title: string,
): Promise<{ readonly title: string } | { readonly message: string }> {
  const result = await settle(() => client.threadRename(threadId, title));
  return 'message' in result ? { message: result.message } : { title: result.value.title };
}

/**
 * 從 `messageId` 那則回覆所在的那一輪分出一條新 thread（#1581），回子 thread 的 id 或一句人話：名額滿了換成
 * `THREAD_AT_CAPACITY_TEXT`、`fork_unavailable` 由 {@link explainThreadFailure} 講，其餘同這一族。
 */
export async function forkThread(
  client: WireClient,
  threadId: string,
  messageId: string,
): Promise<{ readonly threadId: string } | { readonly message: string }> {
  const result = await settle(() => client.threadFork(threadId, messageId));
  return 'message' in result ? { message: result.message } : { threadId: result.value.threadId };
}

/**
 * 已刪除清單（#2958）：`undefined` 是還沒讀到，`null` 是被拒（沒接已刪除存放區）或讀不到，兩種都當成沒有刪除這件事。
 * 掛上時、列表每來一份新的（`listed` 換了）、以及刪除與復原之後讀：別的頁籤刪掉或復原的，跟著列表一起追上；讀不到的那一次也在下一份列表時再試。
 */
function useDeletedThreads(client: WireClient, listed: unknown) {
  const [deleted, setDeleted] = useState<readonly DeletedThread[] | null | undefined>(undefined);
  const ticket = useRef(0);
  const reload = useCallback(() => {
    ticket.current += 1;
    const mine = ticket.current;
    void (async () => {
      let items: readonly DeletedThread[] | null;
      try {
        const outcome = await client.deletedThreads();
        items = outcome.kind === 'ok' ? outcome.result.items : null;
      } catch {
        items = null;
      }
      if (mine === ticket.current) setDeleted(items);
    })();
  }, [client]);
  useEffect(() => {
    reload();
  }, [reload, listed]);
  return { deleted, reload };
}

/**
 * 側欄的釘選、封存、改名（[#633](https://github.com/DemianLi/nexus-agent/issues/633)）與刪除（[#2958](https://github.com/DemianLi/nexus-agent/issues/2958)）。回 `undefined` 就是這一檔沒有這個功能：
 * 列表沒帶釘選與封存兩個集合（還沒實作的 server）、還在讀、或讀失敗，側欄什麼都不多畫。刪除另看已刪除清單（`deletion`）。規則見 `features/threads/management.ts`。
 *
 * **集合一律以 server 為準**：畫面上的集合是最近一份列表帶的；動作成功就拿回應裡的整份取代（蓋在列表上，直到下一份列表
 * 來為止），**本機不推**。封存之後 server 可能順手取消釘選，回應只帶封存集合，所以封存、刪除、復原成功之後重抓一次列表（改名不重抓，見 `onRename`）。
 * 同一個集合上連續的動作，回得慢的舊回應不蓋掉新的。
 */
export function useThreadManagement(
  client: WireClient,
  directory: ThreadDirectory,
  accepted: AcceptedTitles,
): ThreadManagement | undefined {
  const { listing, refresh } = directory;
  const base = listing.kind === 'ok' ? listing.result : undefined;
  const sets = readSets(base);
  const baseRef = useRef(base);
  useLayoutEffect(() => {
    baseRef.current = base;
  });
  const [overlay, setOverlay] = useState<Overlay>({ base: undefined });
  // 新一份列表來了，蓋在上面的就作廢：列表是 server 剛講的話。
  const current = overlay.base === base ? overlay : undefined;
  const tickets = useRef({ pinned: 0, archived: 0 });
  // server 受理過的標題，按 id；跨列表留著（見 `onRename`）。
  const { renamed, accept } = accepted;

  const patch = useCallback((update: (previous: Overlay) => Overlay) => {
    setOverlay((previous) => {
      const at = baseRef.current;
      return update(previous.base === at ? previous : { base: at });
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
      const result = await renameThread(client, threadId, title);
      if ('message' in result) return result.message;
      // 用 server 受理的標題頂著，**不重抓列表**：`GET /threads` 讀的是落盤的那份，落盤是非同步的，這時候重抓回來的多半
      // 還是舊標題，會把剛改好的蓋回去。頂著的標題留到列表自己追上（列上的標題等於它）為止；目前這條的標題另走即時推送。
      accept(threadId, result.title);
      return undefined;
    },
    [client, accept],
  );

  const { deleted, reload: reloadDeleted } = useDeletedThreads(client, base);
  const onDelete = useCallback(
    async (threadId: string) => {
      const result = await settle(() => client.threadDelete(threadId));
      if ('message' in result) return result.message;
      refresh();
      reloadDeleted();
      return undefined;
    },
    [client, refresh, reloadDeleted],
  );
  const onRestore = useCallback(
    async (threadId: string) => {
      const result = await settle(() => client.threadRestore(threadId));
      // 已經復原過（`thread_not_deleted`）：server 的清單上已經沒有它；過期：server 照樣列，重讀後重畫時由側欄用 `expiresAt` 濾掉。兩種都重讀。
      reloadDeleted();
      if ('message' in result) return result.message;
      refresh();
      return undefined;
    },
    [client, refresh, reloadDeleted],
  );
  const deletion = useMemo<ThreadDeletion | undefined>(
    () =>
      deleted === undefined || deleted === null ? undefined : { deleted, onDelete, onRestore },
    [deleted, onDelete, onRestore],
  );

  const pinned = current?.pinned ?? sets?.pinned;
  const archived = current?.archived ?? sets?.archived;
  // 列表已經追上的（列上的標題等於我們頂著的）不再蓋；列表上沒有那一列的留著。
  const titles = useMemo(() => {
    if (renamed.size === 0) return NO_TITLES;
    const listed = new Map((base?.items ?? []).map((item) => [item.threadId, item.title]));
    const pending = [...renamed].filter(([id, title]) => listed.get(id) !== title);
    return pending.length === 0 ? NO_TITLES : new Map(pending);
  }, [renamed, base]);
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
            ...(deletion === undefined ? {} : { deletion }),
          },
    [
      pinned,
      archived,
      archivedIds,
      titles,
      onPin,
      onUnpin,
      onArchive,
      onUnarchive,
      onRename,
      deletion,
    ],
  );
}

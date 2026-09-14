import type { ThreadListResult, ThreadSummary, WireClient } from '@nexus/wire';
import { useEffect, useState } from 'react';

/**
 * 以前的會話——[#302](https://github.com/DemianLi/nexus-agent/issues/302)。照 dsh 的 `session/list`：
 * 由新到舊、正在跑的有標記，每一列是第一則人打的字的開頭。
 *
 * **掛上來才讀、每次打開都重讀**：清單會變（別的分頁剛講過話、剛開了一條），而讀一次是冷的——server 那側
 * 一條 agent 都不為它建。
 *
 * **沒有標題的兩種原因分開講**（`ThreadSummary.title` 的說明）：還沒有任何一輪，與只有目標排的輪次。
 */

/** 還沒有任何一輪。 */
export const BLANK_THREAD_LABEL = '（空白：還沒有任何一輪）';
/** 有輪次，但沒有人打過字——全是目標排的。 */
export const UNTITLED_THREAD_LABEL = '（沒有人打過字：只有目標排的輪次）';

type Listing =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ok'; readonly result: ThreadListResult }
  | { readonly kind: 'failed'; readonly message: string };

function labelOf(item: ThreadSummary): string {
  if (item.title !== undefined) return item.title;
  return item.blank ? BLANK_THREAD_LABEL : UNTITLED_THREAD_LABEL;
}

function formatTime(updatedAt: number): string {
  return new Date(updatedAt).toLocaleString('zh-TW', { dateStyle: 'short', timeStyle: 'short' });
}

export function ThreadList({
  client,
  currentThreadId,
  onPick,
}: {
  readonly client: WireClient;
  readonly currentThreadId: string;
  readonly onPick: (threadId: string) => void;
}) {
  const [listing, setListing] = useState<Listing>({ kind: 'loading' });

  useEffect(() => {
    let live = true;
    client.listThreads().then(
      (outcome) => {
        if (!live) return;
        setListing(
          outcome.kind === 'ok'
            ? { kind: 'ok', result: outcome.result }
            : { kind: 'failed', message: outcome.message },
        );
      },
      (error: unknown) => {
        if (!live) return;
        setListing({
          kind: 'failed',
          message: error instanceof Error ? error.message : String(error),
        });
      },
    );
    return () => {
      live = false;
    };
  }, [client]);

  return (
    <section aria-label="以前的會話" className="space-y-2 rounded-md border p-3 text-sm">
      {listing.kind === 'loading' && <p className="text-muted-foreground">讀取中…</p>}
      {/* 列不出來與「沒有」是兩件事：沒開 --session-log 的 server 走這一格，原因照 server 講的印。 */}
      {listing.kind === 'failed' && <p className="text-destructive">列不出來：{listing.message}</p>}
      {listing.kind === 'ok' && (
        <>
          {listing.result.items.length === 0 ? (
            <p className="text-muted-foreground">這個專案還沒有以前的會話。</p>
          ) : (
            <ul className="space-y-1">
              {listing.result.items.map((item) => {
                const current = item.threadId === currentThreadId;
                return (
                  <li key={item.threadId}>
                    <button
                      type="button"
                      disabled={current}
                      onClick={() => onPick(item.threadId)}
                      className="hover:bg-muted flex w-full items-baseline justify-between gap-2 rounded px-2 py-1 text-left disabled:opacity-60"
                    >
                      <span className="truncate">{labelOf(item)}</span>
                      <span className="text-muted-foreground shrink-0 text-xs">
                        {[
                          ...(current ? ['目前這條'] : []),
                          ...(item.running ? ['執行中'] : []),
                          formatTime(item.updatedAt),
                        ].join(' · ')}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {listing.result.unreadable > 0 && (
            <p className="text-muted-foreground text-xs">
              另有 {listing.result.unreadable} 份讀不懂、或格式比這台 server 新，沒有列出來。
            </p>
          )}
        </>
      )}
    </section>
  );
}

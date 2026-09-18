import type { ThreadListResult, ThreadSummary, WireClient } from '@nexus/wire';
import { useEffect, useState } from 'react';

/**
 * 以前的會話——[#302](https://github.com/DemianLi/nexus-agent/issues/302)。照 dsh 的 `session/list`：
 * 由新到舊、正在跑的有標記，每一列是第一則人打的字的開頭。
 *
 * **掛上來才讀、每次打開都重讀**：清單會變（別的分頁剛講過話、剛開了一條），而讀一次是冷的——server 那側
 * 一條 agent 都不為它建。
 *
 * **空白會話只列目前這一條**（[#313](https://github.com/DemianLi/nexus-agent/issues/313)），照 dsh 側欄的
 * `sessionVisible`（`packages/client/ui-workspace/src/client/tree.ts`）：別條空白的不是「以前的會話」，是開了沒講話
 * 的——「新對話」會拿它們來重用（`lib/new-conversation.ts`）。目前這條要落了盤才在清單上，還沒落盤的不列。
 *
 * **沒有標題的另一種原因照講**（`ThreadSummary.title` 的說明）：有輪次、但全是目標排的。
 */

/** 目前這條還是空白。照 dsh 的 `session.new`（「新会话」），不帶時間。 */
export const BLANK_THREAD_LABEL = '新會話';
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

  const visible =
    listing.kind === 'ok'
      ? listing.result.items.filter((item) => !item.blank || item.threadId === currentThreadId)
      : [];

  return (
    <section
      aria-label="以前的會話"
      className="bg-card shadow-material space-y-2 rounded-md p-3 text-sm"
    >
      {listing.kind === 'loading' && <p className="text-muted-foreground">讀取中…</p>}
      {/* 列不出來與「沒有」是兩件事：沒開 --session-log 的 server 走這一格，原因照 server 講的印。 */}
      {listing.kind === 'failed' && <p className="text-destructive">列不出來：{listing.message}</p>}
      {listing.kind === 'ok' && (
        <>
          {/*
           **判的是藏過之後的**：磁碟上只剩別條空白會話時，列表一列都不畫——那些不是以前的會話，所以照講「還沒有」。
           */}
          {visible.length === 0 ? (
            <p className="text-muted-foreground">這個專案還沒有以前的會話。</p>
          ) : (
            <ul className="space-y-1">
              {visible.map((item) => {
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
                          // 空白的那一列不帶時間（dsh `Rows.tsx`）：它的時間是建立時間，不是誰說過話。
                          ...(item.blank ? [] : [formatTime(item.updatedAt)]),
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

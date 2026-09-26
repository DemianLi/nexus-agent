import type { ThreadListResult, ThreadSummary, WireClient } from '@nexus/wire';
import { useEffect, useId, useState } from 'react';
import type { ReactNode } from 'react';

import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarInput,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';
import { BUCKET_LABEL, filterThreads, groupThreads } from '@/lib/thread-groups';
import { threadLabel, withCurrentTitle } from '@/lib/thread-title';

export { BLANK_THREAD_LABEL, UNTITLED_THREAD_LABEL } from '@/lib/thread-title';

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
 *
 * **分組、搜尋、狀態點**（inventory 列 6）：按今天／昨天／過去 7 天／更早分組、標題搜尋，規則在 `lib/thread-groups.ts`。
 * 正在跑的那一列在標題旁一顆點，旁邊有給報讀器的「執行中」。點跟清單一樣是打開那一刻的快照：dsh 的即時狀態與
 * 「跑完了還沒看」的提醒點靠伺服器推會話狀態，我們還沒有那條路。
 */

type Listing =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ok'; readonly result: ThreadListResult }
  | { readonly kind: 'failed'; readonly message: string };

function labelOf(item: ThreadSummary): string {
  return threadLabel(item.title, item.blank);
}

function formatTime(updatedAt: number): string {
  return new Date(updatedAt).toLocaleString('zh-TW', { dateStyle: 'short', timeStyle: 'short' });
}

export function ThreadList({
  client,
  currentThreadId,
  currentTitle,
  onPick,
}: {
  readonly client: WireClient;
  readonly currentThreadId: string;
  /** 目前這條即時推來的標題（`ConversationState.title`）：蓋過快照裡的那一列（#655 的 Q3）。 */
  readonly currentTitle: string | null;
  readonly onPick: (threadId: string) => void;
}) {
  const [listing, setListing] = useState<Listing>({ kind: 'loading' });
  const labelId = useId();

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

  const [query, setQuery] = useState('');
  const visible =
    listing.kind === 'ok'
      ? withCurrentTitle(listing.result.items, currentThreadId, currentTitle).filter(
          (item) => !item.blank || item.threadId === currentThreadId,
        )
      : [];
  const matched = filterThreads(visible, query);

  return (
    <SidebarGroup role="group" aria-labelledby={labelId} className="text-sm">
      <SidebarGroupLabel id={labelId}>以前的會話</SidebarGroupLabel>
      {listing.kind === 'loading' && <p className="text-muted-foreground px-2">讀取中…</p>}
      {/* 列不出來與「沒有」是兩件事：關掉落盤的 server（清單上 `session-persistence` 那一列，#613）走這一格，原因照 server 講的印。
          前綴留著，其他失敗（例如讀取拋錯）也走這一格；server 的訊息自己也寫「列不出來」時會重複一次，措辭歸 server 那側（#620）。 */}
      {listing.kind === 'failed' && (
        <p className="text-destructive px-2">列不出來：{listing.message}</p>
      )}
      {listing.kind === 'ok' && (
        <>
          {/*
           **判的是藏過之後的**：磁碟上只剩別條空白會話時，列表一列都不畫——那些不是以前的會話，所以照講「還沒有」。
           */}
          {visible.length === 0 ? (
            <p className="text-muted-foreground px-2">這個專案還沒有以前的會話。</p>
          ) : (
            <>
              <SidebarInput
                type="search"
                aria-label="搜尋以前的會話"
                placeholder="搜尋標題"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && query !== '') {
                    event.preventDefault();
                    setQuery('');
                  }
                }}
                className="mb-1 h-11 lg:h-8"
              />
              {matched.length === 0 ? (
                <p className="text-muted-foreground px-2" role="status">
                  沒有標題含「{query.trim()}」的會話。
                </p>
              ) : (
                <ThreadGroupList
                  items={matched}
                  currentThreadId={currentThreadId}
                  onPick={onPick}
                />
              )}
            </>
          )}
          {listing.result.unreadable > 0 && (
            <p className="text-muted-foreground px-2 text-xs">
              另有 {listing.result.unreadable} 份讀不懂、或格式比這台 server 新，沒有列出來。
            </p>
          )}
        </>
      )}
    </SidebarGroup>
  );
}

/** 分好組的清單：空白那一列在最前面、不帶組名，之後每組一個標題。 */
function ThreadGroupList({
  items,
  currentThreadId,
  onPick,
}: {
  readonly items: readonly ThreadSummary[];
  readonly currentThreadId: string;
  readonly onPick: (threadId: string) => void;
}) {
  const { blank, groups } = groupThreads(items, Date.now());
  const row = (item: ThreadSummary) => (
    <ThreadRow
      key={item.threadId}
      item={item}
      current={item.threadId === currentThreadId}
      onPick={onPick}
    />
  );
  return (
    <>
      {blank.length > 0 && <SidebarMenu>{blank.map(row)}</SidebarMenu>}
      {groups.map(({ bucket, items: members }) => (
        <BucketGroup key={bucket} label={BUCKET_LABEL[bucket]}>
          {members.map(row)}
        </BucketGroup>
      ))}
    </>
  );
}

function BucketGroup({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  const labelId = useId();
  return (
    <div role="group" aria-labelledby={labelId} className="mt-2" data-testid="thread-bucket">
      <div id={labelId} className="text-muted-foreground px-2 pb-1 text-xs font-medium">
        {label}
      </div>
      <SidebarMenu>{children}</SidebarMenu>
    </div>
  );
}

function ThreadRow({
  item,
  current,
  onPick,
}: {
  readonly item: ThreadSummary;
  readonly current: boolean;
  readonly onPick: (threadId: string) => void;
}) {
  return (
    <SidebarMenuItem>
      {/* 觸控目標 44px，1024 以上回到 36（§9）。 */}
      <SidebarMenuButton
        type="button"
        isActive={current}
        disabled={current}
        onClick={() => onPick(item.threadId)}
        className="h-auto min-h-11 flex-col items-start gap-0.5 lg:min-h-9"
      >
        <span className="flex w-full min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate">{labelOf(item)}</span>
          {item.running && (
            <span className="flex shrink-0 items-center" data-testid="thread-running">
              <span aria-hidden className="bg-brand size-2 rounded-full" />
              <span className="sr-only">執行中</span>
            </span>
          )}
        </span>
        {(current || !item.blank) && (
          <span className="text-muted-foreground text-xs">
            {[
              ...(current ? ['目前這條'] : []),
              // 空白的那一列不帶時間（dsh `Rows.tsx`）：它的時間是建立時間，不是誰說過話。
              ...(item.blank ? [] : [formatTime(item.updatedAt)]),
            ].join(' · ')}
          </span>
        )}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

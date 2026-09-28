import type { ThreadSummary } from '@nexus/wire';
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
import type { ThreadDirectory } from '@/hooks/use-thread-directory';
import { cn } from '@/lib/utils';
import { BUCKET_LABEL, filterThreads, groupThreads } from '@/lib/thread-groups';
import { ROW_STATUS_TEXT } from '@/lib/thread-status';
import type { RowStatus } from '@/lib/thread-status';
import { threadLabel, withCurrentTitle } from '@/lib/thread-title';

export { BLANK_THREAD_LABEL, UNTITLED_THREAD_LABEL } from '@/lib/thread-title';

/**
 * 以前的會話——[#302](https://github.com/DemianLi/nexus-agent/issues/302)。照 dsh 的 `session/list`：
 * 由新到舊、正在跑的有標記，每一列寫這條會話的標題：模型產生的那一個，還沒產生時是第一則人打的字的開頭
 * （伺服器那側的規則，見 `lib/thread-title.ts`）。
 *
 * **每次打開都重讀**：清單會變（別的分頁剛講過話、剛開了一條），而讀一次是冷的——server 那側一條 agent 都不為它建。
 * 清單本身由 `App` 的 `useThreadDirectory` 持有（#632），這裡掛上時請它重抓；收起來再打開之前，畫的是上一份。
 *
 * **空白會話只列目前這一條**（[#313](https://github.com/DemianLi/nexus-agent/issues/313)），照 dsh 側欄的
 * `sessionVisible`（`packages/client/ui-workspace/src/client/tree.ts`）：別條空白的不是「以前的會話」，是開了沒講話
 * 的——「新對話」會拿它們來重用（`lib/new-conversation.ts`）。目前這條要落了盤才在清單上，還沒落盤的不列。
 *
 * **沒有標題的另一種原因照講**（`ThreadSummary.title` 的說明）：有輪次、但全是目標排的。
 *
 * **分組、搜尋**（inventory 列 6）：按今天／昨天／過去 7 天／更早分組、標題搜尋，規則在 `lib/thread-groups.ts`。
 *
 * **狀態點**（[#632](https://github.com/DemianLi/nexus-agent/issues/632)）：即時的，照全域下行翻，規則在
 * `lib/thread-status.ts`。等人回答（核准、提問、計劃審核）＞ 在跑 ＞ 跑完沒看，一列只畫最前面那一種；點旁邊有給
 * 報讀器的那一句。等人回答的三種照 dsh 把第二行的時間換成短的那一句。
 */

function labelOf(item: ThreadSummary): string {
  return threadLabel(item.title, item.blank);
}

function formatTime(updatedAt: number): string {
  return new Date(updatedAt).toLocaleString('zh-TW', { dateStyle: 'short', timeStyle: 'short' });
}

export function ThreadList({
  directory,
  currentThreadId,
  currentTitle,
  onPick,
}: {
  readonly directory: ThreadDirectory;
  readonly currentThreadId: string;
  /** 目前這條即時推來的標題（`ConversationState.title`）：蓋過快照裡的那一列（#655 的 Q3）。 */
  readonly currentTitle: string | null;
  readonly onPick: (threadId: string) => void;
}) {
  const { listing, statusOf, refresh } = directory;
  const labelId = useId();

  useEffect(() => {
    refresh();
  }, [refresh]);

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
                  statusOf={statusOf}
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
  statusOf,
  onPick,
}: {
  readonly items: readonly ThreadSummary[];
  readonly currentThreadId: string;
  readonly statusOf: ThreadDirectory['statusOf'];
  readonly onPick: (threadId: string) => void;
}) {
  const { blank, groups } = groupThreads(items, Date.now());
  const row = (item: ThreadSummary) => (
    <ThreadRow
      key={item.threadId}
      item={item}
      status={statusOf(item)}
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

/** 點的顏色：等人回答是警示色，在跑是品牌色，跑完沒看是完成色。 */
const DOT_CLASS: Record<Exclude<RowStatus, undefined>, string> = {
  approval: 'bg-warning',
  question: 'bg-warning',
  'plan-review': 'bg-warning',
  running: 'bg-brand',
  completed: 'bg-success',
};

function ThreadRow({
  item,
  status,
  current,
  onPick,
}: {
  readonly item: ThreadSummary;
  readonly status: RowStatus;
  readonly current: boolean;
  readonly onPick: (threadId: string) => void;
}) {
  const compact = status === undefined ? undefined : ROW_STATUS_TEXT[status].compact;
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
          {status !== undefined && (
            <span
              className="flex shrink-0 items-center"
              data-testid="thread-status"
              data-status={status}
            >
              <span aria-hidden className={cn('size-2 rounded-full', DOT_CLASS[status])} />
              <span className="sr-only">{ROW_STATUS_TEXT[status].label}</span>
            </span>
          )}
        </span>
        {(current || !item.blank) && (
          <span className="text-muted-foreground text-xs">
            {[
              ...(current ? ['目前這條'] : []),
              // 空白的那一列不帶時間（dsh `Rows.tsx`）：它的時間是建立時間，不是誰說過話。
              // 等人回答時換成短的那一句（dsh 的 `trailingLabel`）；報讀器已經從點旁邊那一句聽到了。
              ...(item.blank || compact !== undefined ? [] : [formatTime(item.updatedAt)]),
            ].join(' · ')}
            {compact !== undefined && (
              <span aria-hidden className="text-warning">
                {current ? ' · ' : ''}
                {compact}
              </span>
            )}
          </span>
        )}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

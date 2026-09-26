import type { WireClient } from '@nexus/wire';
import { Plus } from 'lucide-react';

import { ThreadList } from '@/components/thread-list';
import { Button } from '@/components/ui/button';
import { Sidebar, SidebarContent, SidebarHeader, useSidebar } from '@/components/ui/sidebar';

/**
 * 左側欄（inventory 列 1、2、6）：1024 以上是桌面側欄，以下收成抽屜（`hooks/use-mobile.ts`）。
 *
 * **清單只在看得到時掛上**：桌面展開、或抽屜打開。`ThreadList` 掛上才讀、每次掛上都重讀（#302 的理由：清單會變，
 * 讀一次是冷的），收起來就卸掉，下次打開重讀。
 */
export function AppSidebar({
  client,
  currentThreadId,
  currentTitle,
  onNewConversation,
  onPick,
}: {
  readonly client: WireClient;
  readonly currentThreadId: string;
  readonly currentTitle: string | null;
  readonly onNewConversation: () => void;
  readonly onPick: (threadId: string) => void;
}) {
  const { isMobile, openMobile, setOpenMobile, state } = useSidebar();
  const visible = isMobile ? openMobile : state === 'expanded';

  return (
    // 側欄的內容要在地標裡，不然 axe 的 region 規則算它「不在任何地標內」（#384）。
    // 桌面收起來時整條 `inert`：它只是被推到畫面外，不然 Tab 還走得進去。
    <Sidebar
      aria-label="對話"
      role="navigation"
      {...(!isMobile && state === 'collapsed' ? { inert: true } : {})}
    >
      <SidebarHeader className="p-3">
        {/*
          **永遠按得動**，不看 `busy`／`connected`／狀態。接回一條停在核准點的 thread 時，
          沒有重播就沒有卡片，送出去只會被「停在核准點」擋回來——這顆按鈕是那一格唯一的出口。
          server 那端的 run 不會因此停下，跟關掉分頁一樣。還沒講過話時按下去留在原地（#313），那一格不是出口
          要走的路——判準見 `ConversationView` 的 `engaged`，分不出來時一律當成講過。
        */}
        <Button
          type="button"
          variant="secondary"
          className="h-11 justify-start lg:h-9"
          onClick={() => {
            setOpenMobile(false);
            onNewConversation();
          }}
        >
          <Plus aria-hidden />
          新對話
        </Button>
      </SidebarHeader>
      <SidebarContent>
        {visible && (
          <ThreadList
            client={client}
            currentThreadId={currentThreadId}
            currentTitle={currentTitle}
            onPick={(threadId) => {
              setOpenMobile(false);
              onPick(threadId);
            }}
          />
        )}
      </SidebarContent>
    </Sidebar>
  );
}

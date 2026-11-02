/**
 * nexus 層（#1680 PR B）：轉出 vendor 的 solid-glass 版（`vendor/solid-glass/components/ui/sidebar.tsx`，Base UI 的 `useRender`），
 * 外觀照 SG（#1468 Q8；#1281 的字級與收合動效照 Q19 改回 SG）。這個檔沒有本地修改；vendor 檔的五個 patch 登記在
 * `vendor/solid-glass/README.md` 的「本地修改」第 51–55 條：
 *
 * - 中文報讀字串：SheetTitle「側欄」、SheetDescription「對話列表與新對話。」、Trigger 與 Rail 的「開關側欄」（§8，`0011`）。
 * - `md:` 全換成 `lg:`：斷點是 1024（`hooks/use-mobile.ts`），不換的話 768–1023 會先畫出桌面側欄（`0012`）。
 * - cookie 寫入包 try/catch：沙盒 iframe 裡會拋 SecurityError（§9，`0013`）。
 * - 手機抽屜關掉時自己把焦點還給 `SidebarTrigger`（`finalFocus`，§8，`0014`）。
 * - 手機抽屜寬度是 `--sidebar-width`（18rem），不讓 vendor sheet 的 `data-[side=*]:w-3/4` 蓋掉（`0015`）。
 */
export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
} from '@/vendor/solid-glass/components/ui/sidebar';

/**
 * nexus 層（#1638 PR B）：轉出 vendor 的 solid-glass 版（`vendor/solid-glass/components/ui/message-scroller.tsx`），外觀照 SG（#1468 Q8）。
 * 本地修改登記在 `vendor/solid-glass/README.md` 的「本地修改」，這個檔有一條（第 41 條）：
 *
 * - `MessageScrollerButton` 的動效照 nexus 的 §7：只淡入＋縮放 .97、不位移，時長與緩動走 `--duration-*`／`--ease-*` token。
 *   vendor（`:100`）是 `translate-y-full`、`scale-95`、`duration-200`／`400` 加兩條 cubic-bezier。全域動效時長在 ④ 一起換成 SG，
 *   這張單換一顆會兩套並存；不位移也讓「跳到最新」浮鈕的避讓（`hooks/use-scroll-button-clearance.ts`）量到的框不受過渡影響（PM 判）。
 *   靠 cn 蓋掉 vendor 同一組的 class，所以每一條都要跟 vendor 那條的前綴一字不差。④ 換全域動效時拿掉，改回 vendor 原樣。
 *
 * 其餘本地修改不在這裡：
 * - 報讀字串「捲到最新的訊息」「捲到最早的訊息」是改 vendor 檔（第 42 條，`patches/0009-message-scroller-scroll-label.patch`）。
 * - item 的 `[content-visibility:auto]` 由覆寫檔壓成 `visible`（第 43 條，`styles/solid-glass.overrides.css`）：paint containment
 *   會把卡片陰影與光暈切成直角（Q6、§9）。
 *
 * 自動捲動時 vendor 只把捲軸換成透明（`scrollbar-thumb-transparent`／`scrollbar-track-transparent` 只設 `scrollbar-color`），不改捲軸寬，
 * 所以 #1363 不用本地修改；`registry-edits.test.ts` 釘 vendor 原文，`scripts/check-built-css.mjs` 掃產物。
 * 依賴 `@shadcn/react` 的 primitive：viewport 預設 `role="region"`、content 預設 `role="log"`。
 */
import type * as React from 'react';

import { cn } from '@/lib/utils';
import { MessageScrollerButton as VendorMessageScrollerButton } from '@/vendor/solid-glass/components/ui/message-scroller';

export {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
  useMessageScrollerScrollable,
  useMessageScrollerVisibility,
} from '@/vendor/solid-glass/components/ui/message-scroller';

/** 第 41 條：蓋掉 vendor 的位移、縮放、時長與緩動（§7）。 */
export const SCROLL_BUTTON_MOTION =
  'transition-[scale,opacity] duration-(--duration-fast) data-[active=false]:scale-97 data-[active=false]:duration-(--duration-quick) data-[active=false]:ease-(--ease-smooth-out) data-[active=true]:ease-(--ease-smooth-out) data-[direction=end]:data-[active=false]:translate-y-0 data-[direction=start]:data-[active=false]:translate-y-0';

function MessageScrollerButton({
  className,
  ...props
}: React.ComponentProps<typeof VendorMessageScrollerButton>) {
  return <VendorMessageScrollerButton className={cn(SCROLL_BUTTON_MOTION, className)} {...props} />;
}

export { MessageScrollerButton };

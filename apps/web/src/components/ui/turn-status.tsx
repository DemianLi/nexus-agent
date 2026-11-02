/**
 * nexus 層（#1684）：轉出 vendor 的 solid-glass 版（`vendor/solid-glass/components/ui/turn-status.tsx`），外觀照 SG（#1468 Q8）。
 * 本地修改登記在 `vendor/solid-glass/README.md` 的「本地修改」：
 *
 * - vendor 檔有一條 patch（第 72 條，`0023`）：拿掉兩處 `role="status"`。代理的現況只由 `components/status-line.tsx` 唸（§8），
 *   live region 由它包在外面；`live-region.test.ts` 不放行 vendor。
 * - 這一層（第 74 條）：型別上拿掉 `since`、`tokens`、`children`（#1684 PM 定）。
 *   - `since`：經過時間由狀態列的 `RunningElapsed` 畫。vendor 的那一格在這一列裡，會被外面的 live region 包進去、每秒重唸（#1308）；
 *     它用瀏覽器時鐘（nexus 用 server 時鐘，`lib/server-clock.ts`），字是英文（`8s`）。
 *   - `tokens`：wire 的 `tokenUsage` 是整條對話的累計，不是這一輪的；標頭的用量已經在顯示。它也在這一列裡、會跟著重唸。
 *   - `children`：有了就變成按鈕、可以展開，nexus 沒有要放進去的東西。
 *   `trailing` 留著，但同樣在外面的 live region 裡，**不要拿來放經過時間**。
 */
import type * as React from 'react';

import { TurnStatus as VendorTurnStatus } from '@/vendor/solid-glass/components/ui/turn-status';

type TurnStatusProps = Omit<
  React.ComponentProps<typeof VendorTurnStatus>,
  'since' | 'tokens' | 'children'
>;

function TurnStatus(props: TurnStatusProps) {
  return <VendorTurnStatus {...props} />;
}

export { TurnStatus, type TurnStatusProps };

/**
 * nexus 層（#1583）：轉出 vendor 的 solid-glass 版（`vendor/solid-glass/components/ui/alert-dialog.tsx`，Base UI），外觀照 SG（#1468 Q8）。
 * 本地修改登記在 `vendor/solid-glass/README.md` 的「本地修改」，這個檔有一條（第 24 條）：
 *
 * - `AlertDialogAction` 按了就關框：vendor 的 Action 只是一顆 `Button`（vendor `:142-153`），Base UI 的 alert-dialog 也沒有
 *   Action 部件，按了框不會關。這裡用 `AlertDialogPrimitive.Close` 的 `render` 接 vendor 那顆按鈕：外觀、`data-slot` 照 vendor，
 *   關框交給 Close；呼叫端的 `onClick` 照樣會跑（Base UI 合併兩邊的事件）。
 *
 * 跟 `dialog` 的差別（Base UI 自帶）：點外面不會關，要人明確按一顆；Esc 等於取消。
 */
import { AlertDialog as AlertDialogPrimitive } from '@base-ui/react/alert-dialog';
import type * as React from 'react';

import { AlertDialogAction as VendorAlertDialogAction } from '@/vendor/solid-glass/components/ui/alert-dialog';

export {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/vendor/solid-glass/components/ui/alert-dialog';

function AlertDialogAction(props: React.ComponentProps<typeof VendorAlertDialogAction>) {
  return <AlertDialogPrimitive.Close render={<VendorAlertDialogAction {...props} />} />;
}

export { AlertDialogAction };

/**
 * nexus 層（#1583）：轉出 vendor 的 solid-glass 版（`vendor/solid-glass/components/ui/command.tsx`，cmdk），外觀照 SG（#1468 Q8）。
 * 本地修改登記在 `vendor/solid-glass/README.md` 的「本地修改」，這個檔有一條（第 26 條）：
 *
 * - `CommandDialog` 預設的標題與說明換成中文（§8）。vendor 預設是英文，產品碼目前沒用到 CommandDialog，照舊保留中文預設。
 *
 * 覆寫檔那一層另有兩條（`styles/solid-glass.overrides.css`）：vendor 在每個 `CommandItem` 的 children 後面自己附一顆勾
 * （第 27 條，設成 `display: none`，勾由呼叫端自己畫、帶報讀名稱）；搜尋框的焦點外框畫在它的 InputGroup 上（第 15 條擴到 `command-input`）。
 */
import type * as React from 'react';

import { CommandDialog as VendorCommandDialog } from '@/vendor/solid-glass/components/ui/command';

export {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@/vendor/solid-glass/components/ui/command';

function CommandDialog({
  title = '命令選單',
  description = '搜尋要執行的命令…',
  ...props
}: React.ComponentProps<typeof VendorCommandDialog>) {
  return <VendorCommandDialog title={title} description={description} {...props} />;
}

export { CommandDialog };

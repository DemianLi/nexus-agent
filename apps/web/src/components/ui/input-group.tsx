/**
 * nexus 層（#1523）：轉出 vendor 的 solid-glass 版（`vendor/solid-glass/components/ui/input-group.tsx`），外觀照 SG（#1468 Q8）。
 * 本地修改登記在 `vendor/solid-glass/README.md` 的「本地修改」，這個檔有一條（第 16 條）：
 *
 * - `InputGroupAddon`：點 addon 的空白處時，vendor 只找 `input` 來 focus（vendor `:61`），這裡連 `textarea` 一起找——
 *   輸入框（`composer.tsx`）用的是 `InputGroupTextarea`。vendor 把 `onClick` 寫在 `{...props}` 前面，所以從這裡傳的 `onClick`
 *   整段取代它；呼叫端自己傳 `onClick` 時照舊由呼叫端的蓋掉（跟 vendor 一樣）。
 *
 * 焦點外框畫在群組上（#1279）是覆寫檔那一層，不在這裡（`styles/solid-glass.overrides.css`，第 15 條）。
 */
import type * as React from 'react';

import { InputGroupAddon as VendorInputGroupAddon } from '@/vendor/solid-glass/components/ui/input-group';

export {
  InputGroup,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
  InputGroupTextarea,
} from '@/vendor/solid-glass/components/ui/input-group';

function focusControl(event: React.MouseEvent<HTMLDivElement>) {
  if ((event.target as HTMLElement).closest('button')) return;
  event.currentTarget.parentElement?.querySelector<HTMLElement>('input, textarea')?.focus();
}

function InputGroupAddon(props: React.ComponentProps<typeof VendorInputGroupAddon>) {
  return <VendorInputGroupAddon onClick={focusControl} {...props} />;
}

export { InputGroupAddon };

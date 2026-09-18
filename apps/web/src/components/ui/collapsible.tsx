/**
 * 來源：shadcn registry `collapsible`（style new-york，https://ui.shadcn.com/r/styles/new-york-v4/collapsible.json），
 * shadcn CLI 4.21.0 `shadcn add collapsible badge --overwrite`。裝進來就是我們的原始碼，不靠重跑 `shadcn add` 更新。
 * 沒有改動（只拿掉 `'use client'`）；展開收合的時長在 `index.css` 的 `@theme`（開 250／關 150，§7）。
 */
import { Collapsible as CollapsiblePrimitive } from 'radix-ui';

function Collapsible({ ...props }: React.ComponentProps<typeof CollapsiblePrimitive.Root>) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />;
}

function CollapsibleTrigger({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleTrigger>) {
  return <CollapsiblePrimitive.CollapsibleTrigger data-slot="collapsible-trigger" {...props} />;
}

function CollapsibleContent({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleContent>) {
  return <CollapsiblePrimitive.CollapsibleContent data-slot="collapsible-content" {...props} />;
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent };

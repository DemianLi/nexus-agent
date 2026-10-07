import type { ComponentProps } from 'react';

import { CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

/**
 * 可展開列的觸發鈕（[#1141](https://github.com/DemianLi/nexus-agent/issues/1141) 第 3 刀）：工具卡、待辦、核准的原始內容、
 * 排隊清單各手寫過一份。這裡只放四處共通的部分：整列可點的底色、最小高度（觸控 44px）、圓角、過渡。
 * 圖示、文字大小、間距各處不同，由呼叫端用 `className` 補；撞到的（例如 `min-h-*`）以 `cn` 合併，呼叫端的贏。
 *
 * 圓角用 `rounded-row`（`index.css` 的 `--radius-row`）：卡片是 `rounded-3xl p-1`，列嵌在裡面，所以是 24 減內距 4。
 */
const BASE =
  'group hover:bg-chip-hover active:bg-chip-pressed flex min-h-11 w-full min-w-0 items-center rounded-row px-3 text-left transition-colors duration-(--duration-quick)';

export function RowTrigger({ className, ...props }: ComponentProps<typeof CollapsibleTrigger>) {
  return <CollapsibleTrigger className={cn(BASE, className)} {...props} />;
}

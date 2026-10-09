import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';

import { CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

/**
 * 可展開列的觸發鈕（[#1141](https://github.com/DemianLi/nexus-agent/issues/1141) 第 3 刀、[#1279](https://github.com/DemianLi/nexus-agent/issues/1279)）：
 * 整列可點的底色、最小高度（觸控 44px）、圓角、過渡。圖示、文字大小、間距各處不同，由呼叫端用 `className` 補；
 * 撞到的（例如 `min-h-*`）以 `cn` 合併，呼叫端的贏。箭頭用 `Chevron`，它會跟著這顆的 `data-state` 轉。
 *
 * 兩種位置（`fit`）：
 * - `card`（預設）：嵌在 `rounded-3xl p-1` 的卡片裡（工具卡、待辦、核准的原始內容、排隊清單）。圓角用 `rounded-row`
 *   （`index.css` 的 `--radius-row`，24 減內距 4），跟卡片同心。
 * - `bare`：不在卡片裡、自己就是一列（思考過程、摘要列、觀測與成本分頁的列）。`rounded-xl`、內距窄一點（`px-2`）。
 *
 * 新的可展開列用這個，不要再手寫 `hover:bg-chip-hover active:bg-chip-pressed … w-full … text-left`（`design-system.test.ts` 會擋）。
 */
const rowTrigger = cva(
  'group hover:bg-chip-hover active:bg-chip-pressed flex min-h-11 w-full min-w-0 items-center text-left transition-colors duration-(--duration-quick)',
  {
    variants: {
      fit: {
        card: 'rounded-row px-3',
        bare: 'rounded-xl gap-2 px-2',
      },
    },
    defaultVariants: { fit: 'card' },
  },
);

export function RowTrigger({
  className,
  fit,
  ...props
}: ComponentProps<typeof CollapsibleTrigger> & VariantProps<typeof rowTrigger>) {
  return <CollapsibleTrigger className={cn(rowTrigger({ fit }), className)} {...props} />;
}

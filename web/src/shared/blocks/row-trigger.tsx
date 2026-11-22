import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';

import { CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

/**
 * 可展開列的觸發鈕（[#1141](https://github.com/DemianLi/nexus-agent/issues/1141) 第 3 刀、[#1279](https://github.com/DemianLi/nexus-agent/issues/1279)）：
 * 整列可點的底色、最小高度（觸控 44px）、圓角、過渡。圖示、文字大小、間距各處不同，由呼叫端用 `className` 補；
 * 撞到的（例如 `min-h-*`）以 `cn` 合併，呼叫端的贏。箭頭用 `Chevron`，它會跟著這顆開著時的 `data-panel-open` 轉。
 *
 * 兩種位置（`fit`）：
 * - `card`（預設）：嵌在 `rounded-3xl p-1` 的卡片裡（工具卡、待辦、核准的原始內容、排隊清單）。圓角用 `rounded-row`
 *   （`index.css` 的 `--radius-row`，SG 的 3xl 減內距 4），跟卡片同心。
 * - `bare`：不在卡片裡、自己就是一列（思考過程、摘要列、觀測與成本分頁的列）。`rounded-xl`、內距窄一點（`px-2`）。
 *
 * hover 照 SG ghost：`hover:bg-muted`（底是 SG 的 `--hover`）配 `hover:text-foreground`，按著跟 hover 同一階。子元素自己寫
 * `text-muted-foreground` 的，蓋不到，要用具名 group 翻：`group-hover/row-trigger:text-foreground`（裸的 `group` 會被外層的 hover 誤觸發）。
 *
 * 新的可展開列用這個，不要再手寫 `hover:bg-muted … w-full … text-left`（`design-system.test.ts` 會擋）。
 */
const rowTrigger = cva(
  'group group/row-trigger hover:bg-muted hover:text-foreground flex min-h-11 w-full min-w-0 items-center text-left transition-colors duration-150',
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
}: Omit<ComponentProps<typeof CollapsibleTrigger>, 'className'> &
  VariantProps<typeof rowTrigger> & {
    /** 只收字串：Base UI 的 `className` 也收 `(state) => string`，`cn` 合併不了那一種。 */
    className?: string;
  }) {
  return <CollapsibleTrigger className={cn(rowTrigger({ fit }), className)} {...props} />;
}

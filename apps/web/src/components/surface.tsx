import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps, ElementType } from 'react';

import { cn } from '@/lib/utils';

/**
 * 表面積木（[#1141](https://github.com/DemianLi/nexus-agent/issues/1141) 第 3 刀）：卡片與內層 stage 原本在十幾處各手寫同一組 class。
 * 兩種，配方出處在規格 §5（形狀、邊緣畫在陰影裡）：
 * - `stage`：內層（`bg-stage shadow-stage rounded-xl`，14）。工具輸入輸出、清單、改動列、計劃摘要都放在這種底上。
 * - `raised`：浮起來的卡片（`bg-card shadow-material rounded-3xl p-1`，24），裡面的列用 `rounded-row`（24 減內距 4）。
 *
 * 只含共通的部分；內距、版型、字級由呼叫端用 `className` 補（`cn` 合併，呼叫端的贏）。`as` 選元素，預設 `div`。
 * 新的卡片或內層底，用這個，不要再手寫 `bg-stage shadow-stage` 或 `bg-card shadow-material rounded-3xl`
 * （`design-system.test.ts` 會擋）。
 */
const surface = cva('', {
  variants: {
    tone: {
      stage: 'bg-stage shadow-stage rounded-xl',
      raised: 'bg-card shadow-material rounded-3xl p-1',
    },
  },
});

type SurfaceTag = 'div' | 'section' | 'ul' | 'ol' | 'li' | 'p' | 'pre';

export function Surface({
  as = 'div',
  tone,
  className,
  ...props
}: ComponentProps<'div'> & Required<VariantProps<typeof surface>> & { as?: SurfaceTag }) {
  const Tag = as as ElementType;
  return <Tag className={cn(surface({ tone }), className)} {...props} />;
}

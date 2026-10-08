import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps, ElementType, Ref } from 'react';

import { cn } from '@/lib/utils';

/**
 * 表面積木（[#1141](https://github.com/DemianLi/nexus-agent/issues/1141) 第 3 刀）：卡片與內層 stage 原本在十幾處各手寫同一組 class。
 * 兩種，配方出處在規格 §5（形狀、邊緣畫在陰影裡）：
 * - `stage`：內層（`bg-stage shadow-stage rounded-xl`，14）。工具輸入輸出、清單、改動列、計劃摘要都放在這種底上。
 * - `raised`：浮起來的卡片（`bg-card shadow-material rounded-3xl p-1`，24），裡面的列用 `rounded-row`（24 減內距 4）。
 * - `docked`：貼在輸入框上方的卡片（`bg-card border rounded-3xl`，24）：待辦、送出佇列、目標列。**刻意用 `border` 畫平的細線、不用陰影**——
 *   它們不是浮在對話裡，是接在輸入框上的一排；亮色下平線比浮起來的投影安靜（暗色兩者幾乎一樣）。內距由呼叫端給（`p-1` 或 `px-3 py-2`）。
 *
 * 只含共通的部分；內距、版型、字級由呼叫端用 `className` 補（`cn` 合併，呼叫端的贏）。`as` 選元素，預設 `div`。
 * 新的卡片或內層底，用這個，不要再手寫 `bg-stage shadow-stage`、`bg-card shadow-material rounded-3xl` 或 `bg-card border rounded-3xl`
 * （`design-system.test.ts` 會擋）。
 */
const surface = cva('', {
  variants: {
    tone: {
      stage: 'bg-stage shadow-stage rounded-xl',
      raised: 'bg-card shadow-material rounded-3xl p-1',
      docked: 'bg-card border rounded-3xl',
    },
  },
});

type SurfaceTag = 'div' | 'section' | 'ul' | 'ol' | 'li' | 'p' | 'pre';

export function Surface({
  as = 'div',
  tone,
  className,
  ...props
}: Omit<ComponentProps<'div'>, 'ref'> &
  Required<VariantProps<typeof surface>> & { as?: SurfaceTag; ref?: Ref<HTMLElement> }) {
  const Tag = as as ElementType;
  return <Tag className={cn(surface({ tone }), className)} {...props} />;
}

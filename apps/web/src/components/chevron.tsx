import { ChevronDown } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * 可展開的東西右邊那顆往下的箭頭，打開時轉半圈（[#1279](https://github.com/DemianLi/nexus-agent/issues/1279)）：工具卡、待辦、
 * 核准的原始內容、排隊清單、思考過程、摘要列、觀測分頁、側欄的已封存、核准面板的收合鈕原本各手寫一份同樣的 class。
 * 思考過程 #1683 起換成 SG 的 `Reasoning`，用 SG 自己往右、轉 90 度的箭頭，不用這顆。
 *
 * - **預設跟著外層 `group` 的 `data-panel-open` 轉**：Base UI 的 `CollapsibleTrigger` 開著時掛這個屬性、關著不帶（#1638，照 SG）；
 *   `RowTrigger` 帶 `group`，直接用 `CollapsibleTrigger` 的呼叫端自己加 `group`。
 *   箭頭不在那種外層裡時（例如外層的 `group` 是別的東西），呼叫端用 `open` 直接給。
 * - **減少動態時不轉場**：`data-motion-rotate` 對到 `motion.css` 那條，直接跳到轉好的角度。
 * - 顏色、`ml-auto` 這類位置由呼叫端用 `className` 補。
 *
 * 新的可展開元件用這個，不要再手寫 `transition-transform … rotate-180`（`design-system.test.ts` 會擋）。
 */
export function Chevron({
  open,
  className,
}: {
  /** 不給就跟著外層 `group` 的 `data-panel-open`。 */
  readonly open?: boolean;
  readonly className?: string;
}) {
  return (
    <ChevronDown
      aria-hidden
      data-motion-rotate
      className={cn(
        'size-4 shrink-0 transition-transform duration-(--duration-fast) ease-(--ease-smooth-out)',
        open === undefined ? 'group-data-panel-open:rotate-180' : open && 'rotate-180',
        className,
      )}
    />
  );
}

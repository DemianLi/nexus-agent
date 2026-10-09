import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

/**
 * 程式碼小框（[#1280](https://github.com/DemianLi/nexus-agent/issues/1280)）：夾在說明文字裡、原樣照印的一小段等寬字
 * （觀測分頁的系統提示詞全文與工具 schema、MCP 反問的呼叫參數）。原本兩處各手寫同一串
 * `bg-chip … rounded-lg p-2 font-mono text-tip break-words whitespace-pre-wrap`。
 *
 * **跟工具輸出的 `Surface tone="stage"`（`tool/result.tsx` 的 `ToolOutputBlock`）不是同一種東西，所以沒有併**：
 * - stage 是卡片裡的**內層底**：`bg-stage` 加一圈細線陰影、`rounded-xl`，上面還有一行「結果」標題，跟工具輸入、diff、搜尋結果排在同一層。
 * - 這個是**平的**一塊 `bg-chip`、`rounded-lg`、沒有邊線也沒有標題，放在文字段落之間（觀測分頁的列、提問面板的來源框裡），
 *   不跟卡片的層次對齊。換成 stage 會在已經有框的地方再疊一層框。
 *
 * 最大高度由呼叫端用 `className` 給（各處能讓的空間不同），超過就在框裡捲。元素固定是 `pre`。
 * 新的這種小框用這個，不要再手寫整串（`design-system.test.ts` 會擋）。
 */
export function MonoBlock({ className, ...props }: ComponentProps<'pre'>) {
  return (
    <pre
      className={cn(
        'bg-chip min-w-0 overflow-auto rounded-lg p-2 font-mono text-tip break-words whitespace-pre-wrap',
        className,
      )}
      {...props}
    />
  );
}

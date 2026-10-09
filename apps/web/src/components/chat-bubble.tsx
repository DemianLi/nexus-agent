import type { ReactNode } from 'react';

import { Bubble, BubbleContent } from '@/components/ui/bubble';

/**
 * 對話區的文字泡泡（[#1280](https://github.com/DemianLi/nexus-agent/issues/1280)）：人的話、排著的插話、背景子代理寄來的話
 * 原本各寫一份 `rounded-3xl px-4 py-2.5 whitespace-pre-wrap`，其中子代理那份還是手寫的 `div`。
 *
 * - 底色走 registry `Bubble` 的 `secondary`（`--secondary` 與 `--chip` 同值），寬度、靠邊也照它：`w-fit`、最寬 80%。
 * - `align`：人的話靠右（`end`，預設），子代理寄來的話靠左（`start`）。
 * - 半透明這類狀態由呼叫端用 `className` 補（排著的插話是 `opacity-70`），加在外層 `Bubble` 上。
 *
 * 模型的回覆不是泡泡（`Bubble variant="ghost"`，markdown 照畫），不用這個。
 * 新的對話泡泡用這個，不要再手寫 `rounded-3xl px-4 py-2.5`（`design-system.test.ts` 會擋）。
 */
export function ChatBubble({
  align = 'end',
  className,
  children,
}: {
  readonly align?: 'start' | 'end';
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <Bubble variant="secondary" align={align} className={className}>
      <BubbleContent className="text-body rounded-3xl px-4 py-2.5 whitespace-pre-wrap">
        {children}
      </BubbleContent>
    </Bubble>
  );
}

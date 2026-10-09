/**
 * 一句話上「委派給誰」的標記（#328 第 2 項）：人的泡泡、還沒被領走的插話、排隊列上那一件都畫同一顆。
 * 跟輸入框上方那顆（`agent-mention-chip.tsx`）同款（outline badge＋機器人圖示），差在這顆是唯讀的、寫的是「委派給 名字」。
 * `text` 不含點名字樣，所以標記一律從 `mention` 畫。
 */

import { Bot } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export function delegatedLabel(name: string): string {
  return `委派給 ${name}`;
}

export function DelegatedChip({
  name,
  className,
}: {
  readonly name: string;
  readonly className?: string;
}) {
  return (
    <Badge
      variant="outline"
      className={cn('h-6 max-w-full gap-1.5 px-2.5 text-tip', className)}
      data-testid="delegated-chip"
      title={delegatedLabel(name)}
    >
      <Bot aria-hidden />
      <span className="min-w-0 truncate">{delegatedLabel(name)}</span>
    </Badge>
  );
}

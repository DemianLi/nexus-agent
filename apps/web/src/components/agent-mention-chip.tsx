/**
 * 輸入框上方那顆「委派給誰」的標記（#328 第 2 項）：`@名字`、一顆整個刪掉的 ×。一句話最多一顆，所以不是一排。
 *
 * 刪法有三種，都是整顆刪：點 ×、焦點在輸入框且游標在最前面時按退格（`composer.tsx`）、再選一個別的取代它。
 * 外觀是 shadcn `badge`（outline）；這裡只決定放什麼、怎麼互動。
 */

import { Bot, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import type { MentionAgent } from '@/lib/agent-mention';

export function AgentMentionChip({
  agent,
  onRemove,
}: {
  readonly agent: MentionAgent;
  readonly onRemove: () => void;
}) {
  return (
    <Badge
      variant="outline"
      className="h-7 max-w-full gap-1.5 pr-1 pl-2.5 text-body"
      data-testid="agent-mention-chip"
      title={agent.description}
    >
      <Bot aria-hidden />
      <span className="min-w-0 truncate">@{agent.name}</span>
      <button
        type="button"
        aria-label={`取消委派給 ${agent.name}`}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex size-5 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 [&_svg]:size-3"
        onClick={onRemove}
      >
        <X aria-hidden />
      </button>
    </Badge>
  );
}

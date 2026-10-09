import { Archive } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { Surface } from '@/components/surface';
import { Button } from '@/components/ui/button';
import { ARCHIVED_BANNER_TEXT, ARCHIVED_RESTORE_LABEL } from '@/lib/archived-view';
import type { ThreadActionResult } from '@/lib/thread-management';

/**
 * 輸入框上方的封存橫幅（[#633](https://github.com/DemianLi/nexus-agent/issues/633)）：這條會話已封存，輸入框不給送（送出鈕停用，
 * 判斷在 `lib/archived-view.ts`），橫幅旁的「取消封存」是回到能講話的那一步。封存的會話仍可打開讀歷史。
 *
 * 輸入框擋住是**第一道**；伺服器端也擋（另一個分頁、歷史重播送進來的話會被當成「已擋下」的一輪，泡泡下標「已封存，這句話沒有送給模型」），
 * 兩道都要有。用詞與側欄的「已封存」、軌跡的「已擋下（會話已封存）」一致。
 */
export function ArchivedBanner({ onRestore }: { readonly onRestore: () => ThreadActionResult }) {
  const [pending, setPending] = useState(false);
  return (
    <Surface
      tone="docked"
      role="group"
      aria-label={ARCHIVED_BANNER_TEXT}
      data-testid="archived-banner"
      className="text-muted-foreground mb-2 flex min-w-0 items-center gap-2 px-3 py-2 text-tip"
    >
      <Archive aria-hidden className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">{ARCHIVED_BANNER_TEXT}</span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => {
          setPending(true);
          void onRestore().then(
            (message) => {
              setPending(false);
              if (message !== undefined) toast.error('取消封存失敗', { description: message });
            },
            (error: unknown) => {
              setPending(false);
              toast.error('取消封存失敗', {
                description: error instanceof Error ? error.message : String(error),
              });
            },
          );
        }}
      >
        {ARCHIVED_RESTORE_LABEL}
      </Button>
    </Surface>
  );
}

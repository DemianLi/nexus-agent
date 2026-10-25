import { Bot } from 'lucide-react';

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';

/**
 * 空白狀態（inventory 列 7）：還沒有任何一則、也沒有待決的時候畫這個。外觀是 SG 的 `Empty`（#1695 E1-C），
 * 字級跟著 SG（#1688 G1）。`EmptyTitle` 是 `div`，所以補 `role="heading"`、`aria-level={2}`，報讀器照樣跳得到。
 * 圖示是靜態的：會動的點在 nexus 表示這一輪正在跑，放在待命畫面上會說謊。
 * 原型那排建議按鈕沒搬：那是假資料，nexus 沒有可以建議的東西。
 */
export function EmptyHero() {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Bot aria-hidden />
        </EmptyMedia>
        <EmptyTitle role="heading" aria-level={2}>
          今天要做什麼？
        </EmptyTitle>
        <EmptyDescription>在下面打字，或把檔案拖進來。</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

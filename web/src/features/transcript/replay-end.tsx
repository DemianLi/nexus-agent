/**
 * 重播內容結尾那一條分隔線（[#3054](https://github.com/DemianLi/nexus-agent/issues/3054)）：這條對話之前的內容從日誌重播到哪裡為止。
 * 對話區上方不另寫一段話講「接著上一次」「切過來」「分出來」「舊格式」，由這條線的位置與它上面的字講。
 *
 * - **接續、切換**同一條線，標籤是上一次的時間（{@link formatLastActivity}）；不知道時間就只畫線。`recalled` 這一端分不出是接回來還是新開的
 *   （`remembered-thread.ts`）：新開的沒有重播條目，就不畫線。
 * - **分叉**：分支圖示＋「從〈原標題〉分出」，原標題連回原對話；連結本身說明原本那條還在。
 * - **舊格式**：線上寫 {@link LEGACY_REPLAY_TEXT}，那是畫面上看不出來的事（模型不記得）。
 *
 * 線畫在哪一格之後由 {@link replayEndIndex} 算，重播了哪幾則由 {@link useReplayedIds} 在第一頁歷史到的那一刻記下。
 *
 * @module
 */

import { GitBranch, TriangleAlert } from 'lucide-react';
import { useState } from 'react';

import type { ConversationEntry } from '@nexus/wire';

import type { GroupedItem } from '@/features/transcript/tool-runs';

/** 舊格式（格式 9 以前寫的，#306）的會話：日誌不記模型的回覆，模型推不回之前的對話，從空的開始。 */
export const LEGACY_REPLAY_TEXT = '舊格式，模型不記得以上內容';

/** 接續、切換那條線的無障礙名稱開頭；後面接「，最後一次是 …」（知道時間的話）。 */
export const REPLAY_END_LABEL = '以上是之前的對話';

/** 分叉來源沒有標題時，連結上的字。 */
export const FORK_SOURCE_FALLBACK = '原對話';

/** 結尾那條線畫哪一種。 */
export type ReplayEnd =
  | { readonly kind: 'resumed'; readonly lastActivity?: string }
  | {
      readonly kind: 'forked';
      readonly sourceTitle?: string;
      /** 切回分叉來源那一條。 */
      readonly onOpenSource: () => void;
    }
  | { readonly kind: 'legacy' };

const TIME_FORMAT = new Intl.DateTimeFormat('zh-TW', { dateStyle: 'short', timeStyle: 'short' });

/** 上一次的時間，寫法同側欄清單那一列。 */
export function formatLastActivity(epochMs: number): string {
  return TIME_FORMAT.format(epochMs);
}

/** 兩邊的細線，不給讀屏：名稱在外面那一格。 */
function Rule() {
  return <span aria-hidden className="bg-border h-px min-w-6 flex-1" />;
}

/**
 * 結尾那條線。分叉那一種裡面有連結，**不掛 `role="separator"`**：separator 的子元素是 presentational，連結會被吃掉；
 * 那一行的字讀屏照常唸得到。其餘兩種掛 separator，字放在 `aria-label`。
 */
export function ReplayEndDivider({ end }: { end: ReplayEnd }) {
  const row = 'text-muted-foreground flex min-w-0 items-center gap-2 text-tip';
  if (end.kind === 'forked') {
    return (
      <p className={row} data-testid="replay-end">
        <Rule />
        <GitBranch aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">
          從
          <button
            type="button"
            className="hover:text-foreground mx-1 underline underline-offset-2"
            onClick={end.onOpenSource}
          >
            {end.sourceTitle ?? FORK_SOURCE_FALLBACK}
          </button>
          分出
        </span>
        <Rule />
      </p>
    );
  }
  if (end.kind === 'legacy') {
    return (
      <div
        role="separator"
        aria-label={LEGACY_REPLAY_TEXT}
        className={row}
        data-testid="replay-end"
      >
        <Rule />
        <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
        <span>{LEGACY_REPLAY_TEXT}</span>
        <Rule />
      </div>
    );
  }
  const label =
    end.lastActivity === undefined
      ? REPLAY_END_LABEL
      : `${REPLAY_END_LABEL}，最後一次是 ${end.lastActivity}`;
  return (
    <div role="separator" aria-label={label} className={row} data-testid="replay-end">
      <Rule />
      {end.lastActivity !== undefined && <span>{end.lastActivity}</span>}
      {end.lastActivity !== undefined && <Rule />}
    </div>
  );
}

/**
 * 第一頁歷史到的那一刻，條目裡有哪幾則；之前都是 `undefined`。**只記第一次**：重接時折疊器從空的重折，那時已經多了
 * 這次開著時長出來的，記下去的話線就跑到最後面。訊息 id 在歷史與即時兩側是同一個，所以重折之後照樣對得上；往前翻接在
 * 前面的不在這份裡，也不影響線畫在哪。
 */
export function useReplayedIds(
  historyReady: boolean,
  entries: readonly ConversationEntry[],
): ReadonlySet<string> | undefined {
  const [ids, setIds] = useState<ReadonlySet<string> | undefined>(undefined);
  if (ids === undefined && historyReady) {
    const captured = new Set(entries.map((entry) => entry.id));
    setIds(captured);
    return captured;
  }
  return ids;
}

/**
 * 線畫在哪一格之後：最後一格帶著重播條目的訊息或工具段；緊接在它後面的改動卡、交付卡屬於同一輪的尾端，跳過去畫在它們
 * 下面。沒有重播的條目（空的對話）回 `undefined`。
 */
export function replayEndIndex(
  grouped: readonly GroupedItem[],
  replayed: ReadonlySet<string>,
): number | undefined {
  let last: number | undefined;
  grouped.forEach((item, index) => {
    const entries =
      item.kind === 'entry' ? [item.entry] : item.kind === 'tool-run' ? item.entries : [];
    if (entries.some((entry) => replayed.has(entry.id))) last = index;
  });
  if (last === undefined) return undefined;
  while (
    last + 1 < grouped.length &&
    (grouped[last + 1]!.kind === 'changes' || grouped[last + 1]!.kind === 'deliverables')
  )
    last += 1;
  return last;
}

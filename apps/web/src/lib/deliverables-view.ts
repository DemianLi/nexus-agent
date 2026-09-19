/**
 * 對話列表上一格一格要畫什麼：交付卡片歸到它那一輪的尾端（[#441](https://github.com/DemianLi/nexus-agent/issues/441)
 * 第二刀）。
 *
 * 折疊器把交付事件放在它在串流裡的位置（`DeliverablesEntry`），通常夾在 `present` 工具卡與模型最後那段話之間。
 * dsh 把交付畫在收尾那一輪的尾端（`conversation.chat.turnTail`），所以這裡把同一輪的交付收攏成一張卡，放在這一輪
 * 最後一格之後。**切輪看 human 那一格，不看 `turnTail`**：只有工具、沒有文字的輪沒有輪尾，照樣要有地方掛卡。
 *
 * 人答的問題（`answer`）不自成一格，照舊略過（答案列在提問卡上）。
 *
 * @module
 */

import type { ConversationEntry, WirePresentedFile } from '@nexus/wire';

export type TranscriptItem =
  | { readonly kind: 'entry'; readonly id: string; readonly entry: ConversationEntry }
  | {
      readonly kind: 'deliverables';
      /** 這一輪第一顆交付的 id：跟 `entries` 裡那一格同一個，所以進場動效認得出它是新長出來的。 */
      readonly id: string;
      readonly files: readonly WirePresentedFile[];
    };

export function transcriptItems(entries: readonly ConversationEntry[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let id: string | undefined;
  let files: WirePresentedFile[] = [];
  const flush = () => {
    if (id !== undefined) items.push({ kind: 'deliverables', id, files });
    id = undefined;
    files = [];
  };
  for (const entry of entries) {
    // 改動卡還沒做（#443，dev-ui）：先不給它一格，不然列表會多出一段空白間距。
    if (entry.kind === 'answer' || entry.kind === 'workspace-changes') continue;
    if (entry.kind === 'deliverables') {
      id ??= entry.id;
      files.push(...entry.files);
      continue;
    }
    if (entry.kind === 'human') flush();
    items.push({ kind: 'entry', id: entry.id, entry });
  }
  flush();
  return items;
}

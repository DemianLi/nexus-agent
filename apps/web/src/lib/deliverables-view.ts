/**
 * 對話列表上一格一格要畫什麼：改動卡與交付卡片歸到它那一輪的尾端（[#441](https://github.com/DemianLi/nexus-agent/issues/441)
 * 第二刀）。
 *
 * 折疊器把交付事件放在它在串流裡的位置（`DeliverablesEntry`），通常夾在 `present` 工具卡與模型最後那段話之間。
 * dsh 把交付畫在收尾那一輪的尾端（`conversation.chat.turnTail`），所以這裡把同一輪的交付收攏成一張卡，放在這一輪
 * 最後一格之後。**切輪看 human 那一格，不看 `turnTail`**：只有工具、沒有文字的輪沒有輪尾，照樣要有地方掛卡。
 *
 * 改動紀錄（`WorkspaceChangesEntry`，[#443](https://github.com/DemianLi/nexus-agent/issues/443)）也歸到輪尾，**排在交付卡前面**
 * （#443 決議 4，同 dsh `Deliverables` 先畫 `ChangedFiles`）。它只帶 `seq`，摘要由卡片自己去讀；通常一輪一顆，萬一有兩顆
 * 就各畫一張。
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
    }
  | {
      readonly kind: 'changes';
      /** 就是 `entries` 裡那一格的 id（`workspace-changes:<seq>`）。 */
      readonly id: string;
      readonly seq: number;
    };

export function transcriptItems(entries: readonly ConversationEntry[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let id: string | undefined;
  let files: WirePresentedFile[] = [];
  let changes: TranscriptItem[] = [];
  const flush = () => {
    items.push(...changes);
    if (id !== undefined) items.push({ kind: 'deliverables', id, files });
    id = undefined;
    files = [];
    changes = [];
  };
  for (const entry of entries) {
    if (entry.kind === 'answer') continue;
    if (entry.kind === 'workspace-changes') {
      changes.push({ kind: 'changes', id: entry.id, seq: entry.seq });
      continue;
    }
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

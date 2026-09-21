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
 * **合併會打散座標，所以每個檔案自己記著**（[#452](https://github.com/DemianLi/nexus-agent/issues/452)）：見
 * {@link LocatedFile}。把一輪的交付收攏成一張卡是畫面的決定，而讀檔路由要的是「哪一顆事件的第幾個檔」。
 *
 * @module
 */

import type { ConversationEntry, WirePresentedFile } from '@nexus/wire';

/**
 * 一個宣告交付的檔案，連同它在讀檔路由上的座標（[#452](https://github.com/DemianLi/nexus-agent/issues/452)）。
 *
 * **座標掛在每個檔案上，不掛在卡片上**：一張交付卡是同一輪多顆交付事件合併出來的，卡裡的檔案可能
 * 來自不同的 `seq`。隔壁改動卡那種「卡片一個 `seq`、位置用列表位置」的形狀（`ChangesCard`）在這裡
 * 表達不出來。
 */
export interface LocatedFile extends WirePresentedFile {
  /** 宣告它那顆 `deliverables/presented` 在 root 日誌裡的 `seq`。 */
  readonly seq: number;
  /**
   * 它在**那次宣告**的 `files` 裡的位置。
   *
   * **不是它在這張卡裡的位置**——合併之後兩者會分岔，而讀檔路由收的是前者。畫列表時不要拿 `map` 的
   * 那個索引頂替它。
   */
  readonly index: number;
}

export type TranscriptItem =
  | { readonly kind: 'entry'; readonly id: string; readonly entry: ConversationEntry }
  | {
      readonly kind: 'deliverables';
      /** 這一輪第一顆交付的 id：跟 `entries` 裡那一格同一個，所以進場動效認得出它是新長出來的。 */
      readonly id: string;
      readonly files: readonly LocatedFile[];
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
  let files: LocatedFile[] = [];
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
      // **座標在這裡定死**：`index` 取的是它在這一顆事件裡的位置，不是合併之後的位置。合併是畫面的事，
      // 讀檔路由收的是宣告當下那組座標（#452）。
      files.push(...entry.files.map((file, index) => ({ ...file, seq: entry.seq, index })));
      continue;
    }
    if (entry.kind === 'human') flush();
    items.push({ kind: 'entry', id: entry.id, entry });
  }
  flush();
  return items;
}

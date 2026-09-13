/**
 * 評分與 `/feedback` 在畫面這一側的詞彙與判法（[#278](https://github.com/DemianLi/nexus-agent/issues/278)）。
 *
 * 文字照 dsh 的 `zh` 字典（`packages/client/ui-message-feedback/src/client/locales.ts`，`c291e79`）
 * 轉繁體台灣用語。**對話框提示只留前半句**：「提交內容會包括當前對話的日誌」只有遙測開在 `full` 或
 * `feedback-only` 時才是真的，而預設沒掛遙測。dsh 這一句無條件顯示；依模式顯示得多一條 server 把
 * 模式送到畫面的協定，#279 拍板不做、登記成偏離。說了就是騙人按送出（#267 的 Q11）。
 * `error.load` 那一句沒有搬：我們沒有 `list`，沒有東西要載入。
 */

import type { ConversationEntry, ConversationState, WireFeedbackCategory } from '@nexus/wire';

/** 只打這一行時開對話框，不送 `slash.run`（照 dsh 的 `/feedback` 裝飾）。 */
export const FEEDBACK_COMMAND_LINE = '/feedback';

export const FEEDBACK_COPY = {
  like: '好的回答',
  likeActive: '取消標記',
  dislike: '有問題的回答',
  dislikeActive: '取消標記',
  title: '提交回饋',
  categories: '回饋分類',
  detail: '回饋詳情',
  hint: '填寫詳情以幫助我們改善體驗',
  submit: '提交',
  submitting: '正在提交…',
  close: '關閉',
  recorded: '感謝你的回饋',
  conflict: '這則回饋已在別處改動，已顯示最新狀態',
  generic: '回饋儲存失敗',
  noteTooLarge: '描述太長，請縮短後再提交',
} as const;

/**
 * 七個分類的顯示文字，**依畫面呈現的順序**。
 *
 * 照 dsh 在瀏覽器那一側的做法：分類在這裡重寫一份完整的表，而 `satisfies` 逼它跟線上那份一個不多、
 * 一個不少——少一類或多一類都當場編不過（`FeedbackDialog.tsx` 的 `CATEGORY_CHIPS`）。
 */
export const CATEGORY_LABEL = {
  'task-result': '任務結果',
  'instruction-following': '指令理解與遵循',
  'product-interaction': '產品功能與互動',
  'service-stability': '穩定性和速度',
  'resource-cost': '資源使用與費用',
  'security-privacy-permission': '安全隱私與權限',
  other: '其他',
} as const satisfies Record<WireFeedbackCategory, string>;

export const CATEGORIES = Object.keys(CATEGORY_LABEL) as WireFeedbackCategory[];

/**
 * 一個失敗碼在畫面上說的話。有專屬文字的只有兩個（同 dsh 的 `FAILURE_COPY`），其餘講通用那句。
 *
 * @param code - server 回的業務碼。
 * @returns 那一句。
 */
export function failureCopy(code: string): string {
  if (code === 'version-conflict') return FEEDBACK_COPY.conflict;
  if (code === 'note-too-large') return FEEDBACK_COPY.noteTooLarge;
  return FEEDBACK_COPY.generic;
}

/**
 * 哪幾則回覆長評分按鈕：**每一次 run 收尾時，那一段裡最後一則有文字的 root 回覆**（#267 的 Q7）。
 *
 * - 「一次 run」從狀態進 `running` 算起：人送一句話、人答了核准卡、續行驅動器排了一輪，都是。
 *   **不靠使用者那一則切段**——續行那幾輪在畫面上沒有使用者的話。
 * - 收尾是 `idle`、`stopped`、`failed`。**停在核准點不是收尾**：那一段的回覆不長按鈕，續接之後才算
 *   （續接時重新起算，所以按鈕只在續接後那則上）。停在核准點時按停止是收尾，那時算的是停下之前那段。
 * - 子代理那幾則、串流中的、整段只有工具的，都沒有。
 */
export interface ReplyTails {
  /** 長按鈕的回覆 id（`AiEntry.id`）。 */
  readonly ids: ReadonlySet<string>;
  /** 目前這一次 run 從 `entries` 的哪一格開始。 */
  readonly runStart: number;
}

export const NO_REPLY_TAILS: ReplyTails = { ids: new Set(), runStart: 0 };

function isTailCandidate(entry: ConversationEntry): boolean {
  return (
    entry.kind === 'ai' &&
    entry.attribution.kind === 'root' &&
    entry.text !== '' &&
    !entry.streaming
  );
}

/**
 * 狀態每走一步，算一次收尾那則。**要一步一步餵**：一批 frame 裡「跑起來又收掉」只看頭尾的話，
 * 中間那次 `running` 會被吃掉。
 *
 * @param previous - 這一步之前的狀態。
 * @param next - 這一步之後的狀態。
 * @param tails - 目前為止的結果。
 * @returns 新的結果；沒有變化時原樣回傳同一個物件。
 */
export function trackReplyTails(
  previous: ConversationState,
  next: ConversationState,
  tails: ReplyTails,
): ReplyTails {
  if (next.status === 'running' && previous.status !== 'running') {
    return { ids: tails.ids, runStart: previous.entries.length };
  }
  const wasActive = previous.status === 'running' || previous.status === 'awaiting-input';
  const ended = next.status === 'idle' || next.status === 'stopped' || next.status === 'failed';
  if (!wasActive || !ended) return tails;
  let tail: ConversationEntry | undefined;
  for (let at = next.entries.length - 1; at >= tails.runStart; at -= 1) {
    const entry = next.entries[at];
    if (entry !== undefined && isTailCandidate(entry)) {
      tail = entry;
      break;
    }
  }
  if (tail === undefined) return { ids: tails.ids, runStart: next.entries.length };
  return { ids: new Set([...tails.ids, tail.id]), runStart: next.entries.length };
}

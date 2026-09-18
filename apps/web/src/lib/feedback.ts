/**
 * 評分與 `/feedback` 在畫面這一側的詞彙與判法（[#278](https://github.com/DemianLi/nexus-agent/issues/278)）。
 *
 * 文字照 dsh 的 `zh` 字典（`packages/client/ui-message-feedback/src/client/locales.ts`，`c291e79`）
 * 轉繁體台灣用語。**對話框提示只留前半句**：「提交內容會包括當前對話的日誌」只有遙測開在 `full` 或
 * `feedback-only` 時才是真的，而預設沒掛遙測。dsh 這一句無條件顯示；依模式顯示得多一條 server 把
 * 模式送到畫面的協定，#279 拍板不做、登記成偏離。說了就是騙人按送出（#267 的 Q11）。
 *
 * 放哪幾則由折疊器的 `AiEntry.turnTail` 決定（`@nexus/wire`），讀回與修改的次序在 `feedback-ratings.ts`
 * （[#382](https://github.com/DemianLi/nexus-agent/issues/382)）。
 */

import type { AiEntry, WireFeedbackCategory } from '@nexus/wire';

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
  load: '回饋狀態載入失敗',
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
 * 這則回覆長不長讚踩：**那一輪收尾的那則**（`turnTail`，同 dsh 的 `TurnTailNodeView`），而且指名得到
 * （有 `messageId`）。**講到一半被停下來的那則不長**：dsh 凍結的半段沒有 `messageId`，那一輪就沒有按鈕。
 *
 * @param entry - 一則回覆。
 * @returns 要不要畫讚踩。
 */
export function isRatable(entry: AiEntry): entry is AiEntry & { readonly messageId: string } {
  return entry.turnTail === true && entry.messageId !== undefined && entry.stopped !== true;
}

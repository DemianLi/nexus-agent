/**
 * 附件相關的失敗。自己一個模組：儲存、規範化與請求圖都拋它，放在儲存裡會讓三者互相 import。
 *
 * @module
 */

/** 附件相關的失敗；`code` 是穩定的，呼叫端據此分類。 */
export class AttachmentError extends Error {
  readonly code: AttachmentErrorCode;
  constructor(message: string, code: AttachmentErrorCode, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AttachmentError';
    this.code = code;
  }
}

export type AttachmentErrorCode =
  | 'INVALID_ATTACHMENT_REF'
  | 'ATTACHMENT_TOO_LARGE'
  | 'ATTACHMENT_STORE_FAILED'
  /** 物件的內容對不上它的雜湊（被換過、損毀、截斷）；讀與去重都會驗。 */
  | 'ATTACHMENT_CORRUPT';

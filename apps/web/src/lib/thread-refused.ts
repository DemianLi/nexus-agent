/**
 * 下行被伺服器拒絕、碼沒有專用文案時給使用者看的那一句（[#2222](https://github.com/DemianLi/nexus-agent/issues/2222)）。
 *
 * **不顯示 server 的 message**：`unknown_error` 的 message 帶例外原文，可能含主機路徑；`invalid_argument`、`not_supported` 講的是協定用語。
 * 新 server 送來這一版不認得的碼也走這一句。**當暫時的**：分不出重試有沒有用，重試照舊（`hooks/use-conversation.ts`）。
 *
 * @module
 */

/** 伺服器沒有開這條對話，原因不明。說還在重試與下一步；不提碼、路徑或 serve 的用語。 */
export const THREAD_REFUSED_TEXT = '伺服器這次沒有開這條對話，正在重試。一直打不開請聯絡管理者。';

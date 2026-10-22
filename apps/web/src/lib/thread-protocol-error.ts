/**
 * 下行或歷史頁送來看不懂的資料（`WireProtocolError`，[#1555](https://github.com/DemianLi/nexus-agent/issues/1555) `N0758`）時，
 * 狀態列給使用者看的那一句（[#1601](https://github.com/DemianLi/nexus-agent/issues/1601)）。
 *
 * **不顯示錯誤原文**：`field` 與 `message` 是給管理者查的，原文只進 `console.warn`。**不自動重連**：歷史裡的壞資料每次重連都抓到
 * 同一份，照 dsh 的錯誤分類（`session-controller/README.md:54`：協定錯誤終止串流，只有載體斷了才自動續接），要人按「立刻重連」。
 *
 * @module
 */

/** 伺服器送來的資料形狀不對，已經不再自動重連；旁邊有「立刻重連」。 */
export const THREAD_PROTOCOL_ERROR_TEXT = '伺服器送來看不懂的資料，已停止自動重連';

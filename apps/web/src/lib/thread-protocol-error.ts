/**
 * 下行或歷史頁送來看不懂的資料（`WireProtocolError`，[#1555](https://github.com/DemianLi/nexus-agent/issues/1555) `N0758`）時，
 * 給使用者看的話：開線時狀態列那一句（[#1601](https://github.com/DemianLi/nexus-agent/issues/1601)），往前讀歷史時按鈕旁
 * 與計劃分頁那一句（[#1866](https://github.com/DemianLi/nexus-agent/issues/1866)）。
 *
 * **不顯示錯誤原文**：`field` 與 `message` 是給管理者查的，原文只進 console（開線時 `console.warn`，往前讀時照 dsh `loadOlder`
 * 用 `console.error`）。開線時**不自動重連**：歷史裡的壞資料每次重連都抓到同一份，照 dsh 的錯誤分類（`packages/api/session-controller/README.md:54`：
 * 協定錯誤終止串流，只有載體斷了才自動續接），要人按「立刻重連」。往前讀時不停什麼，再按一次照樣讀。
 *
 * @module
 */

/** 伺服器送來的資料形狀不對，已經不再自動重連；旁邊有「立刻重連」。 */
export const THREAD_PROTOCOL_ERROR_TEXT = '伺服器送來看不懂的資料，已停止自動重連';

/**
 * 往前讀歷史（「載入更早的」、跳到某一輪、計劃分頁的掃描）碰到看不懂的資料時，接在「讀不到更早的對話：」「讀不到這份計劃：」
 * 後面的那一句。**不帶「已停止自動重連」**：往前翻沒有停，再按一次照樣會讀（同 dsh `loadOlder` 失敗後按鈕照常）。原文只進
 * `console.error`。
 */
export const THREAD_PROTOCOL_ERROR_PAGE_TEXT = '伺服器送來看不懂的資料';

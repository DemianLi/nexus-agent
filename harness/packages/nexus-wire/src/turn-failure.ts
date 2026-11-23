/**
 * 一輪失敗上線那句話的規則（[#1844](https://github.com/DemianLi/nexus-agent/issues/1844)）。
 * 放在 wire：harness 寫 `turn/failed` 與讀舊日誌的兩端（歷史、軌跡）都要同一句。
 */

/** 供應商拒絕憑證（401／403）的碼，見 {@link AUTH_FAILURE_MESSAGE}。 */
export const AUTH_FAILURE_CODE = 'AUTH';
/** {@link AUTH_FAILURE_CODE} 給使用者的那句。供應商的原話可能帶部分金鑰，不給使用者看，只進伺服器日誌或 CLI 的 stderr。 */
export const AUTH_FAILURE_MESSAGE = '模型服務的憑證被拒絕，請管理者檢查金鑰設定。';

/**
 * 一顆 `turn/failed` 上線的那句。舊日誌的 `AUTH` 存的是供應商原話，讀的時候換掉。
 *
 * @param message - `turn/failed.message`。
 * @param code - `turn/failed.error.code`，舊日誌可能沒有。
 * @returns 可以上線的那句。
 */
export function turnFailureText(message: string, code: string | undefined): string {
  return code === AUTH_FAILURE_CODE ? AUTH_FAILURE_MESSAGE : message;
}

/**
 * `log-derived-history.test.ts` 那一套場景與斷言，以 `history-source=log` 跑（[#2355](https://github.com/DemianLi/nexus-agent/issues/2355)）：
 * 送出去的是日誌推出來的那一串。切換點見夾具的 `HISTORY_SOURCE_UNDER_TEST`。
 *
 * 環境變數要在夾具載入之前設好，所以用動態 import。
 */

export {};

process.env['NEXUS_LDH_HISTORY_SOURCE'] = 'log';
try {
  await import('./log-derived-history.test.js');
} finally {
  // 夾具在載入時就讀完了。關掉隔離（`--no-isolate`）時同一個行程會跑下一個測試檔，不清掉的話那一份也會跑成 `log`。
  delete process.env['NEXUS_LDH_HISTORY_SOURCE'];
}

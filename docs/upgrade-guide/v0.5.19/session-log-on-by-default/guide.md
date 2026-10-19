---
kind: upgrade-guide
description: 沒給 --session-log 時不再只放記憶體，會話日誌預設寫進 home 的 sessions/。
---

# 會話日誌預設落盤

## 變更

v0.5.19 的 `serve` 與 CLI 不給 `--session-log` 就只把會話放在記憶體裡，重啟就沒了。新版（PR #607）預設寫到
`$NEXUS_AGENT_HOME/sessions`（沒設就是 `~/.nexus-agent/sessions`），`--session-log <目錄>` 改成「換一個位置」。
落盤之後，上傳的附件、過大的工具結果原文、不變量量測記錄也跟著寫進 home。

受影響的：沒給 `--session-log`、而且不希望對話留在磁碟上的主機。整台主機所有使用者的對話都會落盤。

## 遷移

1. 要落盤（建議）：不用動，確認 home 所在的磁碟放得下，並照 [`docs/operations.md`〈升級與回滾〉](../../../operations.md#升級與回滾)
   把 home 納入備份。
2. 要維持只放記憶體：在清單上把 `session-persistence` 那一列停用（`plugin disable session-persistence`，或在 `--patch`
   覆寫檔寫 `- id: session-persistence` 加 `disabled: true`）。
3. 確認：啟動輸出的 `會話日誌：<目錄>` 是你要的位置；停用時是 `會話日誌：只在記憶體裡（…）`。

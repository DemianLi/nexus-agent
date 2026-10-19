---
kind: upgrade-guide
description: tool-text 的 maxBytes 不再截工具結果文字，改管 meta 與壓縮摘要；要限制工具結果大小改用 spill-policy 的 maxInlineTokens。
---

# `tool-text.maxBytes` 換了管的東西

## 變更

v0.5.19 的 `tool-text` 那一列只有 `maxBytes`（預設 50000），管的是**工具結果文字放上線之前截到多少位元組**：網頁工具卡與重播看到的文字超過就取頭尾、
中間一句說明。模型看到的不受它管。

新版名字與預設值沒變，管的東西換了（外溢層 PR #810、#812；收掉傳輸截斷 PR #923；壓縮摘要上線 PR #901）：

- **管**：工具結果的 `meta`（搜尋與改檔的上限就是 `maxBytes`，讀檔是兩倍）與壓縮摘要全文放上線的位元組上限。
- **不管工具結果文字**。文字的上限移到模型面，由新的 `spill-policy` 那一列決定：一則結果超過 `maxInlineTokens`（出廠 12500 估算 token）
  就把全文存進 home 底下的 `tool-results/`（`tool-result-stash` 那一列，保留 30 天），模型與畫面都只收頭尾預覽加路徑，日誌記的也是預覽。

所以 v0.5.19 為了縮小畫面上的工具結果而調小 `maxBytes` 的設定，升級後**沒有作用**，也不會有警告；調大的也一樣。

受影響的：所有主機——模型與畫面收到的工具結果文字都改由 `spill-policy` 決定（出廠值與怎麼調見 `default-plugin-additions` 那份指南）。
在 home 的 `cordis.patch.yml` 或 `--patch` 覆寫檔裡改過 `tool-text` 的 `maxBytes` 的主機，另外要知道那個設定升級後不再管文字。

## 遷移

1. 原本想限制工具結果大小的，改寫 `spill-policy` 的 `maxInlineTokens`（`plugin config set spill-policy --file -` 或 `--patch`）。
   它的單位是估算 token，不是位元組。`tool-text.maxBytes` 留著無害，可以刪掉。
2. 全文會落在 `<home>/tool-results/`，備份與存放策略照 [`docs/operations.md`〈升級與回滾〉](../../../operations.md#升級與回滾) 的 home 表；
   要改位置或保留天數，改 `tool-result-stash` 的 `root`、`cleanupPeriodDays`。
3. 確認：`--dump-config` 的 `spill-policy` 那一列是你要的值。

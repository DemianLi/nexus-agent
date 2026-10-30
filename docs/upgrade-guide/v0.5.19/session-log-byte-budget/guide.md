---
kind: upgrade-guide
description: 會話日誌太大、這個行程放不下時，serve 與 CLI 在讀之前就拒收那一條，不再讀到整個行程被殺。
---

# 太大的會話日誌在讀之前拒收

## 變更

v0.5.19 打開一條 thread（續接、讀歷史、列表、`@` 引用、內容搜尋）都會把它的日誌整份讀進記憶體，不看大小。日誌大到行程
放不下時，整個行程被殺：`serve` 上所有人的 thread 一起斷。實測打開一條 thread 的記憶體約是日誌大小的 5 到 6 倍，1g
容器裡 506 MiB 的日誌就會讓 `serve` 被 cgroup 殺掉（[#2115](https://github.com/DemianLi/nexus-agent/issues/2115)）。

新版有一份**會話日誌額度**，整個行程共用：

- **續接**一條 thread 佔它日誌大小那麼多，佔到這條 thread 撤出記憶體為止（只是唯讀正佔著時等它們讀完，不拒收）；**唯讀**（列表、`@` 引用、內容搜尋、背景子代理的冷檢查）讀完就還。
- 一份日誌單獨就超過額度，打開它回 `unknown_error`，訊息是「會話 "…" 的日誌有 … MiB，超過這個行程能收的 … MiB，沒有讀它」與下一步。
  額度被其他開著的大 thread 佔滿時，訊息改說要等它們關掉。檔案不動、沒有壞。
- 列表照樣列得出這條，只是沒有標題；`@` 引用候選與內容搜尋不列它。
- 額度出廠在 `serve` 起動時（CLI 在第一次續接時）從記憶體上限算出來：`min((記憶體上限 − 起動時 RSS) ÷ 7, (heap 上限 − 已用) ÷ 5)`。記憶體上限是
  容器或 systemd 的上限（`process.constrainedMemory()`），沒有就是主機總量；heap 上限跟著 `--max-old-space-size`。1g 容器約 110 MiB，
  4g 約 540 MiB。`serve` 的啟動輸出多一行 `會話日誌額度：…`。要固定或關掉，寫 `thread-capacity` 那一列新的 `sessionLogBudgetMiB`（正整數是 MiB，`0` 是不限）；
  `serve` 與 CLI 讀同一格。

受影響的：有很大的 thread 的主機。今天打得開、但日誌超過額度的 thread 升上來之後會被拒收：例如 4g 容器裡約 540 MiB 以上的（578 MiB 的小行日誌今天在 4g 開得起來，峰值約 3.4 GiB）。

## 遷移

1. 要新的預設：不用動。
2. 要打開某一條被拒收的 thread，建議的做法是給這個行程更多記憶體：調高容器或 systemd 的 `MemoryMax`，`--max-old-space-size` 照
   [`docs/operations.md`](../../../operations.md) 〈用 systemd 常駐〉的 70% 跟著調，然後重啟 `serve`。CLI 照 `NODE_OPTIONS=--max-old-space-size=…` 與它所在容器的上限算。
3. 要回到 v0.5.19 不看大小的讀法，或固定成某個數：在 `--patch` 覆寫檔（或 `plugin config set thread-capacity --file -`）的 `thread-capacity`
   那一列寫 `sessionLogBudgetMiB`，`0` 是不限、正整數是 MiB，重啟 `serve`（CLI 用同一份 `--patch`，下一次執行就生效）。`config` 是整份替換，但沒寫的 `maxThreads`、`idleEvictAfterMs` 由 schema 補出廠值：

   ```yaml
   - id: thread-capacity
     config:
       sessionLogBudgetMiB: 0
   ```

   設 0 或調得比自動算的大，就是拿掉這一道保護：大日誌會像 v0.5.19 一樣把整個行程撐死。
4. 確認：`serve` 啟動輸出的 `會話日誌額度：…` 是你要的值（CLI 不印這一行，直接 `--resume` 那一條確認打得開），而且大於那條 thread 的日誌大小（`ls -l <會話根>/<專案格>/<thread id>.jsonl`）。

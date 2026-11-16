---
kind: upgrade-guide
description: "`process-model` 設成 `per-thread` 時，對話行程起來後 30 秒內沒回 `ready` 會被監督行程殺掉，那條 thread 的請求回「對話行程沒起來（stalled）」；以前沒有這個期限，會一直卡著。"
---

# per-thread 對話行程的起動期限

## 變更

只影響 `process-model` 設成 `per-thread`（`nexus-agent serve` 起 `nexus-supervisor`）的部署。`single`（預設）不受影響。

- **起動期限。**
  - 舊行為：`nexus-agent serve` 起的對話行程是不成對的，從起來到回 `ready` 之間沒有任何期限。載插件、建根的時候卡死的行程會一直佔著名額，那條 thread 的請求一直等不到。
  - 新行為：從監督行程 spawn 對話行程起算，超過 `--start-timeout-ms`（預設 30000）還沒讀到 `ready`，監督行程直接殺掉它，死因 `stalled`、稽核那一行帶 `error: "ready 之前逾時"`。已指派 thread 的，前台對那條 thread 的請求回 `unknown_error`，訊息是「thread "…" 的對話行程沒起來（stalled），原因記在監督行程的稽核檔。」；名額讓出來，下一個請求會起新的行程。
  - 預熱池裡的行程（`--warm`）同樣受限：逾時被殺、不回錯誤（沒有 thread），隔 `--front-restart-ms` 再補一個。一直起不來的會這樣一輪一輪重來。
- **設定。** `process-model` 的 `startTimeoutMs`（毫秒，`0` 不判）本來就能設，之前對 `nexus-agent serve` 沒有作用，現在有。

受影響的：
- 對話行程冷起動本來就超過 30 秒的部署（外掛很多、磁碟或 CPU 很慢的主機）：以前慢慢起得來，現在會被殺、請求失敗。
- 同時起很多條對話、主機很忙的部署：每個行程的期限從自己的 spawn 起算，主機忙到健康但慢的行程也可能超過期限被殺；請求失敗後再試又會起新的行程，讓主機更忙，一直重試會把這種狀況放大。對策是調大 `startTimeoutMs`。
- 在稽核檔或日誌裡比對對話行程死因的腳本：多了 `stalled` 搭 `ready 之前逾時` 這一種。

## 遷移

1. 看你的主機冷起動要多久：照 [#2852](https://github.com/DemianLi/nexus-agent/issues/2852) 留言裡的量測做法，或直接看 `apps/harness/src/per-thread.integration.test.ts` 的冷起動量測測試。
2. 起得比 30 秒慢的，把 `~/.nexus-agent/cordis.patch.yml` 的 `process-model` 加 `startTimeoutMs`，設成冷起動時間的數倍；想維持舊行為就設 `0`。
3. 要看有沒有行程被這個期限殺過，到 `$NEXUS_AGENT_HOME/supervisor-audit.jsonl` 找 `ready 之前逾時`。比對死因的腳本，把 `stalled` 加進「對話行程沒起來」的處理。
4. 確認改好：重啟 serve，開一條 thread，檢查它回 `up`。期限會不會生效不要靠把 `startTimeoutMs` 設得很小來驗：期限小到一輪的處理時間就超過它的一半時，監督行程每一輪都重算，可能一直不逾時。

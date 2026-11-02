---
kind: upgrade-guide
description: 對話建不起來時，unknown_error 的 message 不再帶原始錯誤與主機路徑，完整原因改寫在 serve 的日誌。
---

# 對話建不起來的原因改寫進 serve 的日誌

## 變更

v0.5.19 的 `serve` 上，一條對話建不起來而且沒有專用碼時，回 `unknown_error`，message 是「這條 thread 建不起來：」加原始錯誤。原始錯誤可能帶主機路徑或堆疊，而且 `serve` 的日誌沒有這一行。

新版（[#2225](https://github.com/DemianLi/nexus-agent/issues/2225)）的碼不變，message 固定是「這條 thread 建不起來，原因記在 serve 的日誌。」，不帶原始錯誤。完整原因寫在 `serve` 的日誌，警告等級，開頭是 `[thread] "<對話 id>" 建不起來：`。

這一條只管建對話那條路。有專用碼的情境（`thread_at_capacity`、`thread_writer_held`、`thread_root_mismatch`、`thread_history_too_deep` 這類）不變。

受影響的：解析 `unknown_error` 的 message 判斷原因的客戶端；靠 wire 回應或瀏覽器開發工具查原因的管理者。

## 遷移

1. 自己接 wire 的客戶端：不要解析這個 message，也不要拿它顯示原因，只顯示固定文案。
2. 管理者：查對話打不開的原因時，改看 `serve` 的日誌，搜尋 `[thread] "<對話 id>" 建不起來`。日誌門檻要在警告以下才看得到。
3. 確認：把一條對話的會話日誌 header 改壞再打開，回應的 message 是固定文案，日誌有 `建不起來：` 開頭的原因。

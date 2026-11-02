---
kind: upgrade-guide
description: serve 續接時工作區根對不上，錯誤碼從 unknown_error 改成 thread_root_mismatch，訊息不再帶主機路徑，兩個根改印在 serve 的日誌。
---

# 續接時可寫根對不上改回專用碼，訊息不帶主機路徑

## 變更

v0.5.19 的 `serve` 上，會話 header 記的工作區根跟這次的 `--workspace` 不同時，續接回 `unknown_error`，message 是「這條 thread 建不起來：」加上指名兩個根的全文，主機路徑會上線。

新版（[#2222](https://github.com/DemianLi/nexus-agent/issues/2222)）在這個情境回專用碼 `thread_root_mismatch`，HTTP 照舊 200。message 只寫是哪一份會話與出路，不帶主機路徑，也不帶「建不起來」。兩個根改印在 `serve` 的日誌。私有根在另一個 home 底下時，同樣回這個碼，message 寫要回原本的 home。

serve 沒有開這條 thread，日誌不動。重試沒用，要在原本的 home 或 `--workspace` 上才打得開。

受影響的：自己接 wire、認 `unknown_error` 或解析 message 裡路徑的客戶端；靠 wire 回應查根的管理者。CLI 的 `--resume` 不受影響，訊息照舊指名兩個根。

## 遷移

1. 自己接 wire 的客戶端：把 `thread_root_mismatch` 當永久失敗，不要重試，請使用者聯絡管理者。
2. 有解析 message 取路徑的，改去讀 `serve` 的日誌，訊息開頭是 `serve 接不回來：會話`。
3. 確認：用不同的 `--workspace` 或 `NEXUS_AGENT_HOME` 續接一條舊對話，回應的 `error` 是 `thread_root_mismatch`，message 裡沒有路徑，日誌有兩個根。

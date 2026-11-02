---
kind: upgrade-guide
description: 上傳、列表、搜尋等沒有專用碼的內部失敗，unknown_error 的 message 不再帶原始錯誤與主機路徑，完整原因改寫在 serve 的日誌。
---

# 其餘內部失敗的原因改寫進 serve 的日誌

## 變更

v0.5.19 的 `serve` 上，技能清單、評分寫入、上傳、讀圖、存圖、叫醒子代理、釘選封存、改名、分叉的來源、列 thread、搜尋、軌跡、列檔、列會話失敗時，回 `unknown_error`，message 帶原始錯誤。原始錯誤多半是 Node 的 fs 錯誤，帶主機路徑。

新版（[#2230](https://github.com/DemianLi/nexus-agent/issues/2230)）的碼不變，message 固定是「<做什麼>，原因記在 serve 的日誌」，例如「上傳沒存成，原因記在 serve 的日誌」。完整原因寫在 `serve` 的日誌，警告等級。

「評分紀錄壞了：…」不變，它的訊息只有事件序號與欄位規則。建對話那條路見 [`thread-build-failure-reason-in-log`](../thread-build-failure-reason-in-log/guide.md)。

受影響的：解析這些 message 判斷原因的客戶端；靠 wire 回應或瀏覽器開發工具查原因的管理者。

## 遷移

1. 自己接 wire 的客戶端：不要解析這些 message，只拿它顯示固定文案。
2. 管理者：查這些失敗的原因時，改看 `serve` 的日誌，標籤見 [`docs/operations.md`](../../../operations.md)。日誌門檻要在警告以下才看得到。
3. 確認：把 `thread-organization.json` 的上層目錄改成唯讀再釘選一條對話，回應是「釘選與封存沒做成，原因記在 serve 的日誌」，日誌有 `[thread] "<對話 id>" 釘選與封存沒做成：` 開頭的原因。

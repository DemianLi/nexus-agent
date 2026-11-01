---
kind: upgrade-guide
description: 用 /permission 切換核准政策之後，下一輪模型會多收到一則通知。
---

# 切換核准政策時模型會收到通知

## 變更

舊版用 `/permission` 切換權限組合時，模型只會從系統提示詞的政策句看到新狀態。新版（#2057）在核准政策真的變了時，於下一輪多送一則通知，例如
`使用者把核准政策從「詢問使用者核准」改成「不詢問使用者核准」。`，記成 `user/message`，來源是插件，不會顯示成使用者打的話。

政策沒變、起始值、續接時收回過寬組合，都不發。續接不重發；切完還沒發就重啟，下一輪照發一次。升級前的切換不補發：舊 thread 續接時，模型不會收到舊切換的通知。

受影響的：有比對模型輸入的測試或回放，或自己讀 `user/message` 的工具。日誌格式不變。

## 遷移

1. 不需要改任何設定。
2. 自己讀 `user/message` 的工具，把 `source.plugin` 是 `nexusApprovalPolicyNotice` 的那幾則當插件注入，不要當人話。
3. 確認：開一條對話，`/permission` 切到核准政策不同的一組，再送一句話；日誌裡多一顆 `source.plugin` 是 `nexusApprovalPolicyNotice` 的 `user/message`，對話畫面上看不到它。

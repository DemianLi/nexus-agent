# 追溯、觀測與成本方案：研究草稿（2026-10-04）

地圖 [#1015](https://github.com/DemianLi/nexus-agent/issues/1015) 把研究藍圖（[`../chat-agent-research/blueprint.md`](../chat-agent-research/blueprint.md)）的八個節點 T1–T8 轉成實作方案。這個目錄收的是開圖前的六路盤點，**方案本身以 #1015 與它的子票 #1016–#1035 為準**，這裡只是證據底稿。

| 檔案 | 內容 |
| --- | --- |
| [`r1-trace.md`](r1-trace.md) | nexus 追溯鏈盤點：日誌事件、缺哪些資料、T3／T4 對照 |
| [`r2-plugin.md`](r2-plugin.md) | 插件契約、插件到 web 的每一跳、新增日誌事件的絆索 |
| [`r3-dsh.md`](r3-dsh.md) | deepseek-harness 在這幾件事上的實際做法 |
| [`r4-t1256.md`](r4-t1256.md) | T1、T2、T5、T6 共 48 張藍圖卡的分類與八個待決題 |
| [`r5-eval-cost.md`](r5-eval-cost.md) | T7、T8 涵蓋、成本盤點、為什麼不畫金額 |
| [`r6-web.md`](r6-web.md) | web 側欄現況、兩種做法、分工與絆索測試 |

## 讀的時候要知道

- **六份都是子代理寫的**，只抽查過最承重的幾處（請求不落盤、側欄分頁是封閉聯集、圖發出的 `custom` frame 被丟、失敗呼叫不進帳、dsh 的 `request/header`／`system/message`／`approval/asked`／`assistant/attempt`），其餘沒有逐條核。引用行號前先對現行 develop。
- dsh 事實鎖在 SHA `5badb15`（預設分支 master，clone 會凍）。
- 內文提到的 `/private/tmp/...` 日誌與腳本是當時機器上的暫存，**已不在 repo 也不保證還在**；r1 裡「對真實日誌實跑」的結果是當時的輸出，不是可重現的指令。那份日誌是 v27 格式，不是現行程式的證據。
- 方案層的修正（例如卡與卡之間的矛盾、已被推翻的說法）發生在票上，這裡的草稿不會跟著改；兩邊不一致時以票為準。

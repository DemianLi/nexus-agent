---
kind: upgrade-guide
description: "`--agent-loop native` 撞到步數上限時，錯誤上的 `lc_error_code` 從 `GRAPH_RECURSION_LIMIT` 改成 `AGENT_STEP_LIMIT`，錯誤訊息不再接 LangChain 的排錯網址；CLI 退出碼仍是 2。"
---

# native 步數上限的錯誤碼改名

## 變更

只影響帶 `--agent-loop native` 的 CLI 與 serve。沒給 `--agent-loop`（預設 `langgraph`）的不受影響，那條路徑拋的仍是 LangGraph 自己的 `GRAPH_RECURSION_LIMIT`。

- **錯誤碼。**
  - 舊行為：native 撞到步數上限（`--recursion-limit` 或設定列的值）時，丟出的 `GraphRecursionError` 帶 `lc_error_code: 'GRAPH_RECURSION_LIMIT'`。
  - 新行為：帶 `lc_error_code: 'AGENT_STEP_LIMIT'`。類別名 `GraphRecursionError` 不變。
- **錯誤訊息。**
  - 舊行為：`Recursion limit of N reached without hitting a stop condition. …` 後面多接一段 `Troubleshooting URL: https://docs.langchain.com/oss/javascript/langgraph/GRAPH_RECURSION_LIMIT/`。這段會出現在 CLI 的 stderr 與 serve 的 `turn/failed.message`。
  - 新行為：只有前面那句，沒有排錯網址。
- **CLI 退出碼不變**：撞到上限仍是 2，兩個碼都認。

受影響的：
- 在行程內讀 `error.lc_error_code` 判斷「撞到步數上限」、而且只認 `GRAPH_RECURSION_LIMIT` 的外部程式；
- 比對 stderr 或 `turn/failed.message` 裡排錯網址的腳本。

認類別名 `GraphRecursionError` 或 CLI 退出碼 2 的不受影響。

## 遷移

1. 在你的程式裡搜尋 `GRAPH_RECURSION_LIMIT`：判斷式改成同時認 `GRAPH_RECURSION_LIMIT` 與 `AGENT_STEP_LIMIT`（`langgraph` 與 `native` 兩種 loop 都要處理時）。
2. 搜尋 `docs.langchain.com` 與 `Troubleshooting URL`：靠這段文字判斷的腳本，改成認訊息開頭的 `Recursion limit of`，或直接認退出碼 2。
3. 確認改好：用 `--agent-loop native --recursion-limit 1` 跑一個會用到工具的提示，檢查退出碼是 2、stderr 沒有排錯網址、你的判斷式認得到這次失敗。

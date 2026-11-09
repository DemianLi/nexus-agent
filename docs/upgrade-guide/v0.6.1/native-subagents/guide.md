---
kind: upgrade-guide
description: "`--agent-loop native` 下子代理改跑 native loop：`subagent.send` 太大的話改成拒收，`llm/stream` 的監聽者也會被子代理的模型呼叫叫到。"
---

# `--agent-loop native` 下子代理跑 native loop

## 變更

只影響用 `--agent-loop native` 跑的 serve 與 CLI，`langgraph`（沒給 `--agent-loop` 時的預設）的行為不變。

**子代理改由 native loop 驅動**：前景子代理（`task`，#2632）與背景子代理（`subagent` 帶 `run_in_background`）。

- **`subagent.send` 太大的話改成拒收。**
  - 舊行為：照收。子代理閒著時收到話會開新的一輪，那一輪開頭由基座把整段搬到 `/conversation_history/`，模型看到的是指向那個檔的一句話。
  - 新行為：超過 200,000 字的回 `invalid_argument`，訊息是 `message-too-large: 這則訊息有 <字數> 字，超過上限 200,000 字`；子代理的日誌一個字都不寫。
  - 跟 `run.start` 對 root 的那句話同一道准入（#2415），而且排在找 `run_id` 之前：編號不存在時，太大的話一樣回 `invalid_argument`，不是 `subagent_not_found`。
  - 子代理收到的、由模型寫的話（`task` 的 description、背景委派的那句、agent 轉來的）不擋，超過門檻照舊由基座搬檔。
- **`llm/stream` 的監聽者也會被子代理的模型呼叫叫到。**
  - 舊行為：只環繞 root 的模型呼叫。
  - 新行為：前景與背景子代理每一次叫模型也派一次；`agent/request-error` 同樣也派給子代理。`agent/pre-step` 與 `agent/turn-stopping` 仍只對 root 派。
  - 背景子代理那幾次的 `threadId` 是它自己子日誌的 session id，不是 root 的 thread；前景子代理的 `threadId` 不保證跟 root 不同。
- 受影響的：
  - web 以外、會用 `subagent.send` 送超過 200,000 字的 wire 客戶端；
  - 經 `registry.events.on('llm/stream', …)` 或 `registry.events.on('agent/request-error', …)` 登記監聽者的插件，如果它假設每一次都是 root 的模型呼叫，或照 `threadId` 數 root 的步數。
- 不受影響的：跑 `langgraph` 的主機；出廠的插件（都沒有 `llm/stream` 或 `agent/request-error` 的監聽者）。

## 遷移

1. 確認主機跑的是哪個 loop：看 `serve` 的啟動參數有沒有 `--agent-loop native`。沒有就不用往下做。
2. 自己寫的 wire 客戶端：`subagent.send` 收到 `invalid_argument` 而訊息以 `message-too-large:` 開頭時，把內容寫成檔、送檔案路徑，或拆成幾句送。
3. 自己寫的插件：找出 `llm/stream` 與 `agent/request-error` 的監聽者，
   `grep -rnE "events\.on\('(llm/stream|agent/request-error)'" <插件原始碼目錄>`。
   監聽者要能接受子代理的模型呼叫也進來；照 `threadId` 只分得出背景子代理，不要靠它分 root 與前景子代理。
4. 確認改好了：在 native 下讓 root 派一個背景子代理，對它 `subagent.send` 一句超過 200,000 字的話，應該收到上面那則 `invalid_argument`；
   插件的監聽者在子代理叫模型時被叫到，行為符合預期。

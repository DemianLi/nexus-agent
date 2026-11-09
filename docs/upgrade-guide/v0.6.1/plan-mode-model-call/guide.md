---
kind: upgrade-guide
description: 出貨清單拿掉 `plan-mode-model-call` 那一列，指到它的 patch、變更紀錄與 `plugin` 指令改成警告略過；`langgraph` 下也派 `agent/pre-step`。
---

# 拿掉 `plan-mode-model-call` 那一列，`langgraph` 下也派 `agent/pre-step`

## 變更

**`plan-mode-model-call` 那一列拿掉了**（#2358）。

- 舊行為：`cordis.yml` 有兩列計劃模式，`plan-mode`（`@nexus/plugin-plan-mode`）與 `plan-mode-model-call`（`@nexus/plugin-plan-mode/model-call`）。
  後者在送模型之前交出 `exit_plan_mode` 同意之後的待關、補回那則結果的 `name`。兩列成對開關：`plan-mode` 掛著時
  `plan-mode-model-call` 不能單獨關，關 `plan-mode` 時它一併當成關掉，`--dump-config` 與 `plugin` 對照快照會註明「連帶關閉」。
- 新行為：只剩 `plan-mode` 一列。交出待關改由 `plan-mode` 自己在每一步開頭做；補回 `name` 改由 core 做，對每一顆宣告了
  `concludesTurn` 的工具都補，不只 `exit_plan_mode`。開關計劃模式只看 `plan-mode` 那一列。
  - patch 檔或變更紀錄裡指到 `plan-mode-model-call` 的那一條：載入時跳過，警告寫明這一列已移除、指到這份指南，不是失敗。
  - `plugin disable`、`plugin enable`、`plugin config-set`、`plugin config-reset` 指到 `plan-mode-model-call`：回同一句說明，
    不寫變更紀錄，也不報錯。
  - `--dump-config` 不再有 `plan-mode-model-call`，也不再有「連帶關閉」的註解。
  - `@nexus/plugin-plan-mode/model-call` 這個子路徑匯出拿掉了；自己的清單 `insert` 了它的，那一列會在載入時掉。
- **`langgraph` 下也派 `agent/pre-step`。** 舊行為：只在 `--agent-loop=native` 下派。新行為：`langgraph` 下，派發面上有
  `agent/pre-step` 監聽者時，root 每一次模型呼叫之前也派一次，載荷的 `step` 一律是 `0`；重試與 `afterAgent` 跳回模型的那一次也派。
  回 `{ kind: 'reject' }` 時這一輪收成被擋下，同 native。子代理不派。
- 受影響的：
  - 在 `--patch` 檔或變更紀錄裡關過、改過 `plan-mode-model-call` 的主機；
  - 自己的清單 `insert` 了 `@nexus/plugin-plan-mode/model-call` 的主機；
  - 經 `registry.events.on('agent/pre-step', …)` 登記監聽者、又跑 `langgraph` 的插件：以前在 `langgraph` 下不會被叫，現在每次模型呼叫都會被叫。
- 不受影響的：計劃模式對模型與使用者的行為不變；沒碰過 `plan-mode-model-call` 的主機什麼都不用做。

## 遷移

1. 找出指到那一列的地方：
   `grep -nE 'plan-mode-model-call|plugin-plan-mode/model-call' <每一個 --patch 檔>`，以及
   `grep -c '"id":"plan-mode-model-call"' <home>/plugin-journal.jsonl`。
2. `--patch` 檔裡指到 `plan-mode-model-call` 的條目、`insert` 了 `@nexus/plugin-plan-mode/model-call` 的列，整條刪掉。
   原本要關計劃模式的，改成關 `plan-mode`：在 patch 檔寫 `- id: plan-mode` 配 `disabled: true`，或跑 `plugin disable plan-mode`。
3. 變更紀錄裡留著的那幾筆不用動：載入時跳過，只多一行警告。要連警告都不出現，同樣改成開關 `plan-mode`，舊的那幾筆照樣留著。
4. 經 `agent/pre-step` 登記監聽者、又跑 `langgraph` 的插件：確認監聽者重跑沒有副作用（同一步可能被叫不只一次），
   而且不靠 `step` 的值數步數。
5. 確認改好了：
   - `--dump-config` 的輸出裡沒有 `plan-mode-model-call`：`<啟動指令> --dump-config | grep -c plan-mode-model-call` 應該是 `0`；
   - 啟動時的錯誤輸出裡沒有「`plan-mode-model-call` 這一列已移除」那一句，除非你照第 3 步刻意留著舊紀錄。

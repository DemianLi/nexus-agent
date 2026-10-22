---
kind: upgrade-guide
description: serve 上一輪多了 30 分鐘的時鐘上限，跑超過的那一輪會被當成停止中止，日誌多一種中止原因。
---

# serve 上一輪的時鐘上限

## 變更

v0.5.19 的一輪沒有時鐘上限：只要模型一直要工具、串流一直有位元組、請求一直重試，那一輪就一直跑，直到遞迴上限或有人按停止。

新版（[#1624](https://github.com/DemianLi/nexus-agent/issues/1624)）在清單上加了 `turn-timeout` 那一列，出廠 `timeoutMs: 1800000`（30 分鐘）：

- `serve` 上主對話的每一輪、背景子代理的每一輪，從開跑起算，超過就照停止鈕的路中止：正在跑的工具等它落定、模型請求當場切斷、
  排在後面的輸入停住等人再送、目標收回續行授權（仍是 active，要 `/goal resume`）。
- 會話日誌的收尾是 `turn/end` 帶 `{ kind: 'aborted', cause: { kind: 'hook', reason: 'turn-timeout' } }`，下行收尾的 `lifecycle` 在
  `aborted: true` 旁邊帶同一個 `cause`（人按停止的那一種也帶 `cause: { kind: 'user' }`）。日誌格式因此升到 50，見
  [`session-log-format`](../session-log-format/guide.md)。
- `timeoutMs` 寫成 0、負數、小數、字串或超過 2147483647，`serve` 與 CLI 都會起不來，訊息指名這一列。CLI 本身不套時鐘。

受影響的：有一輪會正常跑超過 30 分鐘的 `serve` 部署（例如很長的續行目標、排隊等全機模型並行額度很久的主機）；自己讀日誌或下行、
認得 `aborted` 原因只有 `user` 與 `parent` 兩種的工具。

## 遷移

1. 要新的預設：不用動。
2. 一輪需要更長：在 `--patch` 覆寫檔（或 `plugin config set turn-timeout --file -`）把 `timeoutMs` 調大，正整數毫秒：

   ```yaml
   - id: turn-timeout
     config:
       timeoutMs: 7200000
   ```

3. 要回到 v0.5.19 的不限：把這一列關掉。

   ```yaml
   - id: turn-timeout
     disabled: true
   ```

4. 自己讀會話日誌或下行的工具：`aborted` 的 `cause.kind` 多了 `hook`（帶 `reason` 字串），照「被打斷」處理即可；要分出時間到，比
   `reason === 'turn-timeout'`。
5. 確認：啟動輸出有一行「一輪的時鐘：1800000 毫秒（…）」，關掉時寫「一輪的時鐘：不限（turn-timeout 那一列關掉了）」。細節見
   [`docs/operations.md`〈執行上限〉](../../../operations.md#執行上限)。

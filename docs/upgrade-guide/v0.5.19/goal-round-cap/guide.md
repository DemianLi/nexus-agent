---
kind: upgrade-guide
description: 目標續行多一條操作者給的輪數上限，出廠每次建立或恢復目標最多續行 20 輪；CLI 的 --max-goal-rounds 也改成每次恢復重新起算。
---

# 目標續行多一條操作者的輪數上限

## 變更

v0.5.19 的續行只有一條上限：目標自己的 `max_goal_rounds`（模型在 `create_goal` 填的，沒填是 256），模型在人說話的那一輪
還改得高。CLI 另有 `--max-goal-rounds`，比的是這個目標**累計**開過的輪數，到了之後就算人恢復目標，下一次決定也馬上又擋住。

新版（[#1623](https://github.com/DemianLi/nexus-agent/issues/1623)）在清單上加了 `goal-round-cap` 那一列，出廠 `limit: 20`：

- **人每建立或恢復一次目標，續行最多 20 輪**，到了就把目標記成 `blocked`（`round-cap`），訊息指名這一列；`/goal resume` 之後從 0
  重新算。模型改目標（`edit`）不重新算。兩條上限先到的那一條管。
- `serve` 與開了 `--goal-driver` 的 CLI 都讀這一列。CLI 的 `--max-goal-rounds` 贏過這一列，算法也改成每次建立或恢復重新起算。
- `limit` 寫成 0、負數、小數或字串，`serve` 與 CLI 都會起不來，訊息指名這一列。

受影響的：開著續行的 `serve` 主機（新版 `serve` 預設開，見 [`serve-goal-driver-default-on`](../serve-goal-driver-default-on/guide.md)），
以及用 `--goal-driver` 跑 CLI 的人。目標以前會一路跑到 256 輪，現在每 20 輪停下來等人恢復；用 `--max-goal-rounds` 的人，恢復之後
會再跑滿一次上限，不是馬上又停。

## 遷移

1. 要新的預設：不用動。
2. 要放寬：在 `--patch` 覆寫檔（或 `plugin config set goal-round-cap --file -`）把 `limit` 調大，正整數：

   ```yaml
   - id: goal-round-cap
     config:
       limit: 50
   ```

3. 要回到 v0.5.19 只剩目標自己那條上限：把這一列關掉。

   ```yaml
   - id: goal-round-cap
     disabled: true
   ```

4. 確認：啟動輸出的 `續行：…` 那一行寫著「部署設定（cordis.yml 的 goal-round-cap 那一列）給的 N 輪」，關掉時寫
   「goal-round-cap 那一列關著」。細節見 [`docs/operations.md`](../../../operations.md) 講 `goal-round-cap` 那一段。

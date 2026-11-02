---
kind: upgrade-guide
description: serve 的目標續行改成預設開，一個 active 的目標沒達成會自己再開一輪；要回到 v0.5.19 的行為加 --no-goal-driver。
---

# `serve` 的目標續行預設開

## 變更

v0.5.19 的 `serve` 要加 `--goal-driver` 才會在目標沒達成時自己再開一輪，不加就是一輪結束就結束。新版（PR #1130）
把 `serve` 的預設翻成開：一個 active 的目標在每一輪落定時會自己再開一輪，直到被完成、被擋住，或用完輪數上限。
上限有兩條，先到的那一條管：目標自己的 `max_goal_rounds`（預設 256），與清單上 `goal-round-cap` 那一列（出廠 20，每次建立或恢復
目標重新起算，見 [`goal-round-cap`](../goal-round-cap/guide.md)）。要核准的工具在 `serve` 上是停下來等人，不會空轉。CLI 的預設不變，仍是關。

`--goal-driver` 照樣接受（明講要開）；新增 `--no-goal-driver` 關掉，兩個一起給會報錯。

受影響的：沒加 `--goal-driver` 啟動 `serve` 的主機。升上來之後，使用者建了目標的對話會自己多跑幾輪，模型呼叫數跟著增加。

## 遷移

1. 要新的預設：不用動。
2. 要維持 v0.5.19 的行為：在 `serve` 的啟動指令（例如 systemd unit 的 `ExecStart`）加上 `--no-goal-driver`。
3. 確認：啟動輸出的那一行 `續行：…` 是你要的狀態，關掉時是 `續行：關閉（--no-goal-driver；…）`。

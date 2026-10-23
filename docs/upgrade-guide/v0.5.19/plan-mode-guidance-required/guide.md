---
kind: upgrade-guide
description: plan-mode 的 guidance 改成必填，只改了 startActive 的覆寫會讓這一列掉下來、/plan 消失。
---

# 計劃模式的 `guidance` 改成部署必給

## 變更

v0.5.19 的 `plan-mode` 那一列沒有 `config`，計劃指引（計劃模式開著時夾進 system prompt 的那一句）是套件裡的預設值。新版
（[#1607](https://github.com/DemianLi/nexus-agent/issues/1607)，照 dsh 的 `resolveConfig`）把 `guidance` 改成**必填、`trim()` 後不能是空白**，
套件不再有預設值；出貨的那一句（逐字沒變，所以模型看到的 system prompt 位元組也沒變）搬進 `cordis.yml` 的 `plan-mode` 那一列的 `config`。

patch 對 `config` 是**整份替換、不是深層合併**。所以在 patch 裡給了這一列 `config` 卻沒帶 `guidance` 的，現在驗不過
（啟動時警告 `plan-mode … 的 config 不合法 — guidance: …`），這一列不是必掛的，結果是「掉列」：serve 與 CLI 照樣起來，
但 **`/plan` 命令消失**（打 `/plan` 會被當成一般文字送給模型）、`exit_plan_mode` 也不在工具清單裡。

沒有動 `plan-mode` 那一列的主機不受影響。

受影響的：在 `--patch` 檔、或變更紀錄裡（`plugin config set plan-mode …`）給過 `plan-mode` 的 `config`（例如只寫 `startActive: true`）的主機。
`guidance` 寫成空白或空字串的同樣會掉列。

## 遷移

1. 找出覆寫：`grep -rn -B1 -A3 'id: plan-mode' <你的 --patch 檔>`；變更紀錄裡的看 `--dump-config` 輸出裡 `plan-mode` 那一列，有 `config` 但沒有 `guidance` 的就是。
2. 在那一列的 `config` 裡補上 `guidance`，內容用出貨那一句，或換成自己的：

   ```yaml
   - id: plan-mode
     config:
       startActive: true
       guidance: 你現在在計劃模式。先探索與設計，不要動手改東西；計劃完成後用 exit_plan_mode 把完整的計劃交出去等人批准。
   ```

   變更紀錄裡的改用 `plugin config set plan-mode --file <檔>` 整份換掉（檔裡同樣要有 `guidance`）。
   只想用出貨的 `guidance`：`--patch` 檔裡把這一列的 `config` 整個拿掉；變更紀錄裡的用 `plugin config reset plan-mode`。
3. 確認：重啟後啟動輸出沒有「N 列沒有掛上」提到 `plan-mode`；`--dump-config` 的 `plan-mode` 那一列有 `guidance`；
   打 `/plan` 回「計劃模式開了」。

回滾：退回 v0.5.19 時 patch 不必改，`guidance` 在舊版也是合法欄位。

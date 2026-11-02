---
kind: upgrade-guide
description: thread-title 的 maxBytes 不能再大於 maxTitleBytes（預設 80），寫超過的那一列會掉、標題回到預設的 40 位元組。
---

# 會話標題的 `maxBytes` 有了上限

## 變更

v0.5.19 的 `thread-title` 那一列只有 `maxWords`、`maxBytes` 兩格，`maxBytes` 寫多大都收。新版（PR #658）多了
`maxTitleBytes`（任何來源的標題上限，預設 80），並要求 `maxBytes` 不得大於它。

照 v0.5.19 的形狀把 `maxBytes` 調到 80 以上的設定會驗不過。這一列不是必掛的，所以 serve 照樣起來，啟動輸出多一行
`thread-title（#settings/thread-title）設定驗不過：… maxBytes: maxBytes 不能大於 maxTitleBytes`，變更紀錄多一筆 `failed`；
標題上限**回到預設的 40 位元組**，你調大的值沒有作用。

受影響的：在 home 的 `cordis.patch.yml` 或 `--patch` 覆寫檔裡把 `thread-title` 的 `maxBytes` 寫成大於 80 的主機。

## 遷移

1. 那一列的 `config` 加上 `maxTitleBytes`，值不小於 `maxBytes`，例如 `maxBytes: 120` 配 `maxTitleBytes: 120`。
   `config` 是整份替換，三格都寫出來。
   在 home 的 `cordis.patch.yml` 裡、升級時會被遷進變更紀錄的，升級後用 `plugin config set thread-title --file -` 整份換掉；
   在 `--patch` 檔裡的直接改檔。
2. 確認：啟動輸出沒有提到 `thread-title` 的「設定驗不過」；`--dump-config` 的那一列是你要的三個值。

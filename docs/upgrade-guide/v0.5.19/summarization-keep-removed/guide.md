---
kind: upgrade-guide
description: summarization 的 keep 拿掉了，照抄 v0.5.19 設定的那一列會掉、長對話不再被摘要。
---

# 摘要器的 `keep` 改成 `retainRatio`

## 變更

v0.5.19 的 `summarization` 那一列用 `keep: { type: messages, value: 20 }` 指定摘要之後逐字留幾則。新版（[#1374](https://github.com/DemianLi/nexus-agent/issues/1374)，
PR #1383）改成依模型算 token：`retainRatio`（占訊息預算的比例，出廠 0.16）或 `retainTokens`（固定 token 數），兩者擇一。
頂層寫了 `keep` 就驗不過（`summarization.keep 已經拿掉（#1374）：…`）。

這一列不是必掛的，所以結果是「掉列」：serve 照樣起來，但掛上的是一顆同名空殼，**長對話不再被摘要**，直到撞上模型窗口。
`truncateArgs` 裡的 `keep` 不受影響，不要一起刪。

受影響的：在 patch 裡重寫過 `summarization` 那一列 `config`（照 v0.5.19 出貨檔抄一份再改）的主機。

## 遷移

1. 把那一列頂層的 `keep: …` 換成 `retainRatio: 0.16`（或 `retainTokens: <數字>`）；`truncateArgs.keep` 留著。
   在 home 的 `cordis.patch.yml` 裡、升級時會被遷進變更紀錄的，升級後用 `plugin config set summarization --file -` 整份換掉；
   在 `--patch` 檔裡的直接改檔。
2. 確認：啟動輸出沒有「N 列沒有掛上」提到 `summarization`；`--dump-config` 的那一列有 `retainRatio` 或 `retainTokens`。

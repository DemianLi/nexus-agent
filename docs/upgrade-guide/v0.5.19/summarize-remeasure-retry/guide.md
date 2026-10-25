---
kind: upgrade-guide
description: 摘要之後仍超過門檻時會再摘一次，多一次模型呼叫；要維持舊行為得在 summarization 那一列寫 compactionRetries 0。
---

# 摘要之後重新量測，仍超過門檻就再摘一次

## 變更

v0.5.19 的摘要器在 token 門檻觸發、摘要完之後不再量，就算仍超過門檻也照那份送出。新版（[#2028](https://github.com/DemianLi/nexus-agent/issues/2028)）
摘要完會重新量一次；仍超過、而且只留最新那幾則（工具呼叫與結果的配對）會留得比較少時，換這個保留量**再摘一次**，多一次生摘要的模型呼叫。
第二次仍超過、或少留也沒用時，記一條 warn（「摘要之後仍超過門檻：…照這份送出。」），這一輪照常繼續。

次數由 `summarization` 那一列新的 `compactionRetries` 決定：出廠 `1`，只收 `0` 或 `1`。寫別的值，組裝 agent 時當場拋錯（「summarization.compactionRetries 是 …，只收 0 或 1…」）。

受影響的：所有用 `summarization` 那一列的主機。沒寫 `compactionRetries` 的（照 v0.5.19 出貨檔抄的 patch 也是）一律用出廠的 `1`，行為就是上面的新行為。

## 遷移

1. 新行為就是要的：不用改。
2. 要維持 v0.5.19 的行為（摘要一次就送、不多打模型）：在 `summarization` 那一列的 `config` 加一行 `compactionRetries: 0`。
   在 home 的 `cordis.patch.yml` 裡、升級時會被遷進變更紀錄的，升級後用 `plugin config set summarization --file -` 整份換掉；在 `--patch` 檔裡的直接改檔。
3. 確認：`--dump-config` 的 `summarization` 那一列有 `compactionRetries`，值是你要的那一個。

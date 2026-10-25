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
2. 要維持 v0.5.19 的行為（摘要一次就送、不多打模型）：`summarization` 那一列的 `config` 要多一格 `compactionRetries: 0`。
   `config` 是**整份替換**：只寫 `compactionRetries: 0`，沒寫的 `trigger`、`retainRatio`、`truncateArgs`、`historyPathPrefix` 都回到預設。
   所以要把這一列現在的整份 `config` 照抄，再加上這一格：
   - 用 `plugin config set summarization --file -` 改的（含升級時從 home 的 `cordis.patch.yml` 遷進變更紀錄的）：內容寫整份，例如出貨的那份是
     `{"trigger": [{"type": "tokens", "value": 100000}, {"type": "messages", "value": 60}], "retainRatio": 0.16, "truncateArgs": {"trigger": {"type": "messages", "value": 20}, "keep": {"type": "messages", "value": 20}}, "historyPathPrefix": "/conversation_history", "compactionRetries": 0}`，
     你改過的值換成你自己的；
   - 在 `--patch` 檔裡寫這一列的：在它的 `config` 底下加 `compactionRetries: 0`，其他鍵原樣留著。
3. 確認：`--dump-config` 的 `summarization` 那一列有 `compactionRetries`，值是你要的那一個。

---
kind: upgrade-guide
description: 同一個 home 只能起一個 serve，第二個在寫檔前就拒絕；共用 home 跑多台 serve 的部署要各給一個 NEXUS_AGENT_HOME。
---

# 同一個 home 只能起一個 `serve`

## 變更

v0.5.19 不擋兩個 `serve` 共用同一個 home，兩邊會互相蓋掉對方寫在 home 底下的檔案。新版（PR #1592）
啟動時對 `<home>/serve.lock` 拿一把作業系統的檔案鎖，拿不到就在寫任何檔之前退出：

`這個 home（…）已經有另一個 serve 在用：鎖檔 …/serve.lock 被別的行程握著，第二個 serve 會把先寫的檔案蓋掉，所以不起來。要並行就各給一個 NEXUS_AGENT_HOME；…`

鎖跟著行程走，`serve` 結束（包括被殺掉）就放掉，不用手動清鎖檔。

受影響的：在同一台主機、用同一個 home（包括都沒設 `NEXUS_AGENT_HOME`、落在同一個使用者的 `~/.nexus-agent`）起多個 `serve` 的部署，
例如不同 port 或不同 `--workspace` 各起一台。

## 遷移

1. 每一台 `serve` 各給一個 `NEXUS_AGENT_HOME`（例如 systemd unit 各寫一行 `Environment=NEXUS_AGENT_HOME=…`）。
   要沿用舊資料的那一台指到原本的 home，其他台指到新的目錄；金鑰、權限檔這些要各自放一份。
2. 確認：每一台都起得來，沒有上面那則訊息。被擋時照訊息跑 `lsof <home>/serve.lock` 查是誰握著。

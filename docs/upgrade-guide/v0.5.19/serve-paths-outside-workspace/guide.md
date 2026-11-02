---
kind: upgrade-guide
description: serve 拒絕 home 或 .env 跟 --workspace 重疊，例如工作區指到使用者家目錄、home 落在裡面時起不來。
---

# `serve` 的 home 與 `.env` 不能落在工作區裡

## 變更

工作區裡的檔模型都讀得到，而共用這台 `serve` 的每個人都能叫它讀。v0.5.19 不檢查，home（金鑰、瀏覽器會話密鑰、所有人的附件與會話日誌）
落在工作區裡也照樣起。新版（PR #1645）在給了 `--workspace` 時，啟動前比對下面幾個路徑（解開符號連結之後），
任何一個**就是**工作區、**在工作區之內**或**包含工作區**就起不來：

- 目前資料夾的 `.env`（存在時）
- harness home（`NEXUS_AGENT_HOME`，沒設就是 `~/.nexus-agent`）與它底下的 `.env`
- 程式碼資料夾根目錄的舊 `.env`（存在時）

訊息是 `serve 起不來：下面這些跟 --workspace … 重疊。`，接著逐行列出哪一個、怎麼重疊，最後列出路。

受影響的：給了 `--workspace` 的 `serve`，而且上面任何一個路徑跟它重疊。常見的是 `--workspace` 指到使用者家目錄或 `/`
（預設的 `~/.nexus-agent` 落在裡面），或在工作區裡啟動而那裡有 `.env`。沒給 `--workspace` 的不受影響。

## 遷移

1. 照訊息逐行處理，擇一：
   - 把 `NEXUS_AGENT_HOME` 設到工作區外面（搬舊 home 前先停 serve，整個目錄一起搬）。
   - 把 `.env` 搬到工作區外面，或改在啟動環境設那些變數。
   - 換一個不跟這些路徑重疊的 `--workspace`。
2. 確認：serve 起得來，沒有上面那則訊息。

---
kind: upgrade-guide
description: 程式碼資料夾根目錄的 .env 不再讀取，key 與代理設定要搬進 home 或受管憑證檔。
---

# `.env` 搬進 home

## 變更

v0.5.19 只在 `--live` 時讀**程式碼資料夾根目錄**的 `.env`，而且環境裡已經有 `NVIDIA_API_KEY` 就不讀。新版
（[#730](https://github.com/DemianLi/nexus-agent/issues/730)，PR #790）帶 `--live` 時讀兩份：目前資料夾的 `.env`，以及
`$NEXUS_AGENT_HOME/.env`。key 另有受管憑證檔 `<home>/.credentials.yaml`。**舊位置不讀，也不當退路**。

另外兩條新規則：兩份 `.env` 都不准設行程怎麼起的變數（`PATH`、`NODE_OPTIONS`、`LD_PRELOAD`、`NEXUS_AGENT_*` 這類），
設了就起不來；代理設定（`HTTP_PROXY` 等）只認 home 那一份。`serve --live` 缺 key 時在啟動當下就失敗（以前是開對話才失敗）。

受影響的：看**舊版**怎麼裝，不看新版。v0.5.19 只有從原始碼 checkout 起這一種，所以把 key 或代理寫在 checkout 根目錄 `.env` 的主機
都受影響；新版不管是從 checkout 起還是裝 tar.gz 安裝樹，那份舊檔都不再讀。

## 遷移

1. 把舊檔搬進 home，目錄與檔案都只給擁有者：

   ```bash
   install -d -m 700 ~/.nexus-agent
   mv -n <程式碼資料夾>/.env ~/.nexus-agent/.env
   chmod 600 ~/.nexus-agent/.env
   ```

   設了 `NEXUS_AGENT_HOME` 就搬到那裡（systemd 的裝法是 `/var/lib/nexus-agent`，擁有者是跑 serve 的使用者）。`mv -n` 不覆蓋：
   home 已經有一份 `.env` 的話它什麼都不做，要自己把兩份合併。只放 key 的話，也可以改存成受管憑證檔，格式與權限見
   [`docs/operations.md`〈金鑰放哪裡〉](../../../operations.md#金鑰放哪裡)。
2. 從搬過去的 `.env` 刪掉 `PATH`、`NODE_OPTIONS`、`LD_PRELOAD`、`NEXUS_AGENT_*` 這類變數；代理設定留在 home 那一份。
3. 確認：`serve --live` 起得來。沒搬時起不來，訊息看新版怎麼起：**從 checkout 起**、舊檔還在原處時是
   `缺少環境變數 NVIDIA_API_KEY。舊位置 …（程式碼資料夾根目錄的 .env）已經不再讀取：請把它搬到 …`；裝的是 tar.gz 安裝樹的話是一般的
   `缺少環境變數 NVIDIA_API_KEY。真實供應商的 key 沒有預設值也不 fallback，…`，不會提舊位置，因為安裝樹沒有「程式碼資料夾根目錄」可指
   （[#1671](https://github.com/DemianLi/nexus-agent/issues/1671)）。

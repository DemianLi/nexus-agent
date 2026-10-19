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

受影響的：把 key 或代理寫在程式碼資料夾根目錄 `.env` 的主機。打包的安裝樹沒有「程式碼資料夾根目錄」，不受影響。

## 遷移

1. 把舊檔搬進 home：`mkdir -p ~/.nexus-agent && mv <程式碼資料夾>/.env ~/.nexus-agent/.env`（設了 `NEXUS_AGENT_HOME`
   就搬到那裡）。只放 key 的話，也可以改存成受管憑證檔，格式與權限見
   [`docs/operations.md`〈金鑰放哪裡〉](../../../operations.md#金鑰放哪裡)。
2. 從搬過去的 `.env` 刪掉 `PATH`、`NODE_OPTIONS`、`LD_PRELOAD`、`NEXUS_AGENT_*` 這類變數；代理設定留在 home 那一份。
3. 確認：`serve --live` 起得來。沒搬時的失敗訊息開頭是
   `缺少環境變數 NVIDIA_API_KEY。舊位置 …（程式碼資料夾根目錄的 .env）已經不再讀取：請把它搬到 …`。

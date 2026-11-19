---
kind: upgrade-guide
description: "`per-thread` 啟動時 `<home>/host-plugins.json` 由 harness 整份重寫，手寫在裡面的列會消失；宿主連 MCP 用的代理跟模型請求一樣，帶 `--live` 時也看 home 的 `.env`。"
---

# host-plugins.json 改由 harness 產生

## 變更

只影響 `process-model` 設成 `per-thread` 的部署。`single`（預設）不讀這個檔，也不寫它。

- **舊行為。** `<home>/host-plugins.json`（`NEXUS_AGENT_HOME`，沒設就是 `~/.nexus-agent`）由管理者手寫，serve 不建；出貨的宿主只有 `mcp` 一個插件，手寫的列沒有實際用途。
- **新行為。** 每次啟動 serve，在換成監督行程之前，harness 把整個檔照當下的環境重寫（權限 0600）：
  - 環境有設 `NODE_EXTRA_CA_CERTS`：寫一列 `mcp`，`roots` 是那個檔的絕對路徑；解得出代理（`HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY`）就多一個 `proxy`。
  - 沒設：檔案是 `[]`，宿主不掛 `mcp`。只設代理、沒設 `NODE_EXTRA_CA_CERTS`，一樣是 `[]`。
  - 舊檔裡的列（包括手寫的）不保留。
- **代理也看 home 的 `.env`。** 宿主連 MCP 用的代理，解的環境與模型請求同一份：帶 `--live` 時是行程環境加上 home 的 `.env`（行程環境優先），沒帶 `--live` 只有行程環境。寫在 home `.env` 裡的 `HTTP_PROXY` 等，模型請求與宿主連 MCP 都會走。
- **壞的 `.env` 更早報錯。** 帶 `--live`、而 home 的 `.env` 設了只有啟動環境能設的名字（例如 `NODE_OPTIONS`）時，錯誤在啟動器就丟（訊息與以前相同），不是等前台起來才丟。
- **根檔讀不了的錯誤訊息。** `NODE_EXTRA_CA_CERTS` 指的檔不存在、讀不了或裡面沒有憑證時，宿主照常起來，標準錯誤記一行 `插件 mcp apply 失敗：…`（訊息指名那個檔），`mcp` 沒掛。

受影響的：`per-thread` 部署裡手寫過 `host-plugins.json` 的；在 home 的 `.env` 設了壞值、又用 `--live` 起 `per-thread` 的（錯誤出現的位置提早）。

## 遷移

1. 手寫過 `host-plugins.json` 的，確認內容：出貨的宿主只認 `mcp`，它的 `roots` 與 `proxy` 現在都由環境決定，不用也不能再手寫。
2. 代理寫在 home `.env` 的部署不用改：帶 `--live` 時宿主與模型請求都會走。沒帶 `--live` 的部署，要在啟動 serve 的環境裡匯出代理變數。
3. 重啟 serve，看 `<home>/host-plugins.json`：有設 `NODE_EXTRA_CA_CERTS` 就應該有一列 `mcp`，沒設就是 `[]`。
4. 查宿主有沒有掛上：宿主的標準錯誤看有沒有 `插件 mcp apply 失敗`；沒有就是掛上了。

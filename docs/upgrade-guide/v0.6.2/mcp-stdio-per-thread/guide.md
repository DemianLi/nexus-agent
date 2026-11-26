---
kind: upgrade-guide
description: "`per-thread` 下 stdio MCP 由宿主起子行程：`command` 照 `PATH` 解成絕對路徑、宿主不留子行程的 stderr。"
---

# per-thread：stdio MCP 改由宿主起子行程

## 變更

只影響 `process-model` 設成 `per-thread` 的部署，且 MCP 列是 stdio 的。`single`、CLI 不變。

- **子行程的環境不變。** 仍是「清過的父環境（扣掉名字像憑證的與 `NEXUS_*`）疊上設定的 `env`」，由對話行程的 TS 算好交給宿主，宿主 `env_clear` 之後只放這一份；清洗規則、父環境（對話行程的環境）都跟以前相同。
- **`command` 要是絕對路徑。** 宿主不查 `PATH`。沒被沙箱包裝、`command` 不含斜線的（例如 `npx`、`uvx`），harness 先照 `env.PATH`（設定寫了就用它，沒寫用對話行程的 `PATH`）找成絕對路徑再交給宿主；含斜線的相對路徑（例如 `./bin/server`）照該列設定的 `cwd` 解成絕對路徑（`cwd` 本身是相對的，再照對話行程的 cwd 解；沒設 `cwd` 就用對話行程的 cwd），跟原本 SDK 起子行程的解法一致。找不到的這一列連不上，錯誤訊息指名那個 command。
- **宿主不留子行程的 stderr。** server 起不來時，只看得到「Failed to connect to stdio server …」，看不到它自己印的原因；要查，先在單行程或直接在終端機跑一次那個 command。
- **卡死的 server 照樣被收掉重啟，由宿主做。** 呼叫逾時或被停止之後的探活、`livenessTimeoutMs`、日誌的 `server stopped responding` 都跟 `single` 相同（[v0.5.19 的說明](../../v0.5.19/mcp-stalled-server-restart/guide.md)）；日誌出在宿主的 stderr，整行是 `nexus-host: mcp 資訊：mcp-client(<serverName>): server stopped responding; restarting it`（`single` 下是 warn 級）。
- **子行程自成行程群組，隨宿主管理。** 宿主重起時，上一個宿主的子行程由監督行程掃掉，新的宿主會重新起它們；對話行程結束不會帶走共用的那一份（整台共用一份連線，活到宿主結束）。

## 遷移

1. 依賴 `PATH` 解析的 command，確認對話行程的 `PATH`（或該列 `env.PATH`）找得到；或改寫成絕對路徑。
2. 升級後重啟 serve，看每一列 stdio MCP 的工具有沒有照常列出。

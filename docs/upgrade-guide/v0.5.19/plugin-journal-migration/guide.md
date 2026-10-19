---
kind: upgrade-guide
description: home 的 cordis.patch.yml 不再是一層設定，第一次啟動時遷進變更紀錄 plugin-journal.jsonl、原檔改名。
---

# 插件設定改存在變更紀錄

## 變更

v0.5.19 的插件清單疊三層：出貨的 `cordis.yml`、home 的 `cordis.patch.yml`、`--patch` 覆寫檔。新版把中間那層換成變更紀錄
`<home>/plugin-journal.jsonl`（[#1412](https://github.com/DemianLi/nexus-agent/issues/1412)），改插件用 `plugin` 寫入口，每一筆
都記誰、何時、改了什麼。

新版第一次啟動（或第一次跑 `plugin`）時，如果 home 有 `cordis.patch.yml`、還沒有紀錄檔，就把它的每條 patch 遷成一筆紀錄，
原檔改名成 `cordis.patch.yml.migrated-<時間>`（`0600`），之後不再讀。紀錄檔建好之後才出現的 `cordis.patch.yml` 只警告、不讀、不遷。

受影響的：在 home 放了 `cordis.patch.yml` 的主機，以及之後還想手改那個檔的人。`--patch` 覆寫檔照舊。

## 遷移

1. 升級前照 [`docs/operations.md`〈升級與回滾〉](../../../operations.md#升級與回滾) 備份整個 home。遷移之後換回 v0.5.19，
   插件設定會靜靜回到出廠，所以退回去只能還原這份備份。
2. 起新版，啟動輸出要有一行 `[清單] 已把舊的 cordis.patch.yml 的 N 條 patch 遷進變更紀錄 <home>/plugin-journal.jsonl；原檔改名為 …`，
   `N` 等於你原檔裡的 patch 條數。
3. 遷移進來的 `insert` 相對模組路徑會換成絕對路徑。之後要搬 home 的話，搬完核對這些路徑（見〈後台改清單〉的「第一次啟動的遷移」）。
4. 之後改插件用 `plugin` 寫入口，不要再編輯 `cordis.patch.yml`；要用檔案管理的設定改放進 `--patch` 覆寫檔。
5. 確認：同一個 `NEXUS_AGENT_HOME` 跑 `serve --dump-config`，檔頭寫 `patched by <home>/plugin-journal.jsonl`，之前停用的列仍有
   `disabled: true`、改過的 `config` 都在。

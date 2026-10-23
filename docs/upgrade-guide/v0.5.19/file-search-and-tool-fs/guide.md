---
kind: upgrade-guide
description: glob 改用內附 ripgrep（不列版本控制目錄、照修改時間排序）、grep 的 pattern 改成正規式、grep 每行命中文字限長，並新增可關寫檔與改檔的 tool-fs 設定列；依賴舊行為的設定與腳本要跟著改。
---

# 檔案搜尋換成 ripgrep 語意，並開放檔案工具組態

## 變更

[#1605](https://github.com/DemianLi/nexus-agent/issues/1605)，照 dsh `tool-fs-search`／`tool-fs`：

- **`glob` 改走內附 ripgrep**（`rg --files`），不再經 `fast-glob`。v0.5.19 的結果按路徑排序、`.git` 之類的目錄也會列進來；新版：
  - 不列 `.git`、`.svn`、`.hg`、`.bzr`、`.jj`、`.sl` 這六種版本控制目錄的任何內容（任何深度）；
  - 照**修改時間**排序，舊的在前；
    起點落在路由裡（`/conversation_history/`、`/large_tool_results/`、`/attachments/`、共用區、外掛掛載點）時一樣會重排；
    從 `/` 搜時，各路由的結果也跟工作區的檔排在同一條時間軸上；
  - 沒有 `/` 的 pattern（例如 `*.ts`）比的是檔名、任何深度都命中，帶 `/` 的從工作區根錨定；
  - 不跟 symlink、也不列 symlink；
  - 空白 pattern 回 `SEARCH_INVALID_PATTERN` 錯誤，不再列出全部；
  - 內附 ripgrep 不可用時回錯誤，沒有退回基座實作的路（同 `grep`）。
- **`grep` 的 `pattern` 是 ripgrep 正規式**（v0.5.19 是字面比對）。`foo|bar`、`\bword\b`、`.` 都有了正規式的意思，要比對字面的 `.`、`(` 要自己轉義；
  不合法的正規式回 `SEARCH_INVALID_PATTERN`。`glob` 參數（檔案過濾）也驗：空字串、以 `!` 開頭的否定、逗號分隔的清單都會被拒，要多選用 `{a,b}`。
  模型看到的工具說明（`grep`、`glob` 的描述與參數說明）跟著換成正規式、基名規則與修改時間序的說法。
  **這個說法只在給了 `--workspace` 時換**（搜尋走工作區 backend）：沒給 `--workspace` 時 default 是記憶體裡的 `StateBackend`，它的 `grep` 是字面比對，工具說明維持基座原文；
  工作區底下的 `/conversation_history/` 也是記憶體後端，`grep` 在那裡仍是字面比對，工具說明裡有寫。
- **`grep` 每一行命中文字限在 `grepMaxLineBytes`（出貨 2000）位元組內**，在 UTF-8 字元邊界上切、結尾加 ` (line truncated)`；
  整行還在檔案裡，用 `read_file` 讀得到。這一格在 `tool-fs-search` 那一列，跟筆數上限同進同出（行內與外溢存檔的全文都是截過的版本）。
- **新的設定列 `tool-fs`**（出貨就掛著，值全是預設）：
  - `write: false` 關掉 `write_file` 與 `delete`、`edit: false` 關掉 `edit_file`：關掉的工具模型根本看不到，對應的「先讀後改」那句系統提示也不再出現；
  - `readLimit`（一頁行數，預設 2000）、`readMaxLineLength`（單行字元數，2000）、`readMaxBytes`（單次讀檔輸出位元組數，51200）、`readStreamMinSize`（改走串流讀的檔案大小，10 MiB），都要是正整數；
  - `read` 這一格收了但只認 `true`（基座要求 `read_file` 一定在清單裡），寫 `false` 載入就失敗。

受影響的：靠 `glob` 結果順序或看得到 `.git` 內容的腳本與提示詞；`grep` 的 pattern 裡有未轉義的 `.`、`(`、`[`、`|` 等字元、原本期待字面比對的提示詞；
`grep` 的 `glob` 參數用逗號清單或 `!` 否定的；有自己的 `tool-fs-search` 設定（`config` 整份替換，沒寫的格子回到預設，`grepMaxLineBytes` 因此預設就是 2000）的主機。

## 遷移

1. 提示詞或腳本依賴 `glob` 的路徑排序：改成自己排序；依賴能列出 `.git` 內容的，改用 `read_file` 讀確切路徑（`ls` 不受這次改動影響）。
2. `grep` 要比對字面文字：把 pattern 裡的 `.`、`(`、`)`、`[`、`]`、`{`、`}`、`*`、`+`、`?`、`|`、`^`、`$`、`\` 前面加 `\`。檔案過濾要多個副檔名，寫 `*.{ts,tsx}`，不要用逗號或 `!`。
3. 一行命中文字太長被截了而你要全文：不調 `grepMaxLineBytes` 的話，用 `read_file` 讀那個檔的對應行；要放寬，改 `tool-fs-search`：
   `plugin config set tool-fs-search --file -`，內容寫 `{"grepMaxLineBytes": 8000}`（`config` 整份替換，筆數兩格沒寫就回到預設 250／100）。要完全不截，
   `plugin disable tool-fs-search`（同時也沒有筆數上限）。
4. 要部署「只讀的知識助理」：`plugin config set tool-fs --file -`，內容寫 `{"write": false, "edit": false}`。這一列**關不掉**：標成 `disabled: true` 啟動就失敗，因為關掉它只會讓所有檔案工具全開。
   這是模型看得到什麼；叫了會怎樣仍由圍堵（`read-only` 之類）管，兩者可以疊用。
5. 確認：`--dump-config` 裡 `tool-fs`、`tool-fs-search` 是你要的狀態；兩列都在新對話生效，已經開著的對話不變。

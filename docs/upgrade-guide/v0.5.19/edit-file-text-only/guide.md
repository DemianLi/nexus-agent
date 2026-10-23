---
kind: upgrade-guide
description: edit_file 現在拒絕改二進位檔與壞掉的 UTF-8 檔（以前會有損解碼再寫回），read_file 讀 CRLF 檔不再帶行尾的 \r；靠舊行為的插件與腳本要跟著改。
---

# 改檔只改文字，CRLF 檔照模型讀到的內容改

## 變更

v0.5.19 的 `edit_file`（以及外部插件經 `@nexus/fs` 的 `fs.backend()` 拿到的 backend `.edit(path, oldString, newString, replaceAll)`）在有 `--workspace`
的情況下，把整個檔當 UTF-8 **有損**解碼、替換、再寫回：檔案不是合法 UTF-8 時，壞掉的位元組在寫回時被換成 `U+FFFD`，檔案被悄悄改壞，工具還回成功。
`read_file` 讀 Windows 行尾（CRLF）的檔時，每一行尾端都帶著一個 `\r`，模型照讀到的內容寫的 `old_string`（沒有 `\r`）因此對不上多行文字，回「找不到」。

新版（[#1563](https://github.com/DemianLi/nexus-agent/issues/1563)，照 dsh `fs-local` 的 `readForEdit`／`applyLiteralEdit`／`restoreLineEndings`）：

- **二進位與壞掉的 UTF-8 不改。** 前 8KB 有 NUL 回 `cannot edit "<路徑>": binary file`，不是合法 UTF-8 回 `cannot edit "<路徑>": invalid UTF-8 text`，檔案原封不動。
- **CRLF 檔改得動，行尾保持原樣。** 檔案行尾由開頭 4096 個字元的多數決定，`old_string`、`new_string` 先正規化成 LF 再比對，寫回時還原成原本的行尾。
  `read_file`（只有模型那條工具）讀出來的每一行不再帶尾端的 `\r`；backend 自己的 `.read()` 不變，`\r` 原樣。
- **混合行尾的檔會被統一**：同一個檔裡 CRLF 與 LF 並存時，改完整份都變成多數那一種（同 dsh 的已知限制）。
- 檔案工具失敗時，`tool/result` 事件的 `error` 多帶一個原因碼（`FS_NOT_FOUND`、`FS_NOT_REGULAR_FILE`、`FS_NOT_TEXT`、`FS_EDIT_NOT_FOUND`、`FS_AMBIGUOUS_EDIT`、`FS_PERMISSION_DENIED`），錯誤文字不變；這一點是純新增。

受影響的：用 `backend.edit` 改二進位或非 UTF-8 檔的外部插件與腳本（升級後得到錯誤結果，不再改壞檔）；依賴 `read_file` 輸出尾端 `\r` 的腳本；
手上有混合行尾檔案、期待改完只動被改的那幾行的人。

## 遷移

1. 找出你的插件與腳本裡對 backend 的 `.edit(` 呼叫，挑出目標可能是二進位或非 UTF-8 的。沒有就不用做別的。
2. 要改位元組的，讀成位元組自己改，再用 `backend.uploadFiles([[path, bytes]])` 寫回，`bytes` 是 `Uint8Array`；它不看編碼、原樣寫位元組，也過同一道路徑圍欄。
3. 解析 `read_file` 輸出的腳本，不要再把行尾 `\r` 當成檔案的行尾；要判行尾，直接讀檔案位元組。
4. 確認改好了：在工作區放一個內容是 `a\r\nb\r\n` 的檔，用 `edit_file` 把 `a\nb` 換成 `X\nb`，檔案位元組應是 `X\r\nb\r\n`；
   對一個含 NUL 的檔呼叫 `edit_file`，應回 `cannot edit "<路徑>": binary file`，檔案不變。

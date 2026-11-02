---
kind: upgrade-guide
description: 有工作區時模型多一支 copy_file，伺服端照位元組把檔複製到新路徑，不再靠模型讀了再整份寫出來。
---

# 出廠多一支 copy_file 工具

## 變更

v0.6.0 裡，模型要「照抄一份檔」只能先 `read_file`、再把內容整份交給 `write_file`。出廠模型轉抄時會把開頭的空白剝掉，內容被靜靜寫壞，
`write_file` 不會報錯（#2289）。

新版在給了 `--workspace` 的部署多掛一支 `copy_file`（參數 `source_path`、`destination_path`）：

- 由伺服端照位元組複製，內容不經模型；二進位與非 UTF-8 的檔也原樣複製。
- 目的地已經存在就拒絕，不覆蓋，也不做搬檔。
- 來源與目的地可以落在不同的地方：工作區、`/shared/` 共用區、`/attachments/` 附件都能當來源，目的地只能在工作區；
  共用區與附件是唯讀的，拿來當目的地會被拒。附件只開得到這條 thread 引用過的。
- 寫入與 `write_file` 走同一道圍堵：唯讀模式、可寫根外、保留的地方都擋；被擋下時的升級詢問也一樣。`permissions` 的 deny 規則
  對來源比讀、對目的地比寫。
- 發佈前核對：複製出來的內容與讀到的來源 sha256 不同、或來源在複製途中變了大小，就不建目的地，回錯誤。
- 成功時會話日誌那一筆 `tool/result` 的 `meta` 記 `operation: "copy"`、`source`、`destination`、`bytes`、`sha256`。
- 這一輪的改動摘要（`/threads/<id>/changes/summary` 回的那一份，留在 server、只活到會話結束）裡，用 `copy_file` 建出來的檔（主對話與子代理叫的都算）
  多帶一格 `copiedFrom`（來源、位元組數、sha256）。web 目前不顯示這一格，畫面上它跟一般新建的檔一樣。
- 子代理叫的 `copy_file`：`tool/result` 那一筆寫在子代理自己的日誌，主對話的日誌沒有。

沒有 `--workspace` 的部署不掛它（沒有磁碟上的檔可以照抄）。`tool-fs` 寫了 `write: false` 的部署也不掛，跟 `write_file`、`delete` 一起關。

**受影響的是：** 給了 `--workspace`、而且沒有在 `tool-fs` 關掉寫檔的部署。模型看到的工具清單多一支，要複製檔時會改叫它；
會話日誌與稽核會多出 `copy_file` 的呼叫。

## 遷移

1. 確認這台部署受不受影響：啟動 serve 或 CLI 時有沒有給 `--workspace`；`--patch` 覆寫檔與 `cordis.yml` 裡 `id: tool-fs` 那一列的
   `config` 有沒有寫 `write: false`。沒給 `--workspace`，或寫了 `write: false`，就不受影響，後面幾步不必做。
2. 不想讓模型用 `copy_file` 的部署：它沒有自己的開關。在 `--patch` 覆寫檔對 `id: tool-fs` 寫 `config: { write: false }`，
   會連 `write_file`、`delete` 一起關；要保留寫檔又不要複製，目前做不到。
3. 讀稽核紀錄的流程（會話日誌在 home 底下的 `sessions/`）：把 `tool/result` 的 `meta.operation` 為 `"copy"` 的那幾筆當成新建檔，
   來源、目的地、位元組數與 sha256 直接讀那四格，不必從工具的文字結果推。子代理叫的那幾筆在子代理自己的日誌裡，只讀主對話的日誌會漏掉。
4. 確認：開一條新 thread，請模型把工作區裡一個檔複製到一個還不存在的檔名。會話日誌裡應有一筆 `copy_file` 的 `tool/result`，
   `meta.sha256` 等於在 `--workspace` 指的目錄對新檔跑 `shasum -a 256 <新檔>` 的結果；再請它複製到同一個檔名一次，這一次被拒、
   原檔不動。

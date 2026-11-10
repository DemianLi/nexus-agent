---
kind: upgrade-guide
description: "受管憑證檔 `.credentials.yaml` 裡出現 NUL、tab、單獨的 CR 或不在檔頭的 BOM，整份拒絕。"
---

# 受管憑證檔拒絕 tab、NUL、單獨的 CR 與檔中間的 BOM

## 變更

只影響掛受管檔的入口（serve、plugin 試組）。CLI、eval、spike 不讀這份檔，行為不變。

- 舊行為：用 tab 縮排本來就拒絕（`TAB_AS_INDENT`），這一點不變；冒號後用來對齊的 tab、值裡、引號裡、註解裡與行尾的 tab 照收；
  只用 CR 換行的檔多半以別的 YAML 錯誤拒絕，沒拒絕的會把 CR 當成內容讀錯；NUL 與檔中間的 U+FEFF 收進值或鍵名裡。
- 新行為：檔裡任何位置（值、引號、註解、縮排）出現 NUL、tab、不接 LF 的 CR、不在檔頭的 U+FEFF，都拒絕，訊息是 `YAML 錯誤 CHARACTER_NOT_ALLOWED（第 L 行第 C 欄）`，不含值。檔頭的 BOM 與 CRLF 換行照收。
- 受影響的：受管檔裡用 tab 對齊（冒號後）、值、引號或註解裡有 tab、或有 NUL、檔中間的 U+FEFF 的主機，升上來之後 `serve --live` 起不來；沒帶 `--live` 的 serve 照樣起來，但引用受管檔憑證的 MCP 那幾列連線時連不上。

## 遷移

1. 打開 `~/.nexus-agent/.credentials.yaml`（或你設定的 harness home 底下的那一份），把 tab 換成空白。值裡真的要有 tab，改用雙引號寫成 `"a\tb"`。
2. 檔案若是只用 CR 換行（舊的 Mac 編輯器），存成 LF 或 CRLF。NUL 與檔中間的 U+FEFF 刪掉。
3. 確認改好了：重啟 `serve --live`，起得來；起不來時照訊息裡的行號回檔案裡看。

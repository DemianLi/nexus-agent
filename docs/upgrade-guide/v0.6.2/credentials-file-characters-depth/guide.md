---
kind: upgrade-guide
description: "受管憑證檔 `.credentials.yaml` 裡的 NUL、tab、單獨的 CR、不在檔頭的 BOM，超過 64 層的巢狀，與 mapping 或序列當鍵，整份拒絕。"
---

# 受管憑證檔拒絕 tab 等字元、太深的巢狀與集合鍵

## 變更

只影響掛受管檔的入口（serve、plugin 試組）。CLI、eval、spike 不讀這份檔，行為不變。

- **四種字元整份拒絕。**
  - 舊行為：值、註解裡的 tab 照收，冒號後接 tab 也照收；只用 CR 換行的檔照收；檔中間的 U+FEFF 當成值的一部分。
  - 新行為：檔裡任何位置（值、引號、註解、縮排）出現 NUL、tab、不接 LF 的 CR、不在檔頭的 U+FEFF，都拒絕，訊息是 `YAML 錯誤 CHARACTER_NOT_ALLOWED（第 L 行第 C 欄）`，不含值。
  - 檔頭的 BOM 與 CRLF 換行照收。
- **mapping 與序列超過 64 層整份拒絕。**
  - 舊行為：沒有上限；深到幾千層時，解析用光資源，拋出的錯不帶檔名。
  - 新行為：根是第 1 層，每往裡一個 mapping 或序列多一層，超過 64 層拒絕，訊息是 `YAML 錯誤 NESTING_TOO_DEEP（mapping 與序列最多 64 層）`。正常的檔只有 2 層。
- **鍵是 mapping 或序列整份拒絕。**
  - 舊行為：`? [a, b]` 或 `{a: 1}: x` 這種鍵被字串化成名字，頂層的當成不認得的鍵略過，`refs` 裡的因為名字形狀不對被拒。
  - 新行為：任何位置的集合鍵都拒絕，訊息是 `YAML 錯誤 COLLECTION_KEY_NOT_ALLOWED（第 L 行第 C 欄）`，不含鍵。
- 受影響的：受管檔裡用 tab 對齊或縮排、在別的工具多放的頂層鍵底下用了集合鍵或很深的結構的主機，升上來之後 `serve --live` 起不來；沒帶 `--live` 的 serve 照樣起來，但引用受管檔憑證的 MCP 那幾列連線時連不上。

## 遷移

1. 打開 `~/.nexus-agent/.credentials.yaml`（或你設定的 harness home 底下的那一份），把 tab 換成空白。值裡真的要有 tab，改用雙引號寫成 `"a\tb"`。
2. 檔案若是只用 CR 換行（舊的 Mac 編輯器），存成 LF 或 CRLF。
3. 刪掉別的工具多放、nexus 用不到的集合鍵或很深的結構；nexus 只讀 `version` 與 `refs`。
4. 確認改好了：重啟 `serve --live`，起得來；起不來時照訊息裡的行號回檔案裡看。

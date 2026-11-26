---
kind: upgrade-guide
description: "受管憑證檔 `.credentials.yaml` 裡用 mapping 或序列當鍵（`? [a, b]`、`[a]: 1`、`{a: 1}: x`），不論在哪一層，整份拒絕。"
---

# 受管憑證檔拒絕 mapping 或序列當鍵

## 變更

只影響掛受管檔的入口（serve、plugin 試組）。CLI、eval、spike 不讀這份檔，行為不變。

- 舊行為：集合鍵被字串化成名字。頂層的當成不認得的鍵，只警告、照常起動；外來鍵的值底下的不看；`refs` 裡的因為名字不是環境變數形狀被拒，訊息是「refs 第 L 行第 C 欄的鍵不是環境變數形狀的名字」。
- 新行為：任何一層的集合鍵都整份拒絕，訊息是 `YAML 錯誤 COLLECTION_KEY_NOT_ALLOWED（第 L 行第 C 欄）`，不含鍵。`refs` 裡的集合鍵也換成這個訊息，不再是「不是環境變數形狀的名字」。
- 受影響的：受管檔的頂層或別的工具多放的鍵底下有集合鍵的主機，升上來之後 `serve --live` 起不來；沒帶 `--live` 的 serve 照樣起來，但引用受管檔憑證的 MCP 那幾列連線時連不上。依訊息文字判斷錯誤種類的腳本，要認得新的錯誤碼。

## 遷移

1. 打開 `~/.nexus-agent/.credentials.yaml`（或你設定的 harness home 底下的那一份），找到 `?` 開頭的鍵，或 `[`、`{` 開頭、後面接冒號的鍵，刪掉那一段；nexus 只讀 `version` 與 `refs`。
2. `refs` 裡的鍵一律寫成環境變數形狀的名字，例如 `NVIDIA_API_KEY: nvapi-...`。
3. 確認改好了：重啟 `serve --live`，起得來；起不來時照訊息裡的行號回檔案裡看。

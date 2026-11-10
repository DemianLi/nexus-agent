---
kind: upgrade-guide
description: "受管憑證檔 `.credentials.yaml` 裡的 mapping 與序列超過 64 層，整份拒絕。"
---

# 受管憑證檔的巢狀最多 64 層

## 變更

只影響掛受管檔的入口（serve、plugin 試組）。CLI、eval、spike 不讀這份檔，行為不變。

- 舊行為：沒有上限；深到一千多層以上時，`yaml` 解析用光資源，以 `YAML 錯誤 RESOURCE_EXHAUSTION` 拒絕。
- 新行為：根是第 1 層，每往裡一個 mapping 或序列多一層，超過 64 層整份拒絕，訊息是 `YAML 錯誤 NESTING_TOO_DEEP（mapping 與序列最多 64 層）`。正常的檔只有 2 層（`refs:` 底下的 `名字: 值`）。
- 受影響的：受管檔裡有別的工具放進來、超過 64 層的結構的主機，升上來之後 `serve --live` 起不來；沒帶 `--live` 的 serve 照樣起來，但引用受管檔憑證的 MCP 那幾列連線時連不上。

## 遷移

1. 打開 `~/.nexus-agent/.credentials.yaml`（或你設定的 harness home 底下的那一份），刪掉很深的那一段；nexus 只讀 `version` 與 `refs`。
2. 確認改好了：重啟 `serve --live`，起得來。

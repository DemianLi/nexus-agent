---
kind: upgrade-guide
description: 遙測外掛拿掉 mode full，自己疊上去的 telemetry-otel 寫 full 會掉列、什麼都不送；只剩 feedback-only 與 disabled。
---

# 遙測拿掉 `mode: full`

## 變更

v0.5.19 的遙測外掛 `@nexus/plugin-telemetry-otel` 要部署方自己疊一層 patch 才掛，`mode` 有三格：`full`（會話事件全部送出）、
`feedback-only`、`disabled`。新版（PR #804）照 dsh 拿掉 `full`：部署方的設定不能授權捕獲對話內容，只有使用者自己送出的回饋可以。

寫著 `mode: full` 的那一列驗不過，serve 照樣起來，但**那一列沒有掛上，什麼都不送**，連回饋也不送：

```text
警告：1 列沒有掛上，其餘照樣起來：
  telemetry（@nexus/plugin-telemetry-otel）設定驗不過：… mode: Invalid option: expected one of "feedback-only"|"disabled"
```

受影響的：在 home 的 `cordis.patch.yml` 或 `--patch` 覆寫檔裡掛了遙測、而且寫 `mode: full` 的主機。依賴遙測收對話內容的下游（collector 端的儀表板、告警）會斷。

## 遷移

1. 決定要不要留遙測。要留：把那一列的 `mode` 改成 `feedback-only`，只在使用者送出回饋的那一刻，把那條對話到那一刻為止的會話事件送出去。
   在 home 的 `cordis.patch.yml` 裡、升級時會被遷進變更紀錄的，升級後用 `plugin config set <那一列的 id> --file -` 整份換掉
   （`exporter` 那些也要一起寫）；在 `--patch` 檔裡的直接改檔。
   不留：從 `--patch` 檔拿掉那一列，或 `plugin disable <那一列的 id>`。
2. 通知收遙測的那一端：之後只收得到有人送出回饋的那幾條對話。
3. 確認：啟動輸出沒有提到那一列的「設定驗不過」；`feedback-only` 時印的是 `遙測：開啟（只在你送出回饋時）…`。

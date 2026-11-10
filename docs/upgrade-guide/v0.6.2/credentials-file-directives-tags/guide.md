---
kind: upgrade-guide
description: "受管憑證檔 `.credentials.yaml` 裡的 YAML 指令（`%YAML`、`%TAG`）與明示 tag（`!!str`、`!!binary`、`!foo`、`!`）整份拒絕；執行期同一個錯誤恢復後再出，會再警告一次。"
---

# 受管憑證檔拒絕 YAML 指令與明示 tag

## 變更

只影響掛受管檔的入口（serve、plugin 試組）。CLI、eval、spike 不讀這份檔，行為不變。

- **YAML 指令整份拒絕。**
  - 舊行為：`%YAML 1.2`、`%TAG …`、不認得的 `%…` 都收下。`%YAML 1.1` 會換成 YAML 1.1 的規則，例如 `yes` 解成 `true`，那一把就因為「要是字串」被拒。
  - 新行為：任何指令都拒絕，訊息是 `YAML 錯誤 DIRECTIVE_NOT_ALLOWED（第 L 行第 C 欄）`。
- **明示 tag 整份拒絕。**
  - 舊行為：`!!str 678` 解成字串照收；`!!binary` 解成位元組，因為「要是字串」被拒；`!foo` 這種不認得的 tag 當成字串照收。
  - 新行為：鍵、值、mapping、文件開頭上的任何 tag 都拒絕，包括 `!!str`、非特定的 `!`、逐字的 `!<…>`。訊息是 `YAML 錯誤 TAG_NOT_ALLOWED（第 L 行第 C 欄）`，不含值。
  - 值裡、引號裡、區塊值裡、註解裡的 `!` 與 `%` 不受影響。
- **同一個重載錯誤恢復後再出，會再警告一次。**
  - 舊行為：例如 `stat` 遇到 `EACCES` 警告一次，恢復之後又出 `EACCES`，第二次不再警告。
  - 新行為：讀成功一次之後就重新算，第二次也會警告。
- 受影響的：受管檔裡用了 `%YAML` 指令或 `!!str` 這類 tag 的主機，升上來之後 `serve --live` 起不來。

## 遷移

1. 打開 `~/.nexus-agent/.credentials.yaml`（或你設定的 harness home 底下的那一份），刪掉開頭的 `%YAML`、`%TAG` 行；`---` 可以留著。
2. 把值前面的 tag 拿掉。要讓數字或 `yes` 這類字當字串，改用引號：`A: !!str 678` 改成 `A: "678"`。
3. 確認改好了：重啟 `serve --live`，起得來；起不來時照訊息裡的行號回檔案裡看。

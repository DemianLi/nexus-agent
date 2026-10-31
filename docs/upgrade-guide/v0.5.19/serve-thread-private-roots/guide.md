---
kind: upgrade-guide
description: 給了 --workspace 的 serve，新 thread 寫的檔不再落在 --workspace，改進 home 底下各自的私有根；--workspace 對新 thread 變成唯讀的 /shared。
---

# 新 thread 各有私有可寫根，`--workspace` 變成唯讀共用區

## 變更

v0.5.19 的 `serve` 上，每條對話都以 `--workspace` 為可寫根：模型寫的檔都落在那裡，所有對話彼此讀得到、蓋得掉。

新版（PR #1795）給了 `--workspace` 時，新開的對話（新 thread）這樣跑：

- **可寫根是私有的**：`<home>/thread-roots/thread-<32 位十六進位>`，權限 `0700`，同一條 thread 重啟後落回同一個目錄。基底寫死在 home 底下，沒有設定列，要換位置就換 `NEXUS_AGENT_HOME`。
- **`--workspace` 掛成 `/shared`**：唯讀、所有新 thread 共用，任何權限組合都寫不進去，也不能升級。部署方放在 `--workspace` 根目錄的指示檔與技能來源照樣生效，從這裡讀；私有根裡的 `AGENTS.md` 與 `skills/` 不讀。模型讀 `/shared/` 的內容另外標成不可信，見 [`shared-content-marked-untrusted`](../shared-content-marked-untrusted/guide.md)。
- **不會自動清**：thread 刪了或過期了，私有根還在。

升級之前就有的對話（舊 thread）不搬，照舊以 `--workspace` 為可寫根，沒有 `/shared`，彼此照舊看得到對方的檔。它們有一項新限制，見 [`legacy-thread-shared-writes-refused`](../legacy-thread-shared-writes-refused/guide.md)。

啟動多三種拒絕，任何一種 `serve` 都起不來，訊息會寫明原因：

- `<home>/thread-roots` 跟 `--workspace`、工具結果暫存根、附件根或會話日誌目錄重疊（兩個方向，解開符號連結再比）。
- 基底不屬於目前使用者，或群組、其他人可寫。基底還沒建時驗的是 home。
- 關掉 `session-persistence` 又給 `--sandbox`。關掉落盤時沒有地方記根，新 thread 的可寫根是記憶體裡的虛擬檔案系統，重啟就沒了；沒給 `--sandbox` 也一樣，啟動時會印一行 `[私有根]` 警告。

受影響的：所有給了 `--workspace` 的 `serve`，特別是會從 `--workspace` 收模型產出、或靠不同對話共用檔案的部署。CLI 與沒給 `--workspace` 的 `serve` 不受影響。

## 遷移

1. 找新 thread 產出的地方改成 `<home>/thread-roots/`。要知道某條 thread 用哪個目錄，看它會話日誌第一行 header 的 `workspaceRoot`。
2. 要讓所有對話都讀得到的參考資料，放進 `--workspace`；模型會在 `/shared/` 底下讀到。新 thread 之間不能再靠寫檔交換資料。
3. 把 `<home>/thread-roots` 算進磁碟用量與備份範圍。清理要自己做：用 header 的 `workspaceRoot` 對出目錄，確認裡面的產出不要了再刪。
4. 檢查 home 的擁有者與權限，照 [`docs/operations.md`〈serve：每條 thread 一個私有可寫根〉](../../../operations.md#serve每條-thread-一個私有可寫根) 的條件調整。
5. 舊 thread 要隔離，只能開新 thread；系統不會搬檔，要沿用的檔自己放進 `--workspace` 給新 thread 讀。
6. 回滾前先看 [`docs/operations.md`〈升級與回滾〉](../../../operations.md#升級與回滾)：header 記著私有根的對話，回到舊版會被工作區守衛拒絕續接。
7. 確認：起 `serve`，開一條新 thread 請模型寫一個檔，`<home>/thread-roots/` 底下多出一個 `thread-…` 目錄，檔在裡面，`--workspace` 底下沒有；再請它寫 `/shared/` 底下的路徑，應該被拒絕。

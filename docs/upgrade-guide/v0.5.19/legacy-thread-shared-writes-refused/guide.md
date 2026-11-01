---
kind: upgrade-guide
description: 舊 thread 寫不進 --workspace 根目錄的四個指示檔、技能來源目錄與共用區的記憶來源，回 [containment] 拒絕；升級前寫進去的要部署方自己核對。
---

# 舊 thread 寫不進指示檔、技能目錄與記憶來源

## 變更

v0.5.19 的 serve 上，每條對話都以 `--workspace` 為可寫根。升上來之後，新開的對話（新 thread）各有私有可寫根，並把 `--workspace`
掛成唯讀的 `/shared`，從那裡讀三樣東西：

- 根目錄的 `AGENTS.md`、`CLAUDE.md`、`AGENTS.local.md`、`CLAUDE.local.md`，送進每條新 thread 當工作區指示；
- 技能來源底下的技能（出廠 `skills/`），列進模型的清單，人打 `/名字` 也叫得出；
- 掛了選配的 `memory` 插件時，`sources` 裡寫成 `/shared/…` 的檔，併進每條新 thread 的 system prompt。

升級之前就有的對話（舊 thread）照舊以 `--workspace` 為可寫根。舊 thread 的模型寫進上面這幾處的東西，會變成之後每一條新 thread 的指示、技能或記憶，
不分使用者。新版（#1960、#2270）對舊 thread 擋住這幾處：

| 舊 thread 的變更 | 結果 |
| --- | --- |
| 寫、改、刪 `--workspace` 根目錄的那四個指示檔 | 回 `[containment]` 拒絕 |
| 寫、改、刪技能來源裡落在 `--workspace` 底下的目錄（含底下全部） | 回 `[containment]` 拒絕 |
| 寫、改、刪 `memory` 的 `sources` 裡 `/shared/…` 對應的檔（`/shared/MEMORY.md` 在舊 thread 是 `/MEMORY.md`） | 回 `[containment]` 拒絕 |
| 對上面這幾處呼叫 `request_sandbox_escalation` | 直接回不能升級與原因，不掛核准卡（#2078） |
| 根目錄別的檔、子目錄裡的同名檔（例如 `sub/AGENTS.md`）、技能來源以外的目錄 | 照常 |

不看檔案政策，`danger-full-access` 與核准過的升級都蓋不過；比對時不分大小寫。新 thread 與 CLI 不受影響。

受影響的：拿 `AGENTS.md` 這類檔名、或拿 `skills/` 當工作筆記的舊 thread，會被擋。這道守衛只擋得到升級之後的寫入；
升級之前任何一條對話寫進這幾處的檔都還在，新 thread 照樣會讀。

## 遷移

1. 不需要改任何設定。
2. 停掉 serve 或確認沒有對話在跑，看 `--workspace` 根目錄有沒有 `AGENTS.md`、`CLAUDE.md`、`AGENTS.local.md`、`CLAUDE.local.md`：

   ```bash
   ls -l <--workspace>/AGENTS.md <--workspace>/CLAUDE.md <--workspace>/AGENTS.local.md <--workspace>/CLAUDE.local.md
   ```

   每一份都打開看，確認是部署方自己放的。不是的就刪掉或改回來。
3. 用 `--dump-config` 看 `skills` 那一列的 `config.sources`（沒寫就是出廠的 `/skills/`）。落在 `--workspace` 底下的每一個目錄，逐一確認
   裡面的技能都是部署方自己放的；不是的整個技能目錄刪掉。掛了 `memory` 插件的，同樣看它的 `config.sources`，`/shared/…` 對應的檔逐一打開確認。
4. 舊 thread 要繼續留筆記的，請它換檔名或放進子目錄。
5. 確認：起 serve 之後，在一條舊 thread 裡請模型寫 `/CLAUDE.md`，工具結果應該是 `[containment]` 開頭的拒絕，`--workspace` 底下沒有多出這個檔；
   再開一條新 thread，指示裡只有第 2 步留下的那幾份。舊 thread 的範圍見
   [`docs/operations.md`〈serve：每條 thread 一個私有可寫根〉](../../../operations.md#serve每條-thread-一個私有可寫根)。

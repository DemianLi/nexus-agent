---
kind: upgrade-guide
description: 模型請的單次升級最多到 workspace-write，request_sandbox_escalation 不再收 danger-full-access；workspace-write 之下寫到工作區外直接拒絕。
---

# 單次升級最多到 workspace-write

## 變更

v0.5.19 裡，模型在被圍堵擋下時可以呼叫 `request_sandbox_escalation`，要求升到 `workspace-write` 或 `danger-full-access`，
人在核准卡上點頭之後，那一個檔的下一次變更就在那一格跑。所以會話在 `workspace-write` 時，經往外指的符號連結寫到工作區外的檔，
拒絕後面會接一行「可以升級」的指引，人核准之後就寫得進去。

新版（#1982，#1827 D23）的升級最多到 `workspace-write`：

- `request_sandbox_escalation` 的 `sandbox_permissions` 只收 `workspace-write`。送 `danger-full-access` 會在參數檢查那一關被擋，
  不會出核准卡。
- 會話在 `workspace-write` 時沒有升級可走：寫到可寫根外直接拒絕（`FS_SANDBOX_DENIED`），拒絕後面**不再**接升級指引。
- 會話在 `read-only` 時照舊：被擋下會接指引，可以請升到 `workspace-write`。
- 升級前還掛著的升級核准卡，升級時一定要重啟 serve；核准卡的接續狀態只在記憶體裡，重啟之後接不回來，要模型重新請。
- 經 `/permission` 切的會話層模式不受影響：權限表裡加回了全開那一組的部署，人照樣切得到全開。

受影響的是：靠「模型請升級、人核准」把檔寫到工作區外的使用方式。

## 遷移

1. 確認有沒有人靠這條路寫工作區外的檔：在 home 底下的 `sessions/` 找升到全開的升級請求，
   `grep -rl '"sandbox_permissions":"danger-full-access"' ~/.nexus-agent/sessions`（設過 `NEXUS_AGENT_HOME` 的換成那個目錄）。
   沒有輸出就不受影響，後面幾步不必做。
2. 有的話，決定怎麼處理：
   - **那些檔應該在工作區裡**：把它們搬進 `--workspace` 指的目錄，或把連結換成實際的檔案與目錄（連結見升級指南
     [`read-outward-symlinks-refused`](../read-outward-symlinks-refused/guide.md)）。
   - **真的要讓會話寫工作區外**：照 [`docs/operations.md`](../../../operations.md)〈權限組合：`/permission`〉把全開那一組加回權限表，
     由人自己用 `/permission` 切；多人共用主機上不要這樣做（同一份文件〈全開權限模式〉）。
3. 確認：開一條新 thread，在 `workspace-write` 之下請模型寫一個工作區外的檔（例如經往外指的連結）。會話日誌裡那一筆 `tool/result`
   帶 `"code":"FS_SANDBOX_DENIED"`，模型看到的拒絕裡沒有 `request_sandbox_escalation`。

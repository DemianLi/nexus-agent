---
kind: upgrade-guide
description: read_file 工具描述講行號的那一句改了，模型看到的字變了，依賴舊描述的快取與比對要更新。
---

# read_file 工具描述改寫行號格式與禁止範圍

## 變更

v0.5.19 的 `read_file` 描述寫行號後面是「two spaces」，並只說編輯時不要帶行號前綴。實際輸出是右靠齊的行號加 tab，`write_file` 帶著前綴不會出錯，會把前綴寫進檔案。

新版（[#2286](https://github.com/DemianLi/nexus-agent/issues/2286)）：描述改成行號後面是 tab，並寫明行號與 tab 不是檔案內容，不要放進 `write_file` 的 `content`、`edit_file` 的 `old_string` 或 `new_string`。`read_file` 的輸出形狀沒有變，舊會話日誌不受影響。

**這是提示，不是防線。** 模型仍可能把前綴寫進檔案，寫入時沒有檢查。

受影響的：逐字比對工具描述的外部工具；依工具定義算提示快取或 token 基準的部署（這一句變長，第一次請求不會命中舊快取）。

## 遷移

1. 一般部署：不用改設定，升上來就是。
2. 比對工具描述的工具：把基準換成新的描述，全文見 `docs/tool-catalog.md` 的 `read_file`。
3. 叫模型複製或改寫重要檔案時，照舊檢查結果，不要假設一定沒有前綴。
4. 確認：在安裝目錄跑 `grep -rl --include='*.js' 'then a tab, then the source line' .`，有列出檔案就是新描述。

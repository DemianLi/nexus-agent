---
kind: upgrade-guide
description: 工作區指示檔改成整份讀；單檔超過 1 MiB（maxSourceBytes）的整份不讀、也不提示，那份規則從模型基線上消失。
---

# 工作區指示檔整份讀，單檔超過 1 MiB 不讀

## 變更

`agent-instructions` 那一列（出廠就掛）讀工作區根的四個候選檔：`AGENTS.md`、`CLAUDE.md`、`AGENTS.local.md`、`CLAUDE.local.md`。
新版（#1533）改了兩件事：

1. **超過 500 行的檔改成整份讀。** v0.5.19 讀到第 500 行就停，而且不提示。新版整份讀，第 500 行之後的規則也會進模型。
   渲染預算照舊是 `maxBytes`（預設 64 KiB）：幾份檔合起來超過預算時，照舊附一段 `Workspace instruction budget …` 截斷說明。
   受影響的是指示檔超過 500 行的主機：模型會看到更多規則，基線也會變長。這一點不必遷移。
2. **單檔超過 `maxSourceBytes`（預設 1 MiB，1048576 位元組）的整份不讀，也不提示。** 大小用 UTF-8 位元組算。
   v0.5.19 沒有單檔上限，再大的檔都會讀前 500 行。新版遇到超過上限的檔，就像那份檔不存在：其他候選照讀，
   日誌和啟動輸出都沒有提示。這和 dsh 的做法相同（`packages/context/agent-instructions/src/files.ts:397`、`:404-408`）。
   受影響的是有任何一份候選檔超過 1 MiB 的主機：升級後那份檔的規則整份不見。

## 遷移

1. 找出超過上限的指示檔。在 `--workspace` 指的那個目錄跑：
   `find . -maxdepth 1 -type f -size +1048576c \( -name AGENTS.md -o -name CLAUDE.md -o -name AGENTS.local.md -o -name CLAUDE.local.md \)`。
   沒有輸出就不受影響，後面幾步不必做。
2. 擇一處理：
   - **拆小**（建議）：把檔案拆到 1 MiB 以下。上限是單檔算的，所以可以把一部分移到另一個候選檔（例如 `AGENTS.local.md`）。
     不過四份合起來仍受 `maxBytes`（預設 64 KiB）限制，超過的部分會被截斷。
   - **調高上限**：在 `agent-instructions` 那一列的 `config` 寫 `maxSourceBytes`（正整數，單位是位元組）。
     `config` 是整份替換，`maxBytes` 有調過的話要一起寫出來，例如：

     ```yaml
     - id: agent-instructions
       config:
         maxSourceBytes: 4194304
     ```

     寫在 `--patch` 檔的直接改檔；用變更紀錄管設定的，用 `plugin config set agent-instructions --file -` 整份換掉。
3. 確認：啟動輸出裡沒有 `agent-instructions` 的「設定驗不過」。然後在那個工作區開一條新 thread 說一句話，
   會話日誌（home 底下的 `sessions/`）裡會多一筆 `user/message`，`source.plugin` 是 `AgentInstructionsMiddleware`，
   內容含 `Instructions from: AGENTS.md`（或你放的那份檔名），而且看得到那份檔最後一行的規則。

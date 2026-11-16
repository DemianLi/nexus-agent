---
kind: upgrade-guide
description: "超過上限的工作區指示檔（`AGENTS.md` 等）從截斷改成整份不放、只留一行指標；指示檔、技能目錄、技能正文、記憶檔的上限在小窗口模型上變小；system prompt 頭尾段與計劃模式指引超過 16,384 位元組時改成起不來。"
---

# 注入來源超過上限時改成延後或失敗

## 變更

對話與工具結果以外、會把文字放進模型請求的來源，現在各自照一張預算表執行上限（表與每個來源的行為見 [`docs/operations.md`](../../../operations.md) 的〈各注入源的用量〉）。

- **工作區指示檔（`agent-instructions`）。**
  - 舊行為：合起來超過 `maxBytes`（預設 65,536 位元組）時，較寬層的檔被略過，**最具體的那一份截斷後放進去**，並換一段較短的開場白。
  - 新行為：不截斷。放不下的檔**整份不放**（包含最具體的那一份），那一則訊息裡留一行 `Workspace instruction budget N bytes: not loaded <路徑> (<大小> bytes); read each with read_file before acting on this workspace.`，模型要自己用 `read_file` 讀。
  - 上限也變了：`min(maxBytes, floor(模型窗口 × 4 × contextFraction))`，`contextFraction` 是新的設定鍵，預設 0.1。窗口 32,768 的模型上是 13,107 位元組，以前是 65,536。
- **`/名字` 叫用的技能正文（`skill-invocation`）。**
  - 舊行為：沒有上限，整份放進去。
  - 新行為：超過 `min(65,536, floor(模型窗口 × 4 × 0.1))` 位元組的那一份整份不放，換成一行指到 `SKILL.md` 的指標。這一列多了 `maxBytes` 與 `contextFraction` 兩個設定鍵。
- **技能目錄與記憶檔。**
  - 舊行為：沒有整段的上限。
  - 新行為：整段超過 `min(32,768, floor(模型窗口 × 4 × 0.05))` 位元組時，放不下的技能條目整條不列、記憶檔整份不放，各留一行指標。沒有設定鍵。
- **system prompt 的頭段、尾段。**
  - 舊行為：沒有上限。
  - 新行為：各自超過 16,384 位元組時，`system-prompt` 那一列在組 thread 時失敗（`SystemPromptBudgetError`）。
- **計劃模式的 `guidance`。**
  - 舊行為：沒有上限。
  - 新行為：超過 16,384 位元組時，`plan-mode` 那一列在載入設定時失敗。
- **`@nexus/agent-loop` 契約升到 1.4.0**：`agent/pre-step` 的 listener 多收一格選填的 `contextWindow`。只加選填欄位，宣告 `^1.x` 的既有 listener 照常；`@nexus/plugin-agent-instructions` 與 `@nexus/plugin-skills/invocation` 現在宣告 `^1.4.0`。
- **`@nexus/plugin-agent-instructions` 不再匯出 `COMPACT_AGENT_INSTRUCTIONS_INTRO`**（截斷時用的那段開場白）。

受影響的：

- 工作區指示檔合計超過上限的部署：模型以前看得到截斷後的前半份，現在只看得到一行指標。
- 用小窗口模型（窗口在 163,840 token 以下）而指示檔、技能正文超過窗口一成的部署。
- system prompt 頭尾段或計劃模式指引超過 16,384 位元組的部署：升級後起不來。
- 自己寫的插件 import 了 `COMPACT_AGENT_INSTRUCTIONS_INTRO`。

## 遷移

1. 量你的指示檔：在工作區跑 `wc -c AGENTS.md`（以及子目錄裡的指示檔）。合計在 65,536 位元組以下、而且不超過你的模型窗口 × 0.4 位元組的，不用動。
2. 超過的，擇一：把指示檔縮短或拆到模型會照需要去讀的檔案；或在 `agent-instructions` 那一列調高 `maxBytes`、`contextFraction`（`pnpm --filter @nexus/harness run plugin -- config set agent-instructions --file -`）。
3. 量 system prompt 頭尾段（`system-prompt` 那一列的 `personaPrefix`、`personaSuffix` 與其他插件登記在頭尾的段）與 `plan-mode` 的 `guidance`：各自超過 16,384 位元組的要縮短，這兩項沒有可調的上限。
4. 自己的插件裡搜尋 `COMPACT_AGENT_INSTRUCTIONS_INTRO`：刪掉那個 import；要認「這一則有檔沒放進去」，改看訊息文字裡的 `not loaded`，或訊息 `additional_kwargs` 的 `nexus_injection_deferred_bytes`。
5. 確認改好：開一條新的 thread 說一句話，在會話日誌裡找最後一筆 `context/measure`，看 `sources`：沒有任何一列帶 `deferredBytes`，就是全部都放進去了；有的話，那一列的 `id` 就是還放不下的來源。

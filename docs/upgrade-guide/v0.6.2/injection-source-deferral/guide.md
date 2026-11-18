---
kind: upgrade-guide
description: "超過上限的工作區指示檔（`AGENTS.md` 等）仍然截斷最具體的那一份，但通知行改了格式並多了讀檔指標、整份放得下的較寬層檔會留下、上限在小窗口模型上變小；技能目錄、技能正文、記憶檔放不下時改成整項不放、留一行指標；system prompt 頭尾段與計劃模式指引超過 16,384 位元組時改成起不來。"
---

# 注入來源超過上限時各自截斷、延後或失敗

## 變更

對話與工具結果以外、會把文字放進模型請求的來源，現在各自照一張預算表執行上限（表與每個來源的行為見 [`docs/operations.md`](../../../operations.md) 的〈各注入源的用量〉）。

- **工作區指示檔（`agent-instructions`）。**
  - 舊行為：整則訊息超過 `maxBytes`（預設 65,536 位元組）時，從最寬層開始整份略過，直到剩下的整份放得下；一份都放不下時，只截斷最具體的那一份、其餘全部略過，並換一段較短的開場白（`Workspace instructions were omitted or truncated to fit the configured byte budget.`）。通知行是 `Workspace instruction budget N bytes: omitted <路徑>, …; truncated <路徑> from A to B bytes`，沒有被略過的檔的大小，也沒有怎麼讀。
  - 新行為：超過時仍然截斷最具體的那一份，差別有四處。
    - 先從最具體的往寬的挑，整份放得下的都留下；剩下整份放不下的檔，取其中最具體的那一份截成放得下的最長檔頭，其餘整份不放。以前較寬層一律先被略過。
    - 截下來不到 256 位元組就不截，這一份改成整份不放、只留通知（以前會一路截到只剩標題）。
    - 開場白一律是完整的那一段，不再換短的。
    - 通知行改成三種，一行寫清楚哪一份被截、哪幾份沒放、其餘用 `read_file` 讀（路徑是讀檔用的路徑）：
      - 只截斷：`Workspace instruction budget N bytes: truncated <路徑> from A to B bytes; read the rest of <路徑> with read_file before acting on this workspace.`
      - 只整份沒放：`Workspace instruction budget N bytes: not loaded <路徑> (<大小> bytes), …; read each with read_file before acting on this workspace.`
      - 兩者都有：`Workspace instruction budget N bytes: truncated <路徑> from A to B bytes, not loaded <路徑> (<大小> bytes), …; read the rest of <路徑> and each unloaded file with read_file before acting on this workspace.`
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

- 工作區指示檔合計超過上限的部署：模型看到的仍是截斷後的檔頭，但較寬層放得下的檔現在會留下，通知行的字串變了（解析舊通知字串的下游要改）；小窗口模型上上限也比以前小。
- 用小窗口模型（窗口在 163,840 token 以下）而指示檔、技能正文超過窗口一成的部署。
- system prompt 頭尾段或計劃模式指引超過 16,384 位元組的部署：升級後起不來。
- 自己寫的插件 import 了 `COMPACT_AGENT_INSTRUCTIONS_INTRO`。

## 遷移

1. 量你的指示檔：在工作區跑 `wc -c AGENTS.md`（以及子目錄裡的指示檔）。合計在 65,536 位元組以下、而且不超過你的模型窗口 × 0.4 位元組的，不用動。
2. 超過的，擇一：把指示檔縮短或拆到模型會照需要去讀的檔案；或在 `agent-instructions` 那一列調高 `maxBytes`、`contextFraction`（`pnpm --filter @nexus/harness run plugin -- config set agent-instructions --file -`）。
3. 量 system prompt 頭尾段（`system-prompt` 那一列的 `personaPrefix`、`personaSuffix` 與其他插件登記在頭尾的段）與 `plan-mode` 的 `guidance`：各自超過 16,384 位元組的要縮短，這兩項沒有可調的上限。
4. 自己的插件裡搜尋 `COMPACT_AGENT_INSTRUCTIONS_INTRO`：刪掉那個 import；要認「這一則有檔沒放完」（被截或整份沒放），改看訊息文字裡的 `Workspace instruction budget`，或訊息 `additional_kwargs` 的 `nexus_injection_deferred_bytes`。
5. 確認改好：開一條新的 thread 說一句話，在會話日誌裡找最後一筆 `context/measure`，看 `sources`：沒有任何一列帶 `deferredBytes`，就是全部都放進去了；有的話，那一列的 `id` 就是還放不下的來源。指示檔那一列的 `deferredBytes` 是沒放進去的位元組：被截的算被截掉的那一段，整份沒放的算整份。

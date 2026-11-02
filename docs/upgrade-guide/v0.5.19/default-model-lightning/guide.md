---
kind: upgrade-guide
description: 出廠預設模型換成 nemotron-3.5-lightning-30b-a3b，舊型號拿出型錄，記著舊型號的會話要改選模型才送得出去。
---

# 出廠預設模型換成 nemotron-3.5-lightning-30b-a3b

## 變更

v0.5.19 出廠的 `live-model` 預設是 `nvidia/nemotron-3-super-120b-a12b`。這顆已經叫不動（`404 Not found for account`）。

新版（[#1974](https://github.com/DemianLi/nexus-agent/issues/1974)）：

- `modelId` 與型錄那一筆換成 `nvidia/nemotron-3.5-lightning-30b-a3b`，窗口宣告 784,369，`maxTokens` 16384，純文字；舊型號拿出出廠型錄。
- 這顆比舊型號慢，2026-09-04 的基準是一題 38.4 秒、多叫 1.33 次工具（舊型號 8.0 秒、0.29 次），回覆也多推理 token。逾時、摘要門檻的出廠值沒有改。
- **舊會話**：記著的模型不在型錄上時，下一句自動走部署預設，手動選過的也一樣，推理強度回到預設，模型會收到一則換模型通知。
  選擇留在日誌，那顆回到型錄就走回它。日誌的 `model/start.route` 記實際走的模型。

受影響的：沒有覆寫 `live-model` 的 `serve` 與 CLI 部署；用 `--patch` 或設定寫死舊型號的部署；`subagent-model-selection`、
`thread-title-llm`、`allowedModels` 等處指名舊型號的設定（不在型錄就起不來或被拒）；自己讀 `model/start` 的 `route`、依模型算成本的工具。

## 遷移

1. 要新的預設：不用改設定，升上來就是。
2. 用 `--patch` 覆寫過 `live-model` 的 `models`（整份取代，不是逐筆合併）：把舊型號那一筆換成新型號，連 `reasoningEfforts`、`tokenizer`、`compat` 一起照 `apps/harness/cordis.yml` 重述。
3. 其他地方指名舊型號的（`allowedModels`、子代理的 `model`、標題的 `modelId`）：改成型錄上有的 id。
4. 使用中的舊會話：不用動，下一句就走新預設。要用別顆，在 web 的模型座改選。
5. 確認：`serve --live` 開一條新會話送一句，會話日誌的 `model/start` 的 `route.model` 是 `nvidia/nemotron-3.5-lightning-30b-a3b`。

---
kind: upgrade-guide
description: 型號 id 含 `codex`、`gpt-5.2-pro`、`gpt-5.4-pro`、`gpt-5.5-pro` 的模型，請求從 Responses API 改打 Chat Completions；只收 Responses 的端點會讓那一輪失敗。
---

# 型號名不再讓請求改走 Responses API

## 變更

只影響 `live-model` 的 `models` 型錄裡，`id` **包含**下面任一段字的模型。判斷看「包含」，不是「等於」：

- `codex`（例如 `gpt-5-codex`、`my-codex-model`）
- `gpt-5.2-pro`
- `gpt-5.4-pro`
- `gpt-5.5-pro`

舊版與新版的差別：

- **舊版**：模型轉接器是 `@langchain/openai` 1.5.10 的 `ChatOpenAI`。型號名含上面任一段字時，請求會自動改打 `<baseUrl>/responses`（Responses API）。
- **新版**（[#2361](https://github.com/DemianLi/nexus-agent/issues/2361)）：轉接器只有 Chat Completions 一條路。不管型號名是什麼，請求一律打 `<baseUrl>/chat/completions`。
- **升級後會看到什麼**：要看端點收不收這個型號的 Chat Completions。
  - 收的：照常回覆。
  - 只收 Responses 的：每一次呼叫這顆都會失敗。那一輪以失敗結束，`turn/failed.error.code` 是端點回的狀態對到的碼：400 是 `INVALID_REQUEST`，404 這類其他 4xx 是 `HTTP_<狀態>`。這些碼不重打。
  - 錯誤訊息的原文由端點決定。
- **沒有替代做法**：nexus 現在沒有走 Responses API 的路，沒有設定可以讓這顆改回 Responses。

受影響的：型錄有這類型號、而且端點只收 Responses 的部署。標題的 `modelId`、子代理選的模型等處指名的型號，同樣算在內。

不受影響的：

- 出廠型錄（`apps/harness/cordis.yml`）沒有這類型號。
- 型錄裡沒有這類型號的部署，請求本文與以前相同。
- 從型錄設定得到的欄位（`reasoningEfforts`、`compat.chatTemplateKwargs` 等）都不會讓請求改走 Responses。

## 遷移

1. 找出型錄裡受影響的 id。依序看設定的三層，搜 `codex` 與 `-pro`，每個符合的 id 再對一次上面的四段字：
   - 出貨的 `apps/harness/cordis.yml`、`cordis.serve.yml`；
   - 變更紀錄 `$NEXUS_AGENT_HOME/plugin-journal.jsonl`（預設 `~/.nexus-agent/plugin-journal.jsonl`）；
   - 每一個 `--patch <檔>`。

   都沒有，就不用做後面幾步。
2. 有的話，確認端點收不收這個型號的 Chat Completions。用同一個 `baseUrl` 與金鑰，對 `<baseUrl>/chat/completions` 送一個這個型號的請求，看是成功還是 4xx。
3. 端點收的：不用改。
4. 端點不收的：把那一筆換成端點用 Chat Completions 收得了的型號。
   - 寫 `models` 是整份取代：用 `--patch` 或 `plugin config set live-model --file -` 重寫整份型錄，連其他筆一起重述。
   - `modelId`，以及標題、子代理等處指名這個型號的地方，一起改成型錄上留著的 id。
5. 確認改好了：`serve --live` 開一條新會話送一句。會話日誌的 `model/start` 的 `route.model` 是你要的型號，而且這一輪沒有 `turn/failed`。

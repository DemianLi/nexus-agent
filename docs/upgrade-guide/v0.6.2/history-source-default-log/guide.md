---
kind: upgrade-guide
description: 模型歷史的來源預設從 `state` 改成 `log`：關掉 `history-source` 那一列不再等於 `state`，推不回模型歷史的老日誌續接時，第一次模型呼叫會失敗而不是從空歷史開始。
---

# 模型歷史預設從會話日誌推

## 變更

影響 CLI 與 `serve`（背景冷啟、樹上入口走同一條組裝）。裸呼叫 `createNexusAgent`、不掛會話日誌的嵌入方不受影響：沒有入口給的預設時仍是 `state`。

- **出廠值。**
  - 舊行為：`cordis.yml` 的 `history-source` 那一列寫 `source: state`，模型看到的是 LangGraph state 裡的歷史。
  - 新行為（[#2362](https://github.com/DemianLi/nexus-agent/issues/2362)）：出廠寫 `source: log`，root 每次呼叫模型之前，改送從會話日誌推出來的歷史。找不到日誌、推不回來，這次呼叫就失敗，不退回 `state`。
- **只講 root。** 子代理的模型歷史仍走 `state`，`log` 時也一樣；`built.historySource` 與 `--history-source` 說的也只是 root。
- **關掉那一列的意思變了。**
  - 舊行為：`disabled: true`、或整列掉下來（模組載不進來、設定驗不過），都落回 `state`，跟寫 `source: state` 同一個結果。
  - 新行為：入口給的預設是 `log`，關掉或掉下來都是 `log`。**關掉那一列不會有警告**（`disabled: true` 是部署方明講）；掉下來照舊印「N 列沒有掛上」那一段。
- **老日誌續接會失敗。**
  - 舊行為：`--resume` 或 `serve` 重開之後，推不回模型歷史的日誌（格式 9 以前寫的、少了回覆或工具結果的）印「對話從空的開始：…」，模型用空歷史繼續。
  - 新行為：CLI 的續接開頭改印「這條對話推不回模型歷史，第一輪會失敗：…」，第一次模型呼叫失敗，訊息點名原因與出路。`serve` 上客戶端收到同一則訊息（`error`，`errorCode` 是 `UNKNOWN`），伺服器日誌在接回那條 thread 時寫同一句預告。
  - 推得回來的日誌不受影響，續接與以前一樣。
- **自己 copy 的清單不會被改。** 清單裡 `history-source` 寫了 `source: state` 的，仍是 `state`，不會被預設蓋成 `log`。

受影響的：
- 靠關掉 `history-source` 那一列拿 `state` 的部署；
- 手上有格式 9 以前的老日誌、還要續接的 CLI 使用者與 `serve` thread。

## 遷移

1. 要維持 `state`：在 `cordis.yml`、`--patch` 檔或變更紀錄裡，把 `history-source` 那一列明寫成 `config: { source: state }`；只有 CLI 還可以帶 `--history-source state`（`serve` 沒有這個旗標）。不要靠關掉那一列。
2. 有老日誌要續接：選一條。
   - 照 1. 用 `state` 續接，模型從空歷史開始，舊內容不進模型；
   - 另開一條對話，舊日誌留著當紀錄。
3. 自己 copy 的 `cordis.yml`：不必動；想換成 `log`，把那一列的 `source` 改成 `log`（或整列刪掉 `source`，空的 `config` 就是 `log`）。
4. 確認改好了：CLI 用 `--resume` 續接一份老日誌，開頭那一行是「對話從空的開始」（`state`）或「第一輪會失敗」（`log`），符合你選的；`serve` 看伺服器日誌裡 `[會話日誌] thread "<id>" 接回來了：` 那一句。

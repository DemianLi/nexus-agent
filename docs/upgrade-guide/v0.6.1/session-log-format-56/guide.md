---
kind: upgrade-guide
description: 會話日誌的格式升到 56，點名子代理時記下 root 手上的委派工具；新版續接或新開過的對話 v0.6.1 讀不了。
---

# 會話日誌格式升到 56

## 變更

新版的會話日誌是格式 56（[#2649](https://github.com/DemianLi/nexus-agent/issues/2649)），在
[55](../../v0.6.0/session-log-format-55/guide.md) 之上只改一樣。每一版改了什麼，紀錄在
[`packages/nexus-core/src/session-store.ts`](../../../../packages/nexus-core/src/session-store.ts) 裡 `SESSION_LOG_FORMAT_VERSION` 的說明。

- **點名多記一格 `tool`**：`turn/start`（`kind: 'message'`）與佇列項（`inbox/spliced` 的 `inserted[]`）上的 `mention`
  多一格選填的 `tool`，值是 `task` 或 `subagent`，記的是收下那句話時 root 手上的委派工具。送進模型的點名提示照它組字：
  背景續行模式（root 只有 `subagent`）寫 `subagent`，一次性模式寫 `task`。
  - 舊行為：不論哪一種模式，提示都寫 `task`；背景續行模式下 root 手上沒有 `task`，模型照提示去叫會叫不到。
  - 沒有 `tool` 的舊日誌照 `task` 的字重放，跟當初送出的逐位元組相同。
- **續接與遷移、單向**：同 [53](../../v0.6.0/session-log-format-53/guide.md) 那一份，世代檔換成 `session.v56.jsonl`。
  v0.6.1 讀到 56 的檔會拒讀，不會猜。

受影響的：之後可能要退回 v0.6.1 的主機；自己解析會話日誌、讀 `mention` 的程式。

## 遷移

1. 往前升不用做任何事。
2. 可能要退回的話，同 [53](../../v0.6.0/session-log-format-53/guide.md) 那一份的第 2 步：升級前備份，退回時還原備份。
3. 自己解析會話日誌的程式，`mention` 多出 `tool` 時照舊讀 `kind` 與 `name` 即可；要知道模型被叫去用哪個工具的，缺席當成 `task`。
4. 確認：新版起來之後開一條升級前的舊對話、送一句話，內容都在，那條對話的目錄裡是 `session.v56.jsonl`。在背景續行模式下點名一個子代理送一句話，
   日誌裡那句的 `mention` 帶 `"tool":"subagent"`。

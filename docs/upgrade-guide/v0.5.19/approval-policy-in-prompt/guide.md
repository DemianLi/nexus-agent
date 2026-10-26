---
kind: upgrade-guide
description: 每次模型呼叫的系統提示詞尾端多一句這個 session 的核准政策，出廠就有、關不掉；切換政策會讓那一次請求的系統提示詞尾端改變。
---

# 系統提示詞多一句核准政策

## 變更

v0.5.19 的系統提示詞不講核准政策：模型不知道這個 session 要核准的動作會去問人、還是一律被回絕。

新版（#1986）每次模型呼叫都在系統提示詞尾端接一句。講哪一句，看的是這一刻的核准政策，以及這個入口有沒有人能按核准：

| 組裝 | 模型看到的那一句 |
| --- | --- |
| serve，權限組合是出廠的 `read-only` 或 `workspace-write`（核准政策 `ask`） | 這個 session 開著核准提示：需要核准的操作可以經由設定好的核准管道發問；沒有可用的管道時，請求以拒絕收場。 |
| serve，切到部署者自己加、核准政策為 `never` 的組合（例如加回的 `danger-full-access`） | 這個 session 關掉了核准提示：需要核准的動作一律自動回絕——不要請求沙箱升級（不要設 `sandbox_permissions`）。 |
| CLI（這個入口沒有人能按核准） | 同上，「關掉了核准提示」那一句，不論權限組合 |
| 背景子代理 | 同上，「關掉了核准提示」那一句 |
| 前景子代理 | 跟 root 當下的那一句相同 |

這一句是組裝本身加的，不是出貨清單上的一列，沒有設定可以關掉它，`plugin disable` 也關不掉。它排在檔案政策那一句之後、
`system-prompt` 那一列附加的 `personaSuffix` 之前。

用 `/permission` 切換到核准政策不同的組合之後，下一次模型呼叫就換成另一句。

受影響的：所有主機上模型看到的內容。下面兩種部署要特別看一下：

- **自己在提示詞裡寫了核准相關說法的部署**：在 `system-prompt` 那一列的 `personaPrefix` 或 `personaSuffix` 寫過「要改檔先問我」「不會有人核准」這類句子的，
  可能跟這一句重複，或在政策切換之後互相矛盾。
- **在意供應商前綴快取的部署**：這一句在系統提示詞尾端，排在對話歷史之前。切換核准政策的那一次請求，系統提示詞尾端會改變，
  從那裡起的前綴（含之後整段歷史）不再命中快取，那一次的輸入 token 照全價算。不切換就不受影響。

## 遷移

1. 不需要改任何設定。
2. 用了 `personaPrefix`／`personaSuffix` 的部署：用 `--dump-config` 看 `system-prompt` 那一列的 `config`，裡面有講到核准的句子就刪掉或改寫，
   讓上表那一句成為唯一的說法。`config` 是整份替換，三格要一起寫出來（見 [`default-plugin-additions`](../default-plugin-additions/guide.md) 第 3 步）。
3. 確認：開一條新會話跑一輪，在會話日誌裡找 `request/system` 那一筆，它記的是那一次實際送出的系統提示詞全文。
   會話日誌預設在 home 的 `sessions/` 底下（[`docs/operations.md`〈會話日誌〉](../../../operations.md#會話日誌)；banner 的「會話日誌：」那一行印的是實際目錄）：

   ```bash
   grep -h '"request/system"' ~/.nexus-agent/sessions/<那一次的目錄>/*.jsonl | grep -oE '這個 session (開著|關掉了)核准提示'
   ```

   設過 `NEXUS_AGENT_HOME` 或 `--session-log` 的換成那個目錄。印出來的要對上上表：「開著核准提示」是會問的那一句，
   「關掉了核准提示」是一律回絕的那一句；CLI 印的是後者。
   `request/system` 只在系統提示詞跟上一份不同時才記，所以在 serve 上用 `/permission` 切到核准政策不同的組合、再跑一輪，同一份日誌會多一筆，印出另一句。
   關掉了 `session-persistence` 那一列的部署沒有會話日誌，看不到這一筆。

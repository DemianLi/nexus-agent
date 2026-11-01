---
kind: upgrade-guide
description: /readyz 多一種 503：serve 寫資料的地方滿了回 503 storage-full，只把 503 當成收尾的監控要跟著改。
---

# /readyz 多一種 503

## 變更

v0.5.19 的 `/readyz` 只有兩種回應：`200 ok`，與收尾開始之後的 `503 closing`。磁碟滿時它照樣回 200。

新版（[#2195](https://github.com/DemianLi/nexus-agent/issues/2195)）多一種 `503 storage-full`：home、`--session-log` 指到的目錄、工具結果暫存根、thread-roots 基底、`--workspace` 這些 serve 寫資料的地方，任一處的區塊或 inode 用完就回。`closing` 優先。空間釋放之後回到 200，不用重啟。

受影響的：看 `/readyz` 的監控與部署腳本。把「503」等同於「serve 正在結束」的，磁碟滿時會判錯。只看狀態碼是不是 200 的，不用改設定，磁碟滿時會多收到一次告警。

配額滿（`EDQUOT`）`statfs` 看不到，`/readyz` 照樣回 200。

## 遷移

1. 找出讀 `/readyz` 回應的監控與腳本，看它有沒有把 503 當成收尾。
2. 要分辨兩種 503 的，改讀本文：`closing` 或 `storage-full`。
3. 要知道哪一區滿，打開指標，看 `nexus_storage_full{area="home"}` 與 `nexus_storage_full{area="thread-roots"}`。
4. 確認：`curl -i http://127.0.0.1:<port>/readyz` 平常回 `200 ok`；在測試機寫滿 home 所在的檔案系統，約 5 秒內回 `503 storage-full`，釋放後回 `200 ok`。

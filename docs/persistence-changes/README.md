---
description: "審查與維護會話持久化型別變更的確認紀錄、對應的型別圖快照與相容性決定。"
---

# 持久化型別變更紀錄

## 概述

這裡放已確認的會話持久化型別變更，以及每一筆的前驅。每筆紀錄把一個相容性決定綁在確切的生成型別圖上。檢查只用目前 checkout 裡的檔案，把目前的原始碼跟紀錄歷史比。

照 dsh `docs/persistence-changes/README.zh.md`（`687f282e`）寫成；跟 dsh 不同的地方列在 [`persistence-changes.ts`](../../apps/harness/src/persistence-changes.ts) 檔頭。

## 目錄

- [檔案與職責](#files-and-ownership)
- [相容規則](#compatibility-rules)
- [歷史與限制](#history-and-limitations)
- [開發備註](#dev-note)

-----

<a id="files-and-ownership"></a>
## 檔案與職責

[型別圖](../persistence-schema.json)是正規化後的型別，由 [`persistence-schema.ts`](../../apps/harness/src/persistence-schema.ts) 從原始碼抽出。根涵蓋邏輯會話 header（`SessionHeader`）、事件封裝（`SessionEventEnvelope`）與 repo 裡宣告的每一種事件。被引用的型別一變，每個受影響的根的摘要都跟著變。

每一筆帶日期的紀錄是同目錄的兩個檔：

| 檔案 | 職責 |
|---|---|
| `YYYY-MM-DD-slug.md` | 確認文件：`kind: persistence-change`、一份機器聲明、相容性說明與驗證證據 |
| `YYYY-MM-DD-slug.schema.json` | 生成的變更後型別圖，涵蓋受影響而且還存在的根 |

機器聲明列出每個受影響的根、它的前驅紀錄、變更後的摘要與相容性決定。新根沒有前驅；刪除沒有變更後的型別圖，留一個明確的刪除標記。

紀錄用命令產生，不手寫機器聲明：

```bash
pnpm --filter @nexus/harness run persistence-changes --record 2026-10-23-slug --prose prose.json
```

`--prose` 是一份 JSON，恰好 `summary`、`compatibility`、`verification` 三個字串，分別寫進「摘要」「相容性」「驗證」三段；不給就留 `TODO:` 佔位，驗證器會拒，之後用 `--update ID --prose FILE` 補。`--check` 只驗目前目錄；`--json` 輸出機器可讀的結果。命令會一起重新生成 `docs/persistence-schema.json`。

<a id="compatibility-rules"></a>
## 相容規則

偵測到的每一個結構變更都要確認。舊讀方保留已接受資料的必要意義、安全略過選填功能、保留看不懂的紀錄，或在執行、修改與截斷恢復之前拒絕不支援的必要資料時，可以不升會話版號。新讀方必須保留歷史的意義與可讀性。只有有效的判別資訊擋不住不安全的解讀時，才升版號。未知的欄位或值，只有在既有讀方真的能安全處理時才算有效；型別差異本身證明不了這件事。

| 偵測到的變更 | 紀錄要求 |
|---|---|
| 新增選填的事件酬載屬性，連同它整棵子樹 | `same-version` |
| 把必填的事件酬載屬性改成選填 | `same-version` |
| 新增一般事件類型 | `same-version` |
| 一般事件加一個更高的數字 `data.version`，並照既有規則保留所有舊的酬載分支 | `same-version` |
| 選填改必填、新增必填屬性、改既有型別，或刪除／改名屬性或事件 | `same-version` 要相容性審查，或明確 `version-bump` |
| 改會話 header 或事件封裝 | `same-version` 要相容性審查；header 版號變了要 `version-bump` |

分類器認得明確允許的同版情形，以及要相容性審查的變更，判斷不了語意上安不安全。後者在不升版的 `--record` 或 `--update` 裡要明確給 `--decision same-version`。紀錄的「相容性」寫兩個方向上讀方的實際行為，「驗證」寫跑過的檢查。審查涵蓋整個轉換，包括同時發生的其他變更。明確的 `version-bump` 要求同一筆紀錄自己帶著 `SessionHeader.version` 的遞增；同版決定免不掉 header 版號的變化。

命令列在產生要審查的同版紀錄之前要求明確選擇。CI 只讀紀錄上寫的 `decision: same-version`；只要歷史、型別圖與 header 版號的約束成立，不論紀錄是工具產生還是手改的都收。驗證分不出紀錄是怎麼寫的，也證明不了真的有人審過。`--check` 驗的是目前目錄一致，看不出已被紀錄涵蓋的轉換。

一般事件可以加一個帶必填、非負整數 `data.version` 的酬載分支：新版本要比所有既有的酬載版本高，所有既有分支照上面明確允許的同版規則保持可讀。選填屬性的新增與必填改選填可以跟新版本一起引入；每個保留的分支各自比較。其他酬載變更要相容性審查。舊讀方可能拒收新的酬載版本。

每一則同版說明都要講舊紀錄怎麼保持可讀、舊讀方怎麼處理新紀錄，包括不必明確給 `--decision` 的允許情形。日誌沒用到某個功能時要保留舊行為；可捨棄的功能要能安全略過；必要的功能要有有效的拒絕訊號。拒絕不支援的功能不能變成損壞恢復或尾端截斷。必填改選填時，說明讀方怎麼處理缺值。審查的人判斷行為與證據；檢查器驗聲明與型別分類。升版的紀錄同時照 [`session-store.ts`](../../packages/nexus-core/src/session-store.ts) 檔頭的升版紀錄走。

讀方按屬性名拒收某個 JSON 欄位時，把那個屬性宣告成選填的 `never`，加上不帶參數的 `@persistenceReserved` 標記。抽取器會保留這個禁止的欄位，所以之後允許 JSON 值就算改既有欄位的型別。必填屬性或允許 JSON 值的屬性不能帶這個標記。沒標記的選填 `never` 與 `undefined` 屬性照舊省略。

<a id="history-and-limitations"></a>
## 歷史與限制

一筆基線記下完整的初始清單。之後每一筆拿前驅的變更後型別圖當變更前型別圖。驗證器拒收缺前驅、成環、同一個根的重複後繼、摘要對不上，以及目前的根跟最新紀錄不一致。互不相干的根可以各自演進。同一個前驅上的兩個變更，整合後要排成一條有序的歷史。

已接受的紀錄描述歷史上的轉換；加後繼時要保留它的機器聲明與型別圖快照。還沒有後繼的末端紀錄可以明確刷新（`--update`）；命令在產生檔案之前就拒絕基線與已有後繼的紀錄。基線不依賴 Git 參照、遠端服務或已發行版本的 checkout。

摘要描述宣告的持久化型別，不描述執行期的驗證或行為。一般註解、原始碼位置、別名與不改語意的宣告重排都不影響摘要。物件欄位、聯集分支、交集運算元與索引簽名，在解析出的型別不變時可以重排；tuple 位置與數字列舉值照樣影響摘要。原始碼位置還是可能變，所以生成物過期就重新生成，摘要沒變就不必加確認紀錄。`unknown` 這類不透明型別沒有可比較的內部結構。純行為變更與藏在不透明值裡的結構不在這套機制的範圍內。

<a id="dev-note"></a>
## 開發備註

<details>
<summary>維護者的工作脈絡——點開</summary>

無。

</details>

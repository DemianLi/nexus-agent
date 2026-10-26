---
description: "記錄一次持久化型別轉換與它的相容性確認。"
kind: persistence-change
---

# 2026-10-26-image-original-dimensions

## 摘要

圖片參照多一格選填的 `originalDimensions`（#2033，照 dsh 22ddee37 `packages/attachment/attachment/src/types.ts:24-31`）：`{ width, height }`，收下的原圖套過 EXIF 轉向之後的寬高，只在規範化把圖縮小時才有。型別圖上帶圖片參照的根是 `turn/start` 與 `inbox/spliced` 兩種事件的 `attachments`，這兩個根一起變。唯一的生產者是 `AttachmentStore.saveImages`（`apps/harness/src/attachment-store.ts`）。同一張卡讓新收的圖落盤前先規範化，參照的寬高、媒體類型、位元組數與附件 id 都描述規範化之後那一份；那是值的變化，不是型別的變化。會話格式版本不變。

## 目錄

- [聲明](#declaration)
- [相容性](#compatibility)
- [驗證](#verification)
- [開發備註](#dev-note)

<a id="declaration"></a>
## 聲明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-26-image-original-dimensions
baseline: false
changes:
  - root: "event:inbox/spliced"
    previous: "2026-10-23-initial"
    after: "33cc07d869df168195d8fb844005a257a6a134753457a4699b0ea8c91845c7e6"
    decision: same-version
  - root: "event:turn/start"
    previous: "2026-10-23-initial"
    after: "b09ee7a0447c21a9cb884f9b78af45f1fa6f11018e3e7944ca06c2f0d991b8a9"
    decision: same-version
```

<a id="compatibility"></a>
## 相容性

同版。舊紀錄：沒有這一格的圖片參照照舊，既有的六格一個字沒動；新讀方讀到沒有 `originalDimensions` 就是沒縮過（規範化以前落盤的圖本來就沒縮），讀圖時的檔頭比對照舊用檔頭的軸，舊參照照樣讀得到（`attachment-store.test.ts`、`attachment-image-checks-wire.test.ts` 釘住帶 EXIF 6 的舊原圖）。舊讀方（develop 44a627ca）讀新紀錄：`isImageRef`（`packages/nexus-core/src/attachment-ref.ts`）只驗它認得的六格、不拒多出來的鍵，所以帶這一格的參照照樣算合格的圖、照樣投影給模型；wire 的 `attachmentsField`（`packages/nexus-wire/src/conversation.ts`）是白名單，不把這一格轉給網頁；讀盤只驗信封與兩條資料規則，不驗附件區塊。多一格沒人讀的欄位，不拒收、不判損壞。不需要拒絕訊號，不升版。

<a id="verification"></a>
## 驗證

`apps/harness/src/attachment-store.test.ts`：縮過的圖參照帶 `originalDimensions: { width: 3000, height: 2000 }`、寬高是 2508×1672；`apps/harness/src/attachment-wire.test.ts`：走產品組裝（wire `run.start` → 存圖 → `turn/start` 日誌 → 模型請求），3000×3000 的圖參照帶 `originalDimensions`、沒縮的 EXIF 轉向圖沒有這一格；`packages/nexus-core` 的 `isImageRef` 收這一格、形狀不對（缺寬或高、不是非負整數）就不收。`pnpm --filter @nexus/harness run persistence-changes --check` 綠。

<a id="dev-note"></a>
## 開發備註

無。

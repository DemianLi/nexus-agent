---
kind: upgrade-guide
description: 交付檔的三條 GET 網址拿掉了，改走命令通道 deliverable.read 與 deliverable.readBytes；直接打舊網址的腳本會拿到 404。
---

# 交付檔的三條專用網址拿掉了

## 變更

v0.5.19 的 `serve` 有三條讀交付檔的 GET 網址：`/threads/:id/deliverables/file`（一頁文字）、`/deliverables/download`（下載原始位元組）、
`/deliverables/bytes`（位元組窗口，base64）。新版（PR #816）把它們拿掉，一律回 404；網頁早已改走命令通道，不受影響。

替代的是命令通道上的兩個方法，`POST /threads/:id/commands/<方法>`，body 是 `{ "id": …, "method": …, "params": … }`：

- `deliverable.read`：讀一頁文字，取代 `deliverables/file`。
- `deliverable.readBytes`：讀位元組，給 `offset`／`length` 是窗口，都不給是整檔，取代 `deliverables/bytes` 與 `deliverables/download`。

參數不合格不再回 4xx 狀態碼，而是 HTTP 200 加 `{ "type": "error", "error": "invalid_argument", … }`；業務上的拒絕帶理由碼。
參數與結果的型別見 `packages/nexus-wire/src/deliverables.ts`，用法可照 `packages/nexus-wire/src/deliverable-client.ts`。

受影響的：自己寫腳本或工具、直接打這三條網址的部署。只用網頁的不受影響。

## 遷移

1. 在自己的腳本裡找 `/deliverables/file`、`/deliverables/download`、`/deliverables/bytes`，改成上面兩個命令。
2. 錯誤處理從看 HTTP 狀態碼改成看 body 的 `type` 與碼。
3. 確認：腳本對新版跑一次，拿到的內容與 v0.5.19 相同。

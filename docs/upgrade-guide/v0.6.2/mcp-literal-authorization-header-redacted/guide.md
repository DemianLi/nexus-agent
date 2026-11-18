---
kind: upgrade-guide
description: HTTP MCP 設定裡直接寫成字串的 Authorization、Proxy-Authorization 現在會當憑證遮掉；整個值修掉頭尾空白之後不到 8 個字元的，這一列起不來。
---

# 直接寫成字串的 Authorization 現在會遮，太短的整列拒絕

## 變更

v0.6.2 的 HTTP MCP 設定（`connection.headers`）裡，直接寫成字串的 header 都是字面值：回應與錯誤裡出現它的值不會被遮，整個值多短都收。

新版（[#2570](https://github.com/DemianLi/nexus-agent/issues/2570) D359）：

- 直接寫成字串的 `Authorization`、`Proxy-Authorization`（名字不分大小寫）**自動當憑證**：整個值，與 scheme 後面那一段（`Bearer abc…` 的 `abc…`），在送回模型的工具結果、錯誤與診斷裡換成 `[redacted]`（scheme 後面那一段不到 8 個字元時，只在錯誤與診斷遮，成功結果不遮）。其他字串 header（例如 `X-Tenant`）仍是字面值，不遮。
- 這兩個 header 的整個值，修掉頭尾空白之後**不到 8 個字元的，這一列起不來**（`MCP 伺服器 "<名字>" 的 connection.headers.Authorization …`，訊息不含值）。`Bearer x` 正好 8 個，收下。
- 字串 header 的值頭尾的空白與換行（YAML 的 `|` 區塊值常帶出尾端換行），經宿主連線時會修掉再送；TS 外掛自己連線時送出的值不改，由 `fetch` 去掉頭尾的 HTTP 空白。
- 設定寫法不變：字串照收，不要求改成憑證引用（`{ credential: "<名字>", prefix: "Bearer " }`）；秘密仍然以明文留在設定檔裡，建議改用憑證引用。

受影響的：在 `connection.headers` 直接寫 `Authorization` 或 `Proxy-Authorization` 字串、而且整個值很短的設定；以及依賴這兩個 header 的值在回應裡原樣出現的測試。

## 遷移

1. 沒有直接寫 `Authorization`／`Proxy-Authorization` 字串的設定：不用改。
2. 寫了、整個值夠長的：不用改。回應裡出現它會變成 `[redacted]`。
3. 起不來、訊息指向 `connection.headers.<名字>` 的：整個值不到 8 個字元。換成較長的值，或改用憑證引用，把值放進受管憑證檔（見 [`docs/credentials-file.md`](../../../credentials-file.md)）。
4. 確認：重啟後這一列連得上；工具結果或錯誤裡看不到 `Authorization` 的值。

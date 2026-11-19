---
kind: upgrade-guide
description: "`per-thread` 下宿主連 HTTPS 的 MCP server 只信 `NODE_EXTRA_CA_CERTS` 指的那個檔；已經設了企業 CA 的部署，要把公開根併進去，才連得上公開 server。"
---

# 宿主連 MCP 只信 NODE_EXTRA_CA_CERTS 的根

## 變更

只影響 `process-model` 設成 `per-thread` 的部署。`single`（預設）與 CLI 不受影響。

- **舊行為。** MCP 的 HTTPS 連線由 TS 外掛自己連，信 Node 內建的根；`NODE_EXTRA_CA_CERTS` 是在內建根之外**加上**企業 CA。
- **新行為。** 宿主連 MCP（HTTPS）時，**只信** `NODE_EXTRA_CA_CERTS` 指的那個檔，不讀系統根，也不併 Node 內建的根。這個檔就是 `host-plugins.json` 裡 `mcp` 那一列的 `roots`。沒設 `NODE_EXTRA_CA_CERTS` 就沒有那一列，宿主連不了 HTTPS 的 MCP server。
- 這個規則隨宿主接管 per-thread 對話行程的 MCP 連線（#3000 的 E4b）生效；到那之前對話行程仍走 TS，行為不變。

受影響的：`per-thread`、而且已經把 `NODE_EXTRA_CA_CERTS` 指到「只有企業 CA」的檔，同時又連公開 HTTPS MCP server 的部署：切換之後那些 server 會因為憑證驗不過而連不上。

## 遷移

1. 看啟動 serve 的環境有沒有 `NODE_EXTRA_CA_CERTS`：`env | grep NODE_EXTRA_CA_CERTS`。
2. 有設的：把要連的公開 server 的根（例如系統的 CA 套件 `/etc/ssl/certs/ca-certificates.crt`）接在企業 CA 後面，併成同一個 pem 檔，再把 `NODE_EXTRA_CA_CERTS` 指向它。Node 本身也讀這個檔，併進去的根只會多信，不會少信。
3. 沒設、要連 HTTPS 的 MCP server 的：設 `NODE_EXTRA_CA_CERTS` 指向包含那些 server 根的 pem 檔。
4. 重啟 serve，確認：`<home>/host-plugins.json` 有 `mcp` 那一列，`roots` 指向併好的檔；從 `per-thread` 的對話叫一次 HTTPS MCP 工具，成功。

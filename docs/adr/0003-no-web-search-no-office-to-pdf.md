# 不掛 web 搜尋與抓取，也不做 Office 轉 PDF

2026-09-19 的決定（類別：項目），取代 [`decisions-2026-09-19.md`](https://github.com/DemianLi/nexus-agent/blob/archive/docs-2026-11/.docs/decisions-2026-09-19.md) 的第 1、11 題。部署完全在內網、連不到外網，所以出廠不掛 `web_search`、`web_fetch`，這是 dsh 為「網路政策更嚴的產品」預留的覆寫路，不必另外登記偏離。Office 轉 PDF（dsh 的 `office-to-pdf`）是 dsh web 文件預覽面板看 Office 檔的後端。我們的 web 有右側欄的交付檔預覽（`web/src/features/deliverable/preview.tsx:6`），但只畫文字與 Markdown，不是文字的檔回 `deliverable/not-text`、改走下載（`harness/apps/harness/src/wire-handler.ts:1173`、`preview.tsx:56`），沒有要在頁面上看 Office 檔的需求；也不想為它帶進 LibreOffice 這個很重的相依，所以不做，登記「需求未出現」。

## Considered Options

- **自己寫內網用的 fetch 與搜尋 provider**：多人共用主機上，fetch 碰得到 loopback，有 SSRF 風險。
- **用 MCP server 接內網搜尋**：今天就做得到，要用時由部署方自己設定，不必改核心。
- **Office 轉 PDF 照 dsh 整套做**：沒有任何使用者，只多一個很重的相依。

## Consequences

- 內網真有搜尋需求時走 MCP，不改核心。
- 重開條件：web 的預覽要能看 Office 檔時，再為 Office 轉 PDF 開卡。
- 這份只取代原文的第 1、11 題；其餘十題今天都已有對應的實作與現行文件（例如出貨清單 `harness/apps/harness/cordis.yml` 的 `skills`、`present`、`session-checkpoint-policy`、`session-reference` 列與 `cordis.serve.yml` 的 workspace-changes、`docs/tool-catalog.md`、`docs/operations.md`〈會話日誌〉、`docs/web-ui.md` 的 `@` 選單），原文在 tag `archive/docs-2026-11`。

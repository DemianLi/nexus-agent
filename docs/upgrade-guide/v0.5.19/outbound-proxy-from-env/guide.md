---
kind: upgrade-guide
description: 啟動環境裡的 HTTP_PROXY／HTTPS_PROXY 開始生效，模型請求改走代理；內網端點要用 NO_PROXY 寫主機名放行。
---

# 對外連線開始照環境變數走代理

## 變更

v0.5.19 不理會 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`，模型請求與網路 MCP 一律直連。新版（PR #800）照 dsh 在啟動時讀一次這些變數，
裝成全行程的代理：

- 啟動環境裡本來就有代理變數的主機（例如為了 `apt`、`curl` 在系統層設的），**模型請求會改走代理**。代理到不了內網端點時，`--live` 的請求會失敗。
- `NO_PROXY` 只認主機名與網域尾巴（可帶 `:port`、`*` 全放行），**不支援 CIDR**，寫 `10.0.0.0/8` 不會生效。
- 不支援 SOCKS：`socks5://…` 會在啟動時以 `代理：` 開頭報出來，並讓那個協定直連。
- **目前資料夾的 `.env` 不能設代理變數**，設了就拒絕啟動並指名檔案與變數。
- git 快照與以 stdio 起的 MCP server 繼承同一組變數。

受影響的：啟動 `serve` 或 CLI 的環境裡有代理變數的主機，以及在目前資料夾的 `.env` 寫了代理變數的主機。

## 遷移

1. 在啟動 `serve` 的那個環境（systemd unit 的 `Environment=`／`EnvironmentFile=`，或 shell）跑 `env | grep -i proxy`，看有沒有代理變數。
2. 模型端點要直連的，把它的主機名加進 `NO_PROXY`（例如 `NO_PROXY=llm.intranet.example`），不要寫 IP 段。
   全部都不要走代理的，從這個行程的環境拿掉代理變數。
3. 代理變數寫在目前資料夾 `.env` 裡的，搬到 shell 匯出或 home 的 `.env`。
4. 做 TLS 攔截的企業代理，啟動前設 `NODE_EXTRA_CA_CERTS=<企業 CA 的 pem>`。
5. 確認：`--live` 送一則訊息成功，代理軟體的連線紀錄有（或沒有）那筆請求，跟你要的一致。細節見 [`docs/operations.md`](../../../operations.md) 的代理那一節。

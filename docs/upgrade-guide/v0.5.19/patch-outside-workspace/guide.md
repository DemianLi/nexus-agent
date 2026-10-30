---
kind: upgrade-guide
description: serve、CLI 與 plugin 拒絕落在 --workspace 裡的 --patch 檔，放在工作區裡或經連結進出工作區時起不來。
---

# `--patch` 檔不能落在工作區裡

## 變更

CLI 與 serve 的舊 thread 改得到工作區，而覆寫檔能換掉 MCP 的 `command`，下次起動就以這個帳號跑。v0.5.19 不檢查 `--patch` 的位置。
新版在給了 `--workspace` 時，啟動前解開符號連結，比對每一份 `--patch`，落在工作區裡就起不來，訊息是
`--patch <檔> 不能在 --workspace 底下`。

受影響的：同時給了 `--workspace` 與 `--patch` 的 `serve`、CLI 與 `plugin`（含 `--dump-config`、`--dump-config-schema`），
而且覆寫檔在工作區裡，或是經連結進出工作區。沒給 `--workspace` 的不受影響。

## 遷移

1. 把覆寫檔搬到工作區外面，改 `--patch` 的路徑（systemd 單元裡的也要改）。檔案權限要維持原本的要求。
2. 或換一個不包含它的 `--workspace`。
3. 確認：serve 起得來，沒有上面那則訊息。

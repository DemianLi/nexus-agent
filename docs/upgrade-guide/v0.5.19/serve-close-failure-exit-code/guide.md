---
kind: upgrade-guide
description: serve 收到 SIGTERM 或 SIGINT 後收尾失敗時，退出碼從 0 或 130 改成 1。
---

# serve 收尾失敗時退出碼改成 1

## 變更

v0.5.19 的 `serve` 收到訊號後，收尾失敗時照訊號的碼結束：`SIGTERM` 是 0，`SIGINT` 是 130。原因只印在標準錯誤，例如磁碟滿時的 `2 條 thread 收尾失敗`，沒寫進去的會話日誌重啟後不在，退出碼看不出來。

新版（[#2196](https://github.com/DemianLi/nexus-agent/issues/2196)）在收尾失敗時一律以 1 結束。其餘不變：收尾成功時 `SIGTERM` 是 0、`SIGINT` 是 130；5 秒上限到了與收尾中第二次訊號，照舊是訊號的碼。

受影響的：看 `serve` 退出碼的監控與腳本；`Restart=on-failure` 的 systemd 單元，`systemctl stop` 碰上收尾失敗時單元進 `failed`，直接送 `SIGTERM` 碰上收尾失敗時會被重啟。

## 遷移

1. 檢查包 `serve` 的腳本與監控：`SIGTERM` 之後的退出碼 1 代表收尾失敗，要去看標準錯誤，不要當成一般停止。
2. systemd 單元若進 `failed`，看 `journalctl -u nexus-agent` 裡的收尾失敗訊息，排除原因後 `systemctl reset-failed nexus-agent` 再啟動。
3. 確認：正常停一次 `serve`，退出碼是 0；`systemctl status nexus-agent` 不是 `failed`。

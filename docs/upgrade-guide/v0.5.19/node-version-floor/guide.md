---
kind: upgrade-guide
description: 支援的 Node 從 22 以上收緊成 22.19 以上的 22.x 或 24 以上，23 不支援；升級前先換 Node。
---

# Node 版本下限收緊

## 變更

v0.5.19 的 `package.json` 寫 `engines.node: ">=22"`。新版收緊成 `^22.19.0 || >=24.0.0`：

- 22.x 要 22.19 以上（PR #800：對外代理用的 undici 8 需要）。
- **23.x 不支援**（PR #1679：23 已 EOL）。
- 24 以上可以，CI 的主版本是 24。

`serve` 與 CLI 啟動時不檢查 Node 版本，在不支援的版本上可能起得來、跑到某條路徑才出錯。

受影響的：主機的 Node 是 22.0–22.18 或 23.x 的部署。

## 遷移

1. 升級前在主機上跑 `node --version`。不在支援範圍內的，先把 Node 換成 22.19 以上的 22.x 或 24 以上的版本。
   systemd unit 用絕對路徑指 `node` 的，確認指到的是新的那一份。
2. 確認：`node --version` 在範圍內，`serve` 起得來。

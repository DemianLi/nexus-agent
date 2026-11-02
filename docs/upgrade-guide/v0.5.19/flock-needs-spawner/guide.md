---
kind: upgrade-guide
description: home 鎖與會話寫租約改由 spawner 拿鎖，macOS 上的 serve 不再互斥，Linux 上少了 spawner 就沒有鎖。
---

# home 鎖與會話寫租約改由 spawner 拿鎖

## 變更

v0.5.19 的 `serve` 與 CLI 用原生模組 `@deepseek-ai/node-addon-system` 拿 `flock(2)`，macOS 與 Linux 都有 `serve.lock` 與會話寫租約。

新版（[#2253](https://github.com/DemianLi/nexus-agent/issues/2253)）的出貨相依裡沒有這個套件，改由 Node 把開好的鎖檔交給 `native/nexus-sandbox-spawner --flock`。Linux 上鎖的語意不變：仍是 `flock(2)`，行程死了 kernel 放鎖，沒有逾期。

- **macOS：** 沒有 spawner，鎖不到。同一個 home 可以起第二個 `serve`，同一份會話也可能有兩個寫入者；`serve` 的日誌講一行 `[home 鎖] 這個平台拿不到 home 鎖`。
- **Linux：** 出貨包裡的 spawner 被刪掉或路徑不對時同樣鎖不到，日誌有同一行。spawner 在但起不來（例如沒有執行權限、行程數到頂）則 `serve` 不啟動，原樣報錯。

受影響的：在 macOS 上跑 `serve` 的人；自己挑檔案部署、沒帶 `native/` 的管理者。

## 遷移

1. macOS：不要對同一個 home 起兩個 `serve`，也不要用兩個行程寫同一份會話。
2. Linux：部署時保留解壓出來的 `native/nexus-sandbox-spawner`，權限維持可執行。
3. 確認：Linux 上起一個 `serve`，再對同一個 home 起第二個，第二個要以 home 使用中被拒；第一個的日誌沒有 `拿不到 home 鎖`。

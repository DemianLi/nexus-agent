---
kind: upgrade-guide
description: quickjs 的 maxStackSizeBytes 預設從 512 KiB 降到 128 KiB，遞迴超過約 600 層的程式改回 stack overflow；設得大的照舊可以設。
---

# `run_javascript` 的預設堆疊上限變小

## 變更

v0.5.19 的 `@nexus/plugin-quickjs` 沒寫 `maxStackSizeBytes` 時是 512 KiB。QuickJS 在 WASM 裡遞迴吃的是 serve 行程的原生堆疊，
這個上限還沒到，serve 的堆疊就先用完了：無窮遞迴、遞迴的 getter 都會讓整個 WASM 模組 abort，原本的錯被
`Aborted(Assertion failed: …)` 蓋掉，而且同一個 serve 行程共用的 WASM 記憶體回不去
（[#1841](https://github.com/DemianLi/nexus-agent/issues/1841)）。

新版：

- **預設改成 128 KiB**（demian 2026-10-29 拍板，[#1827](https://github.com/DemianLi/nexus-agent/issues/1827) D46）。無窮遞迴拿到 VM 自己的
  `InternalError: stack overflow`，工具回 `exception`。代價是遞迴的深度變淺：v0.5.19 一個參數的遞迴跑得到約 2200 層，新版約 600 層，
  中間那一段以前跑得完的程式，現在回 `stack overflow`。
- host 的堆疊還是先用完時（例如自己把 `maxStackSizeBytes` 設大），工具回 `exception`、訊息是
  `RangeError: Maximum call stack size exceeded`，插件把那個 WASM 模組丟掉換新的，下一次呼叫照常。每次掛載自己持有一個模組，
  不再共用 `quickjs-emscripten` 的行程級單例。

受影響的：在 patch 檔用 `insert` 掛了 `@nexus/plugin-quickjs`、沒寫 `maxStackSizeBytes` 的主機。它不在出廠清單裡，沒掛的主機不受影響。

## 遷移

1. 要新的預設：不用動。
2. 模型寫的程式需要更深的遞迴：在那一列的 `config` 寫回 `maxStackSizeBytes`（`config` 是整份替換，其餘的欄位要一起寫）：

   ```yaml
   - insert:
       - id: quickjs
         name: '@nexus/plugin-quickjs'
         config:
           maxStackSizeBytes: 524288
   ```

   設得越大，越常是 host 的堆疊先用完；那時回的是 `RangeError: Maximum call stack size exceeded`，不再讓模組 abort。
3. 確認：叫模型用 `run_javascript` 跑 `(function f() { return f(); })()`，預設值下工具回的錯含 `stack overflow`。

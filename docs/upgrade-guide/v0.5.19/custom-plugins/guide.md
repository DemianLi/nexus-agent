---
kind: upgrade-guide
description: 自己寫的 NexusPlugin 物件照樣載得進來，但那是相容層；新寫的插件改用 @nexus/sdk 的函式插件形狀，@nexus/core 拿掉了幾個內部匯出。
---

# 自己寫的插件：舊形狀走相容層，新的用 `@nexus/sdk`

## 變更

v0.5.19 的文件教的自寫插件是 `@nexus/core` 的 `NexusPlugin` 物件：模組 `export default` 那顆物件，在 patch 檔用 `insert` 指到檔案路徑
（v0.5.19 `docs/operations.md`「插一顆自己寫的」那段）。新版的核心改成 Cordis 插件樹，插件的正式形狀換成**函式插件**：具名匯出
`name`、`inject`、`Config`、`apply`、`manifest`，**不能有 `default`**，用 `@nexus/sdk` 宣告依賴與契約版本（[`docs/plugin-contract.md`](../../../plugin-contract.md)）。

舊形狀沒有斷：

- `export default` 的 `NexusPlugin` 物件仍由相容層載入，`insert` 指檔案路徑的寫法照舊。home 的 `cordis.patch.yml` 被遷進變更紀錄之後，
  相對路徑一樣解得到。`PluginRegistry` 只多了 `projections`、`events`、`logger` 三格，沒有拿掉的。
- `@nexus/core` 拿掉了幾個內部匯出：`GOAL_WRAPUP_MARKER`、`InvalidArgumentsCarrier`、`createInvalidArgumentsCarrier`、
  `createFsToolErrorsMiddleware`、`createReadContinuationMiddleware`、`defaultTokenAnchorBook`、`recordBackendOutcomes`、`recordReadExtent`。
  自寫插件在執行期 import 了其中任何一個的，載入時會失敗（只當型別用的不受影響）。

受影響的：用 `insert` 掛了自己寫的插件的主機。

## 遷移

1. 在自寫插件裡找上面那幾個名字，有用到的改掉。
2. 檔案權限的規則沒變：模組檔與每一層上層目錄只有你自己寫得動，否則拒絕啟動。
3. 新寫的、或要長期維護的插件，照 [`docs/plugin-contract.md`](../../../plugin-contract.md) 改成函式插件形狀，並跑 `@nexus/sdk/lint` 與一致性套件。
4. 確認：serve 起得來、沒有提到那一列的警告，插件的行為跟 v0.5.19 一樣。

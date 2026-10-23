---
kind: upgrade-guide
description: file 插件的相容檢查改成看 engines.nexus 與每個 @nexus/* peer，只 peer sdk／tools 的舊插件也會被判。
---

# `file:` 插件的相容檢查看 `engines.nexus` 與每個 `@nexus/*` peer

## 變更

v0.5.19 載入 `file:` 插件前，只讀它 `package.json` 的 `peerDependencies["@nexus/core"]`：沒有這一格就放行，寫 `workspace:*` 反而被當成
「不是合法的 semver 範圍」拒收。樹上的函式插件只 peer `@nexus/sdk`、`@nexus/tools`，所以照那個樣板寫的外部插件**完全沒被檢查**。

新版（[#1568](https://github.com/DemianLi/nexus-agent/issues/1568)，照 dsh 的 `plugin-compatibility.ts`）在 import 之前這樣判，對的是執行中的 nexus 版本
（發版時所有 `@nexus/*` 成員同一個版號）：

- 插件有 `engines.nexus` → **只看它**，`peerDependencies` 不看。
- 否則 `peerDependencies` 裡**每一個** `@nexus/*` 套件都要滿足執行中的版本。`@nexus/cordis`、`@nexus/cordis-plugin-include`、
  `@nexus/cordis-plugin-loader`、`@nexus/cordis-plugin-logger-console` 這四個上游套件有自己的版號，不檢查。
- peer 寫 `workspace:*`、`workspace:^`、`workspace:~` 視為「跟執行中的版本相同」，放行（這是從 repo 複製出去的 `package.json` 的樣子）。
- 範圍是空字串或不合法的，算不滿足；欄位形狀不對（`engines` 不是物件、某個範圍不是字串）也掉。

不相容的那一列在啟動時掉下來（其餘列照常起來），訊息列出**全部**不滿足的需求與執行中的版本。

受影響的是：自己寫外部 `file:` 插件，且 `package.json` 裡有 `@nexus/*` peer（或 `engines.nexus`）的主機。典型的是 `@nexus/sdk`、`@nexus/tools` 的範圍
寫得比執行中的版本窄（例如寫了 `^1.0.0`，而執行中的是 `0.5.x`）——以前沒人看，現在會掉列。沒有任何 `@nexus/*` peer 的插件不受影響。

## 遷移

1. 看啟動輸出有沒有「條目 "<id>"（file:…） 不相容：<套件>@<版本> 需要 …，執行中的是 <版本>」。有的話，列在句子裡的就是範圍寫不滿足的 peer。
2. 在插件的 `package.json` 改範圍，二選一：
   - 把 `@nexus/*` peer 的範圍改成涵蓋執行中的版本，例如 `">=0.5.0"`；
   - 或加 `"engines": { "nexus": ">=0.5.0" }`，它單獨決定，peer 不再被看。
   不要用 `workspace:*` 當成給外部發佈的值：那只在 repo 裡有意義，別人安裝時沒有 workspace。
3. 確認：重啟後啟動輸出沒有那一列的「不相容」，那顆插件的工具或命令照常出現。

回滾：退回 v0.5.19 時 `package.json` 不必改（`engines.nexus` 在舊版被忽略，`@nexus/*` peer 照舊只看 `@nexus/core`）。

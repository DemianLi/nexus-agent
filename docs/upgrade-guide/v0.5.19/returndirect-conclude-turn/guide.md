---
kind: upgrade-guide
description: 宣告 returnDirect 的外部工具不再自動結束這一輪，要在本體裡呼叫 concludeTurn 才收。
---

# `returnDirect` 的工具要自己標「這一輪在這裡收」

## 變更

v0.5.19 的基座（langchain）把 `returnDirect: true` 當成「這顆工具的**每一種結局**都結束這一輪」：成功、拋錯、被核准閘門拒絕、
參數驗證失敗，模型都不會再被叫一次。新版（[#1607](https://github.com/DemianLi/nexus-agent/issues/1607)，照 dsh 的 `exec.concludeTurn()`）
改成**標了才收**：宣告了 `returnDirect: true` 的工具，這一輪只在它的本體**明著標**的那個結局結束，其餘結局（拋錯、拒絕、校驗失敗、
輸出被判不合格）都照常回頭叫模型，讓模型有機會改正。

所以**宣告了 `returnDirect: true`、卻沒有呼叫 `concludeTurn` 的外部工具，這一輪不再在它之後結束**。

標記只在下面全部成立時生效：

- 在該工具本體執行當中呼叫，且帶的工具名是正在執行的那一顆；
- 該工具宣告了 `returnDirect: true`；
- 這一次的最終結果不是錯誤（本體標了，但後來被輸出校驗、檔案圍欄之類換成錯誤的，不收）；
- 同一則模型訊息叫的工具只有這一個。批裡還有別的呼叫時，標了也照常繼續（基座把每個呼叫各自路由，混批會擲
  `InvalidUpdateError`；dsh 是批內任何一個標了就收，這是登記過的偏離）。

樹內沒有其他 `returnDirect` 工具（只有 `exit_plan_mode`，它在「使用者關掉計劃審核」那個結局標記），出貨清單的行為不受影響。
受影響的是**自己寫外部插件、並登記了 `returnDirect: true` 工具**的主機。

`@nexus/tools` 的契約升到 `1.4.0`：`ToolRegistry` 多一個選填方法 `concludeTurn?(toolName: string)`。向後相容，
`^1.0.0`～`^1.3.0` 的消費者照常載入；要用的消費者宣告 `^1.4.0`。

## 遷移

1. 找出登記了 `returnDirect: true` 的外部工具：`grep -rn 'returnDirect' <你的外部插件目錄>`。沒有就不必做任何事。
2. 在工具本體裡、要收的那個結局呼叫 `concludeTurn`，帶上這顆工具自己的名字：

   ```ts
   export const inject = injectOf(need(toolsToken, '^1.4.0')); // 原本是 ^1.0.0（或你原本宣告的範圍），要用 concludeTurn 就升到 ^1.4.0

   apply(ctx) {
     ctx.tools.register(
       tool(
         async ({ answer }) => {
           if (answer === undefined) return '使用者沒有回答';
           ctx.tools.concludeTurn?.('collect_answer'); // 只在要收的結局呼叫
           return answer;
         },
         { name: 'collect_answer', description: '…', schema, returnDirect: true },
       ),
     );
   }
   ```

   `concludeTurn` 是選填方法（舊提供者沒有）；宣告 `^1.4.0` 就保證有，可以不加 `?.`。
   用 `@nexus/core` 的 `NexusPlugin`（`registry.tools.register`）寫的插件，改成 `import { concludeTurn } from '@nexus/core'`，用法相同。
3. 原本就希望「每一種結局都收」的（少見）：在所有成功的 return 之前都呼叫 `concludeTurn`；拋錯與拒絕不會收，這一點無法保留。
4. 確認：用腳本模型叫一次那顆工具，模型只被叫 1 次；讓它走不標的結局，模型被叫 2 次。

回滾：退回 v0.5.19 時不必改插件，`concludeTurn` 在舊版不存在，宣告 `^1.4.0` 的插件會因為提供者版本不足而載不起來，改回舊範圍即可。

# @nexus/plugin-validation

**工具成功的輸出合不合它宣告的 schema。**

> **圍堵搬走了。** 「工具拋錯不要殺掉整場 run」以前是這個 plugin 的另一半，現在住在
> `@nexus/core`（`packages/nexus-core/src/containment.ts`），由 `foldRegistry` 打底進
> root 與每個 subagent。理由與過程見
> [#159](https://github.com/DemianLi/nexus-agent/issues/159)：dsh 那側它是註冊表執行管線
> 自己的 `catch`、是性質不是功能，而它住在這裡的那段期間，這個 plugin **不在任何一份
> 正式清單裡**——等於產品路徑上根本沒有圍堵。`createContainmentMiddleware` 與
> `CONTAINMENT_MIDDLEWARE_NAME` 仍然從這裡 re-export 得出來（相容），但**這個 plugin
> 不再掛它**，也不需要掛它才有圍堵。

## 用法

```ts
import { createValidationPlugin } from '@nexus/plugin-validation';
import { z } from 'zod';

export default [
  createValidationPlugin({
    schemas: {
      fetch_report: z.object({ total: z.number(), rows: z.array(z.string()) }),
    },
  }),
];
```

`schemas` 可以整個省略——但省略之後這個 plugin **一個 middleware 都不掛**，只認領
`validation` 這個能力名。省略它不會讓工具失去圍堵：那件事不歸這裡了。

## 一個 middleware，最內層

| middleware | 位置 | 管什麼 |
| --- | --- | --- |
| `nexusToolOutputSchema` | 最內 | 成功的輸出合不合宣告的 schema |

**外圍內驗那個排法沒有消失，而且被放大了。** 校驗器自己的 bug 一樣會讓整場 run 死掉
（`wrapToolCall` body 裡的例外走的是同一條路），而圍堵現在是整份 middleware 陣列的
**第 0 格**，接得住它——不論這個 plugin 有沒有被掛上。基座自己那幾個 middleware 永遠
排在所有這些之前，接不到，那是 `createDeepAgent` 的組裝順序，不是我們能決定的事。

## 這裡擋得住什麼、擋不住什麼

**擋得住**：成功輸出不合宣告的 schema（含「根本不是合法 JSON」）、校驗器自己壞掉
（fail-closed，變成一則錯誤而不是靜默放行）。

**擋不住**：沒有列進 `schemas` 的工具的輸出——**明文放行**，別把掛了這個 plugin 當成
「所有工具都驗過了」。

工具實作與 middleware 拋的例外歸圍堵（見上面那則說明）。

## 兩條對 dsh 的偏離

dsh 的標準是 `ToolOutputDefinition.schema`——*"Raw supported JSON Schema enforced
against every successful canonical value"*，且 `output` 是**強制**宣告、註冊表在註冊時驗。

1. **強制不了。** LangChain 的 `StructuredTool` 沒有輸出 schema 這個欄位（`ToolParams`
   只有 `responseFormat`），`registry.tools.register` 收的就是 `StructuredTool`。
   → 退到這一層逐工具選加。
2. **拿不到那個 canonical value。** dsh 在渲染成 content **之前**驗值；基座的 `ToolNode`
   先 `JSON.stringify` 再交出來（`ToolNode.js:244-248`），值救不回來。
   → 退到對 content 字串 `JSON.parse` 再驗。宣告了 schema 卻不是合法 JSON，本身即失敗。

## 送進模型的話

回饋訊息**不帶堆疊、不帶原始參數**。基座自己那條路兩樣都帶——`ToolInvocationError`
的訊息把 `JSON.stringify(toolCall.args)` 與整段 `error.stack` 都塞進去。參數本來就在
同一輪的 AI 訊息裡，複誦一次只是多一份、不是多一個資訊。

校驗失敗時**原輸出不會跟著送出去**，照 dsh 的 `PostToolDecision`：
`block { feedback }`——「阻止会移除值，并转为包含纠正反馈的 `isError`」。

## 這一版只收 schema

不變量與業務規則歸 [#16](https://github.com/DemianLi/nexus-agent/issues/16)。schema 是
工具作者自己說得清楚的東西，不變量不是。

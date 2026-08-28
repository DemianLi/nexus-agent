# @nexus/plugin-validation

兩件事，射程刻意不同：**工具失敗變成一則回饋而不是整場 run 死掉**，以及（選加）
**工具成功的輸出合不合它宣告的 schema**。

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

`schemas` 可以整個省略。省略時這個 plugin 只剩圍堵那一半——**而那一半本身就值得掛**，
理由見下一節。

## 為什麼圍堵是必要的

**nexus-agent 裡任何一個工具拋錯，整場 `invoke()` 都會 reject。** 沒有 ToolMessage、
沒有回饋、模型不知道發生過什麼。這不是「還沒做的功能」，是兩件事湊出來的迴歸：

1. `ToolNode.runTool` 只要 `this.wrapToolCall` 存在，就把**工具自己**拋的錯當成
   middleware 的錯（`langchain@1.5.10`，`dist/agents/nodes/ToolNode.js:275-282`），
   而 `#handleError:150` 對 middleware 的錯是 `handleToolErrors !== true` 即重拋。
   `ReactAgent` 建 `ToolNode` 時只傳 `{ signal, wrapToolCall }`（`:174-179`），
   **`handleToolErrors: true` 經由 `createAgent` 根本設不進去**。
2. `createDeepAgent` 永遠掛 `FilesystemMiddleware`，而它永遠帶 `wrapToolCall`
   （`deepagents@1.13.1`）。

實測的對照組講得最清楚：同一個會拋的工具，**沒有 middleware** 時換來一則
`Error: ...` 的 ToolMessage；**加一個什麼都不做的 `wrapToolCall`** 之後，整場 reject。

dsh 把相反的行為寫成不可違反的性質——「未知工具和抛出异常的工具都会变为结构化错误……
**调用失败但不终止当前轮次**」（`docs/subsystems/tools.zh.md`）。這個 plugin 就是把
那句話搬回來。

`apps/harness/src/validation.test.ts` 的第一條測試是**基座現況的絆索**：它斷言沒掛
plugin 時整場會死。哪天基座改了主意，那一條會紅——那時該做的是刪掉圍堵，不是修測試。

## 兩個 middleware，兩個位置

| middleware | 位置 | 管什麼 |
| --- | --- | --- |
| `nexusToolFailureContainment` | `prepend`，最外 | 內層任何一處拋錯 → `status: 'error'` 的 ToolMessage |
| `nexusToolOutputSchema` | 最內 | 成功的輸出合不合宣告的 schema |

外圍內驗不是美學。校驗器自己的 bug 一樣會讓整場 run 死掉（`wrapToolCall` body 裡的
例外走的是同一條路），而圍堵在最外剛好接得住它——包含**別的 plugin** 的 middleware
出的錯。基座自己那幾個 middleware 永遠排在所有 plugin 之前，接不到，那是
`createDeepAgent` 的組裝順序，不是這裡能決定的事。

## 這裡擋得住什麼、擋不住什麼

**擋得住**：工具實作拋的例外、內層 plugin middleware 拋的例外、成功輸出不合宣告的
schema（含「根本不是合法 JSON」）、校驗器自己壞掉（fail-closed，變成一則錯誤而不是靜默放行）。

**刻意放行**：LangGraph 的控制流。`interrupt()` 是用拋例外實作的，圍堵靠
`isGraphBubbleUp` 認出它並原樣往外拋——不分辨的話 HITL 的核准點會**無聲消失**，
變成一則假的錯誤訊息。

**擋不住**：基座自己那層 middleware 拋的錯（位置在我們外面）、以及沒有列進 `schemas`
的工具的輸出（**明文放行**，別把掛了這個 plugin 當成「所有工具都驗過了」）。

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

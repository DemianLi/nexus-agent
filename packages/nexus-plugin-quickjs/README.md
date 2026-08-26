# @nexus/plugin-quickjs

在一個沒有外界的 [QuickJS](https://bellard.org/quickjs/) 直譯器（WASM）裡求值一段
JavaScript，以 `run_javascript` 註冊到 `registry.tools`。

## 用法

```ts
import { createQuickJsPlugin } from '@nexus/plugin-quickjs';

export default [
  createQuickJsPlugin({
    timeoutMs: 1_000,
    memoryLimitBytes: 16 * 1024 * 1024,
    maxStackSizeBytes: 512 * 1024,
  }),
];
```

三個都可以省略，預設值就是上面那組（`DEFAULT_TIMEOUT_MS`、
`DEFAULT_MEMORY_LIMIT_BYTES`、`DEFAULT_MAX_STACK_SIZE_BYTES`）。

`apply` 是 async 的，唯一的理由是在**載入期**把 WASM 模組拉起來——載不起來就讓整份
plugin 清單載入失敗，而不是等模型第一次呼叫工具時才在對話中間變成一句錯誤字串。

## 邊界有多寬

跟 `ContainedFilesystemBackend` 那句「policy fence 不是 kernel boundary」同一種宣告：
**說清楚這裡擋得住什麼、擋不住什麼。**

**能力邊界是真的。** QuickJS 是一個裸的 ECMAScript 引擎。VM 裡沒有 `require`、沒有
`fetch`、沒有 `process`、沒有 `setTimeout`，也沒有 `import`（沒掛 module loader）。
**邊界的寬度等於 bridge 進去的 host function 數量，目前是零**——這個套件不提供加
host function 的介面，要加就得改它的原始碼。

**資源邊界只有設定的那麼強。** 無限迴圈與吃記憶體不是 QuickJS 自己會擋的事，是上面
那三個上限擋的。三個都有預設值，但改小改大都由呼叫端決定。三條各自對應一種耗盡方式：

| 上限 | 擋的是 | 撞到時 VM 回的 |
| --- | --- | --- |
| `timeoutMs` | 跑不完的迴圈 | `InternalError: interrupted`（翻成「執行超過 N 毫秒的上限」） |
| `memoryLimitBytes` | 吃堆積 | `InternalError: out of memory` |
| `maxStackSizeBytes` | 無窮遞迴 | `InternalError: stack overflow` |

堆疊與記憶體刻意分成兩個參數：無窮遞迴吃的是前者，只設記憶體上限擋不住它。

**逾時期間主執行緒是塞住的。** `evalCode` 是同步呼叫，中斷靠 QuickJS 執行中回呼的
interrupt handler。所以 `timeoutMs` 是「最多塞住多久」，不是「多久之後在背景被砍掉」。

**非同步的程式碼跑得完，但等不到外界。** 求值之後會把微任務佇列跑完
（`executePendingJobs()`），所以 `async` 函式與 promise 鏈拿得到值。跑完還是 pending 的
promise 代表它在等一個 VM 裡不存在的東西，那是永遠不會變的狀態，工具會照實說。

## 為什麼是 custom tool，不是 sandbox backend

基座有 sandbox backend 協定（`SandboxBackendProtocolV2`），但那條線走不通：
`createFilesystemMiddleware` 在 `permissions` 非空、`execute` 工具開著、而 backend 又通過
`isSandboxBackend()` 時**直接拋錯**（`deepagents@1.13.1`，
`dist/langsmith-zm0ILQsV.js:2368`），除非所有規則路徑都收斂在 `CompositeBackend` 的
route 前綴下。做成 backend 會讓 `permissions` 擴充點與這個能力互斥，現有的權限驗收
會在**組裝期**炸掉。

custom tool 完全不經過那條路——基座明文「custom tools from the agent or other
middleware are left untouched」。絆索測試在
[`apps/harness/src/sandbox-backend-conflict.test.ts`](../../apps/harness/src/sandbox-backend-conflict.test.ts)。

工具名因此**刻意不叫 `execute`**：那是基座 `FILESYSTEM_TOOL_NAMES` 裡的名字。

## 與 dsh 的偏離

這是**結構性偏離**，不是細節不同。dsh 的 sandbox（`packages/sandbox/*`、
`packages/shell/*-sandbox`）是把子行程的 argv 包進**核心級**的檔案效果策略（Linux
bwrap/Landlock、macOS Seatbelt、Windows ACL 受限 token）。它整個 repo grep `quickjs`
零命中——**dsh 沒有「JS 直譯器」這個 seam**，它有的那一個正是開發計劃第 7 節決策 3
延後掉的那一個（shell 沙箱，等容器隔離方案明朗）。

所以這裡沒有可照抄的 dsh 做法，退到最接近的實作：**用行程內的 WASM 直譯器換掉「跑
任意 shell 指令」**。可以對齊的先例只有詞彙——dsh 的 `SandboxMode` 三個模式與
`ContainedFilesystemBackend` 已落地的三個一字不差，但那條軸線管的是檔案效果，這個
套件一格都沒碰（它根本碰不到檔案系統）。

**套件名也因此不叫 `plugin-sandbox`**，雖然分支照計劃叫 `feat/sandbox-plugin`：叫它
sandbox 等於宣稱一個這裡沒有填的 seam。

## 明文限制

- **沒有檔案系統。** VM 讀不到也寫不到任何檔案。要讓模型把算出來的東西留下來，走基座
  內建的 `write_file`——兩個工具在同一輪裡並用是通的
  （[`apps/harness/src/quickjs.test.ts`](../../apps/harness/src/quickjs.test.ts)）。
- **沒有網路。**
- **每次呼叫一個新 VM。** 兩次呼叫之間不共用狀態，前一次留在 global 上的東西下一次
  看不到。資源預算因此也是每次乾淨一份，而不是跨呼叫累計。
- **不登記關機清理。** 沒有活的 handle 要收：WASM 模組是 `getQuickJS()` 快取住的行程級
  單例，runtime 與 context 現建現拆。`lifecycle` 通道是給 `@nexus/plugin-mcp` 那種有
  子行程要收的 plugin 的。

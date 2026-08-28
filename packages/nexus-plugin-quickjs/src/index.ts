/**
 * `@nexus/plugin-quickjs`——在 WASM 裡的 QuickJS 直譯器上跑一段 JavaScript。
 *
 * **套件名不叫 `plugin-sandbox`，是刻意的。** 計劃裡這條分支叫 `feat/sandbox-plugin`，
 * 但「sandbox」在 dsh 的詞彙裡指的是**行程沙箱**（見底下的偏離說明），叫它 sandbox 等於
 * 宣稱一個這裡沒有填的 seam。這個套件只填其中一格：一個沒有 ambient 能力的 JS 直譯器。
 *
 * **與 dsh 的偏離**（AGENTS.md 的偏離規則）—— 這是**結構性偏離**，不是細節不同：
 * dsh 的 sandbox（`packages/sandbox/*`、`packages/shell/*-sandbox`）是把子行程的 argv
 * 包進**核心級**的檔案效果策略（Linux bwrap/Landlock、macOS Seatbelt、Windows ACL 受限
 * token）。它整個 repo grep `quickjs` 零命中——**dsh 沒有「JS 直譯器」這個 seam**，它有的
 * 那一個正是計劃第 7 節決策 3 延後掉的那一個（shell 沙箱，等容器方案明朗）。所以這裡沒有
 * 可照抄的 dsh 做法，退到最接近的實作：**用行程內的 WASM 直譯器換掉「跑任意 shell 指令」**。
 * 可以對齊的先例只有詞彙——dsh 的 `SandboxMode` 三個模式與
 * `ContainedFilesystemBackend` 已落地的三個一字不差，但那條軸線管的是檔案效果，這個
 * 套件一格都沒碰（它根本碰不到檔案系統）。
 *
 * **為什麼不走 `SandboxBackendProtocolV2`。** 基座確實有 sandbox backend 協定，但
 * `createFilesystemMiddleware` 在 `permissions` 非空、`execute` 工具開著、而 backend
 * 又通過 `isSandboxBackend()` 時**直接拋錯**（`deepagents@1.13.1`，
 * `dist/langsmith-zm0ILQsV.js:2368`），除非所有規則路徑都收斂在 `CompositeBackend` 的
 * route 前綴下。也就是說把這個能力做成 backend，會讓 `permissions` 擴充點與它互斥——
 * 現有的 `permissions` 行為驗收會在**組裝期**炸掉。做成 custom tool 則完全不經過那條路：
 * 基座明文「custom tools from the agent or other middleware are left untouched」。
 * 絆索測試見 `apps/harness/src/sandbox-backend-conflict.test.ts`。
 *
 * **邊界有多寬，這裡說清楚**（與 `ContainedFilesystemBackend` 那句「policy fence 不是
 * kernel boundary」同一個位置的誠實宣告）：
 *
 * - **能力邊界是真的**。QuickJS 是一個裸的 ECMAScript 引擎，VM 裡沒有 `require`、沒有
 *   `fetch`、沒有 `process`、沒有 `import`（沒掛 module loader）。**邊界的寬度等於
 *   bridge 進去的 host function 數量，目前是零**——這個套件不提供加 host function 的
 *   介面，要加就得改這裡的原始碼。
 * - **資源邊界只有設定的那麼強**。無限迴圈與吃記憶體不是 QuickJS 自己會擋的事，是
 *   {@link QuickJsPluginOptions.timeoutMs} 與 {@link QuickJsPluginOptions.memoryLimitBytes}
 *   擋的。兩個都有預設值，但**改小改大都由呼叫端決定**。
 * - **逾時期間主執行緒是塞住的**。`evalCode` 是同步呼叫，中斷靠 QuickJS 執行中回呼的
 *   interrupt handler。所以 `timeoutMs` 是「最多塞住多久」，不是「多久之後在背景被砍掉」。
 * - **`timeoutMs` 的精度等於「最長的那一個操作」**。handler 只在兩次操作之間被回呼，單一
 *   次巨量配置跑多久不歸它管。所以擋「瘋狂配置記憶體」的是
 *   {@link QuickJsPluginOptions.memoryLimitBytes} 而不是逾時——**兩個上限不能互相代替**，
 *   各有一條測試釘住（`index.test.ts` 的「資源邊界」）。
 */

import { tool } from '@langchain/core/tools';
import type { NexusPlugin, PluginRegistry } from '@nexus/core';
import { getQuickJS, shouldInterruptAfterDeadline } from 'quickjs-emscripten';
import type { QuickJSContext, QuickJSHandle } from 'quickjs-emscripten';
import { z } from 'zod';

/** 這個 plugin 宣告的能力名。要相依它的 plugin 把這個字串放進自己的 `requires`。 */
export const QUICKJS_CAPABILITY = 'quickjs';

/**
 * 註冊出來的工具名。
 *
 * **刻意不叫 `execute`**：那是基座 `FILESYSTEM_TOOL_NAMES` 裡的名字（sandbox backend 的
 * shell 執行）。撞名會在 registry 撞掉，而且對模型來說兩件事的語義差很遠——一個跑 shell
 * 指令，一個 eval 一段沒有外界的 JavaScript。
 */
export const RUN_JAVASCRIPT_TOOL_NAME = 'run_javascript';

/** 一次求值的預設時間上限。 */
export const DEFAULT_TIMEOUT_MS = 1_000;

/** 一個 VM 的預設記憶體上限。 */
export const DEFAULT_MEMORY_LIMIT_BYTES = 16 * 1024 * 1024;

/** 一個 VM 的預設堆疊上限。 */
export const DEFAULT_MAX_STACK_SIZE_BYTES = 512 * 1024;

export interface QuickJsPluginOptions {
  /**
   * 一次求值最多跑多久，毫秒。省略即 {@link DEFAULT_TIMEOUT_MS}。
   *
   * 這是**主執行緒被塞住的上限**，不是背景逾時，而且精度等於「最長的那一個操作」——
   * 見本檔頂端的邊界說明。瘋狂配置記憶體的程式擋不住，那是
   * {@link QuickJsPluginOptions.memoryLimitBytes} 的工作。
   */
  readonly timeoutMs?: number;
  /**
   * 一個 VM 最多配置多少記憶體，位元組。省略即 {@link DEFAULT_MEMORY_LIMIT_BYTES}。
   */
  readonly memoryLimitBytes?: number;
  /**
   * 一個 VM 的堆疊上限，位元組。省略即 {@link DEFAULT_MAX_STACK_SIZE_BYTES}。
   *
   * 與記憶體上限分開的理由是無窮遞迴吃的是堆疊不是堆積，只設前者擋不住它。
   */
  readonly maxStackSizeBytes?: number;
}

/**
 * 建一個 QuickJS plugin。
 *
 * `apply` 是 async 的，唯一的理由是**在載入期就把 WASM 模組拉起來**。載不起來就讓整份
 * plugin 清單載入失敗，而不是等模型第一次呼叫工具時才在對話中間變成一句錯誤字串——
 * 共同軸線的 fail-closed 在這個 plugin 上的樣子。模組本身是 `getQuickJS()` 快取住的
 * 行程級單例，重複掛載不會重複載入。
 *
 * **這裡刻意不接 `lifecycle.onDispose`。** 那條通道是給「有活的 handle 要收」的 plugin
 * 的（`@nexus/plugin-mcp` 的 stdio 子行程）。這裡沒有：WASM 模組是行程級快取，runtime 與
 * context 是**每次呼叫現建現拆**、在 `finally` 裡收掉。登記一個什麼都不做的 disposer
 * 只會讓關機清單看起來比實際上熱鬧。
 *
 * @param options - 資源上限。
 * @returns 可以放進組裝點清單的 plugin。
 */
export function createQuickJsPlugin(options: QuickJsPluginOptions = {}): NexusPlugin {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const memoryLimitBytes = options.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES;
  const maxStackSizeBytes = options.maxStackSizeBytes ?? DEFAULT_MAX_STACK_SIZE_BYTES;

  return {
    name: 'quickjs',
    async apply(registry: PluginRegistry): Promise<void> {
      const quickjs = await getQuickJS();

      registry.capabilities.provide(QUICKJS_CAPABILITY);
      registry.tools.register(
        tool(
          ({ code }) => runInVm(quickjs, code, { timeoutMs, memoryLimitBytes, maxStackSizeBytes }),
          {
            name: RUN_JAVASCRIPT_TOOL_NAME,
            description:
              '在一個隔離的 QuickJS 直譯器裡求值一段 JavaScript，回傳最後一個運算式的值。' +
              `VM 裡沒有檔案系統、沒有網路、沒有 require / import / process，只有標準的 ECMAScript。` +
              `執行超過 ${timeoutMs} 毫秒會被中斷。`,
            schema: z.object({
              code: z.string().describe('要求值的 JavaScript。最後一個運算式的值就是回傳值。'),
            }),
          },
        ),
      );
    },
  };
}

/** {@link runInVm} 用到的那幾個上限。 */
interface VmLimits {
  readonly timeoutMs: number;
  readonly memoryLimitBytes: number;
  readonly maxStackSizeBytes: number;
}

/**
 * 在一個現建現拆的 VM 裡求值，把結果或錯誤翻成一句給模型看的字串。
 *
 * **每次呼叫一個新 runtime**，不是共用一個。理由是隔離：共用的話前一次呼叫留在 global
 * 上的東西下一次看得到，而且記憶體上限會變成跨呼叫累計的——第五次呼叫因為第一次配置的
 * 東西而失敗，那個錯誤訊息沒有人讀得懂。代價是每次都要建 runtime，換來的是每次呼叫的
 * 資源預算都是乾淨的。
 */
function runInVm(
  quickjs: Awaited<ReturnType<typeof getQuickJS>>,
  code: string,
  limits: VmLimits,
): string {
  // deadline 在建 runtime 的時候才算，不是在建 plugin 的時候——`shouldInterruptAfterDeadline`
  // 收的是一個絕對時刻，提早算等於把載入到呼叫之間的時間也算進預算裡。
  const runtime = quickjs.newRuntime({
    interruptHandler: shouldInterruptAfterDeadline(Date.now() + limits.timeoutMs),
    memoryLimitBytes: limits.memoryLimitBytes,
    maxStackSizeBytes: limits.maxStackSizeBytes,
  });

  try {
    const context = runtime.newContext();
    try {
      const result = context.evalCode(code);
      if (result.error)
        return consume(context, result.error, (detail) => formatError(detail, limits));

      // **求值完要把微任務佇列跑完**，否則 `async` 函式與 promise 鏈全部停在 pending，
      // 模型拿到的是「沒完成」而不是答案。QuickJS 裡沒有計時器也沒有 IO，所以佇列裡只會
      // 有純計算的 microtask——跑得完的一定跑得完，跑不完的（等外界的）本來就永遠等不到。
      // 這一步同樣受 interrupt handler 管，所以它不是逾時的漏洞。
      const pending = runtime.executePendingJobs();
      if (pending.error)
        return consume(context, pending.error, (detail) => formatError(detail, limits));

      return formatResult(context, result.value, limits);
    } finally {
      context.dispose();
    }
  } finally {
    runtime.dispose();
  }
}

/**
 * 求值結果翻成一句話。**promise 與一般值分兩條路。**
 *
 * 判準是 `getPromiseState()` 而不是「dump 出來長不長得像 promise」。基座的 `dump()` 會把
 * promise 攤成 `{ type, value }` / `{ type }` / `{ type, error }`，但那個形狀**一般物件也戴
 * 得起來**——`({ type: 'pending' })` 是完全正常的回傳值，靠形狀猜會把它讀成「一個永遠不會
 * 完成的 promise」。`getPromiseState()` 問的是引擎，非 promise 會拿到 `notAPromise: true`。
 *
 * **handle 的歸屬照它的配置契約**（`quickjs-emscripten-core@0.32.0` 實測）：`notAPromise`
 * 時 `state.value` 就是傳進來的那個 handle，沒有新東西；`fulfilled` 與 `rejected` 則各自
 * **新配一個** result handle，那兩個要自己收，原本的 promise handle 也要收。
 */
function formatResult(context: QuickJSContext, handle: QuickJSHandle, limits: VmLimits): string {
  const state = context.getPromiseState(handle);

  if (state.type === 'fulfilled' && state.notAPromise === true) {
    return consume(context, handle, formatValue);
  }

  try {
    // 微任務佇列已經跑完了還是 pending，代表它在等一個 VM 裡不存在的東西（計時器、IO）。
    // 這是永遠不會變的狀態，講清楚比讓模型再等一次好。
    if (state.type === 'pending') {
      return '（回傳了一個永遠不會完成的 promise——VM 裡沒有計時器也沒有 IO）';
    }
    // 被 reject 的 promise 走跟 throw 一樣的措辭——對模型來說兩者是同一件事。
    if (state.type === 'rejected') {
      return consume(context, state.error, (detail) => formatError(detail, limits));
    }
    return consume(context, state.value, formatValue);
  } finally {
    if (handle.alive) handle.dispose();
  }
}

/**
 * 把一個 handle dump 成原生值、交給 `format`，然後收掉它。
 *
 * **`dispose()` 前要問 `alive`**：`dump()` 碰到 promise 時會自己把 handle 收掉（三種狀態
 * 都是，`quickjs-emscripten-core@0.32.0` 的 `QuickJSContext#dump` 實測），再收一次會拿到
 * `QuickJSUseAfterFree`。這條是測試打出來的——`import("node:fs")` 求值出一個 promise，
 * 而原本那版無條件 dispose，當場炸在使用者看得到的地方。
 */
function consume(
  context: QuickJSContext,
  handle: QuickJSHandle,
  format: (detail: unknown) => string,
): string {
  const detail = context.dump(handle);
  if (handle.alive) handle.dispose();
  return format(detail);
}

/**
 * 把 VM 丟出來的錯誤翻成一句話。
 *
 * 中斷是唯一被特別點名的一種：QuickJS 把它報成 `InternalError: interrupted`，而那句話
 * 沒告訴模型「是你的程式跑太久」還是「引擎壞了」。其餘的原樣轉述——`ReferenceError:
 * require is not defined` 這種訊息本身就是模型需要的答案。
 */
function formatError(detail: unknown, limits: VmLimits): string {
  const asRecord =
    typeof detail === 'object' && detail !== null ? (detail as Record<string, unknown>) : {};
  const name = typeof asRecord.name === 'string' ? asRecord.name : '';
  const message = typeof asRecord.message === 'string' ? asRecord.message : String(detail);

  if (name === 'InternalError' && message === 'interrupted') {
    return `錯誤：執行超過 ${limits.timeoutMs} 毫秒的上限，已中斷。`;
  }
  return `錯誤：${name === '' ? message : `${name}: ${message}`}`;
}

/**
 * 把一個非 promise 的值翻成一句話。
 *
 * `undefined` 要有自己的講法：JSON 序列化它得到的是 `undefined`（不是字串），直接回傳等於
 * 給模型一個空回應，讀起來像工具壞了。而「這段程式沒有回傳值」是正常且常見的結果。
 */
function formatValue(value: unknown): string {
  if (value === undefined) return '（沒有回傳值）';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    // 迴圈參照之類 JSON 表達不出來的東西。回傳值本身不是錯誤，所以不走 formatError。
    return String(value);
  }
}

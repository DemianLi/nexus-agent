/**
 * tracing 披露。
 *
 * **這裡沒有任何「接線」，因為根本不需要。** `@langchain/core` 的
 * `CallbackManager.configure` 自己讀環境變數：`isTracingEnabled()` 為真就
 * `new LangChainTracer()` 掛進 handler 清單（1.2.9，`dist/callbacks/manager.js:523-541`）。
 * 我們一行程式碼都不寫，agent 跑起來就已經在往外送——送的是 inputs / outputs 原文，
 * 工具參數與檔案內容都在裡面（`tracing.test.ts` 有實測）。
 *
 * 這個模組做的是**披露**，形狀照 dsh 的共享披露
 * （`docs/subsystems/session-telemetry.zh.md`）：後端必須說出當前的共享策略，而且
 * **只陳述策略、不承諾投遞**。所以下面這幾行只講「這個 process 現在的設定是什麼」，
 * 不講「東西會不會真的到」——那歸 langsmith 的 SDK，不歸我們。
 *
 * 三件事刻意不做：
 *
 * 1. **不印 API key**，一個字元都不印。
 * 2. **不宣稱終點**，除非環境變數自己指名。終點的解析順序是
 *    `LANGSMITH_ENDPOINT` / `LANGCHAIN_ENDPOINT` → `~/.langsmith/config.json` 的
 *    `api_url` → `https://api.smith.langchain.com`（`langsmith@0.9.0`，
 *    `dist/client.js:911-918` ＋ `dist/utils/profiles.js:23,252`）。**磁碟上那份 profile
 *    是第二個寫入者**，這支程式看不到它，所以環境變數沒指名時只說「這裡看不到」，
 *    不說「預設端點」——後者會在有 profile 的機器上說謊。
 * 3. **不替使用者關掉它。** 開關是部署方的事；我們的職責到「說出來」為止。
 */

/**
 * 會讓基座掛上 tracer 的環境變數，**四個都要 `=== 'true'`**。
 *
 * 抄自 `@langchain/core@1.2.9` 的 `dist/utils/callbacks.js`。刻意抄而不是自己想一組：
 * 判定「有沒有在送」的清單與基座的清單一旦分岔，披露就會說反話。順序也照抄——
 * 它用 `find`，所以第一個命中的那個就是「誰開的」。
 */
export const TRACING_ENV_VARS = [
  'LANGSMITH_TRACING_V2',
  'LANGCHAIN_TRACING_V2',
  'LANGSMITH_TRACING',
  'LANGCHAIN_TRACING',
] as const;

/** `LANGSMITH_<name>` 找不到就退到 `LANGCHAIN_<name>`（`langsmith` 的 `getLangSmithEnvironmentVariable`）。 */
function langsmithVar(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[`LANGSMITH_${name}`] || env[`LANGCHAIN_${name}`] || undefined;
}

/** 這個 process 現在的 tracing 設定。 */
export interface TracingDisclosure {
  /** 基座會不會掛上 tracer。 */
  readonly enabled: boolean;
  /** 是哪個環境變數開的；關著就是 `undefined`。 */
  readonly enabledBy?: string;
  /** 環境變數指名的終點；沒指名就是 `undefined`——**不代表是預設終點**，見模組說明第 2 點。 */
  readonly endpoint?: string;
  /** 專案名。 */
  readonly project?: string;
  /** `LANGSMITH_HIDE_INPUTS` / `LANGCHAIN_HIDE_INPUTS` 為 `'true'`：inputs 整組變成 `{}`。 */
  readonly inputsHidden: boolean;
  /** 同上，outputs。 */
  readonly outputsHidden: boolean;
}

/**
 * 讀出當前設定。
 *
 * @param env - 環境變數；測試傳假的進來，正式跑傳 `process.env`。
 * @returns 這個 process 的 tracing 設定。
 */
export function readTracingDisclosure(env: NodeJS.ProcessEnv): TracingDisclosure {
  const enabledBy = TRACING_ENV_VARS.find((name) => env[name] === 'true');
  return {
    enabled: enabledBy !== undefined,
    enabledBy,
    endpoint: langsmithVar(env, 'ENDPOINT'),
    project: langsmithVar(env, 'PROJECT'),
    inputsHidden: langsmithVar(env, 'HIDE_INPUTS') === 'true',
    outputsHidden: langsmithVar(env, 'HIDE_OUTPUTS') === 'true',
  };
}

/**
 * 把設定寫成要印出來的幾行。
 *
 * 關著的時候只有一行，而且那一行是**肯定句**：沒掛東西就明說沒掛，不留白。dsh 的
 * 共享披露規定「沒掛任何遙測服務時才渲染未配置」——留白與「關著」在畫面上分不出來，
 * 那正是 #71 的 CLI 對中斷一個字都不印的同一個毛病。
 *
 * @param disclosure - {@link readTracingDisclosure} 的結果。
 * @returns 要逐行印出去的字串。
 */
export function formatTracingDisclosure(disclosure: TracingDisclosure): readonly string[] {
  if (!disclosure.enabled) {
    return ['追蹤：關閉——這一輪不會有東西離開這台機器。'];
  }

  const destination =
    disclosure.endpoint ?? '終點由 ~/.langsmith/config.json 或 LangSmith 預設決定，這支程式看不到';
  const project = disclosure.project === undefined ? '' : `，專案 ${disclosure.project}`;
  const lines = [`追蹤：開啟（${disclosure.enabledBy}）→ ${destination}${project}`];

  if (disclosure.inputsHidden && disclosure.outputsHidden) {
    lines.push('追蹤：  inputs 與 outputs 整組隱藏，送出去的只剩結構與時間。');
  } else if (disclosure.inputsHidden || disclosure.outputsHidden) {
    const hidden = disclosure.inputsHidden ? 'inputs' : 'outputs';
    const shown = disclosure.inputsHidden ? 'outputs' : 'inputs';
    lines.push(`追蹤：  ${hidden} 整組隱藏，但 ${shown} 仍是原文。`);
  } else {
    lines.push('追蹤：  inputs 與 outputs 原文送出，工具參數與讀到的檔案內容都在裡面。');
  }

  lines.push('追蹤：  這只是這個 process 現在的設定，不保證送得到、也不管送到之後留多久。');
  return lines;
}

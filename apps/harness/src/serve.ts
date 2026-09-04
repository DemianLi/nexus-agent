/**
 * 把 agent 掛上 HTTP，給 `apps/web` 連。
 *
 *   pnpm --filter @nexus/harness run serve             # 假模型
 *   pnpm --filter @nexus/harness run serve:live        # 換成真實供應商
 *
 * **組裝完全沿用 CLI 的那一份**（`createCliAgent`）：同一份預設 plugin 清單、同一個
 * `--live` 開關、同一個 `--workspace`。理由是這裡沒有新的組裝決定要做——「web 要跑
 * 哪些 plugin」與「CLI 要跑哪些 plugin」是同一個問題，而它的答案等**外部**設定機制
 * 才有地方講（[#46](https://github.com/DemianLi/nexus-agent/issues/46)；
 * [#104](https://github.com/DemianLi/nexus-agent/issues/104) 給的 `id` 與 `disabled`
 * 都寫在清單的程式碼裡，換不了「跑哪一份清單」這件事）。
 *
 * **一個 thread 一個 agent，關掉 server 時一起清。** `createNexusAgent` 回的
 * `dispose` 在這裡才真的有意義——MCP plugin 底下是 stdio 子行程，而這是一個長命的
 * 行程，漏了不會有任何錯誤訊息。
 *
 * 假模型下的限制與 CLI 的 REPL 一樣：`CLI_SCRIPT` 只有四輪，問到後面
 * `ScriptedChatModel` 會當場失敗而不是靜默重播。**那個失敗會以
 * `lifecycle failed` 上線**，所以瀏覽器那端看得到原因，不是一片空白。
 */

import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NexusPlugin, SessionRegistry } from '@nexus/core';
import { DEFAULT_PLUGINS, createCliAgent, loadPluginModule, resolveSessionLogDir } from './cli.js';
import { createJsonlSessionStore } from './jsonl-session-store.js';
import { attachSessionPersistence } from '@nexus/core';
import { LIVE_MODEL_ID } from './live-model.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';
import { startWireServer } from './wire-server.js';
import type { WireServer } from './wire-server.js';
import { formatTelemetryDisclosure } from './telemetry-disclosure.js';
import { formatTracingDisclosure, readTracingDisclosure } from './tracing.js';

/** 預設 port。挑一個不常撞的，`--port` 蓋得掉。 */
export const DEFAULT_PORT = 8787;

export interface ServeInvocation {
  readonly live: boolean;
  readonly port: number;
  readonly workspace?: string;
  readonly pluginModule?: string;
  readonly sessionLog?: string;
  readonly help: boolean;
}

const USAGE = `用法：
  pnpm --filter @nexus/harness run serve [選項]

選項：
  --live               換成真實供應商（${LIVE_MODEL_ID}），需要 API key
  --plugins <module>   從指定模組載 plugin 清單（預設匯出一個陣列）
  --workspace <dir>    把檔案落在這個目錄底下（省略即虛擬檔案系統）
  --session-log <dir>  把會話日誌寫進這個目錄（省略即只在記憶體裡）
  --port <n>           監聽的 port，預設 ${DEFAULT_PORT}
  --help               印這段話

按 Ctrl-C 結束——收線時會把每個 thread 的 agent 一起清掉。`;

export function parseServeArgs(argv: readonly string[]): ServeInvocation {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        live: { type: 'boolean', default: false },
        plugins: { type: 'string' },
        workspace: { type: 'string' },
        'session-log': { type: 'string' },
        port: { type: 'string' },
        help: { type: 'boolean', default: false },
      },
    });
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
  }

  const { values } = parsed;
  if (values.plugins !== undefined && values.plugins.trim() === '') {
    throw new Error(`--plugins 要給一個模組路徑。\n\n${USAGE}`);
  }
  if (values.workspace !== undefined && values.workspace.trim() === '') {
    throw new Error(`--workspace 要給一個目錄路徑。\n\n${USAGE}`);
  }
  if (values['session-log'] !== undefined && values['session-log'].trim() === '') {
    throw new Error(`--session-log 要給一個目錄路徑。\n\n${USAGE}`);
  }

  const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`--port 要給 0 到 65535 之間的整數，收到 "${values.port}"。\n\n${USAGE}`);
  }

  return {
    live: values.live === true,
    port,
    ...(values.plugins !== undefined && { plugins: values.plugins, pluginModule: values.plugins }),
    ...(values.workspace !== undefined && { workspace: values.workspace }),
    ...(values['session-log'] !== undefined && { sessionLog: values['session-log'] }),
    help: values.help === true,
  };
}

export interface RunServeOptions {
  readonly argv: readonly string[];
  readonly cwd?: string;
  readonly log?: (line: string) => void;
  readonly env?: NodeJS.ProcessEnv;
}

export interface RunningServe {
  readonly url: string;
  close(): Promise<void>;
}

/**
 * 起一台 server。
 *
 * @returns 它的位址與收掉它的方法；`--help` 時回 undefined（只印用法）。
 */
export async function runServe(options: RunServeOptions): Promise<RunningServe | undefined> {
  const log = options.log ?? ((line: string) => console.log(line));
  const invocation = parseServeArgs(options.argv);
  if (invocation.help) {
    log(USAGE);
    return undefined;
  }

  // **在載 plugin、開 server 之前解析**，同 `cli.ts` 那條的理由：一個指錯地方的
  // `--session-log` 該在什麼都還沒起來的時候就講。同一個函式，所以「日誌不能落在
  // `--workspace` 底下」那條檢查兩個入口共用一份。
  const cwd = options.cwd ?? process.cwd();
  const sessionLogDir = resolveSessionLogDir(invocation, cwd);

  const plugins: readonly NexusPlugin[] =
    invocation.pluginModule === undefined
      ? DEFAULT_PLUGINS
      : await loadPluginModule(invocation.pluginModule, options.cwd);

  // **一個行程一個 store，不是一條 thread 一個。** store 開的是一個 run 目錄，thread
  // 的日誌各自一個檔落在裡面；一條 thread 一個 store 會變成一條 thread 一個目錄，
  // 而目錄名是時間戳加亂數，讀的人無從對回 thread。
  const sessionStore =
    sessionLogDir === undefined ? undefined : createJsonlSessionStore({ rootDir: sessionLogDir });

  let telemetryDisclosed = false;
  const handler = createWireHandler({
    // 一個 thread 一個 agent——各自的 checkpointer、各自的虛擬檔案系統。
    createAgent: async () => {
      // **第四與第五個引數都刻意不傳，而且理由不同。**
      //
      // 第四個（不變量違規往哪裡講）：這條路徑維持 `createInvariantRunner` 的預設
      // （`console.error`），進的是伺服器日誌。CLI 那條要繞過 `Printer` 才印得出前綴，
      // 這裡沒有那個問題——伺服器日誌本來就沒有跟誰搶終端機
      // （[#107](https://github.com/DemianLi/nexus-agent/issues/107)）。
      //
      // 第五個（核准政策）：**這裡維持預設的「有人在」**。CLI 與 eval 關掉它是因為那兩個
      // 入口收不了核准決定，而 web 這端真的按得下去（[#79](https://github.com/DemianLi/nexus-agent/pull/79)
      // 的核准迴圈，`serve.test.ts` 的「核准那份清單」整條走過一遍）。關掉它會把一個
      // 做得出來的功能關掉（[#113](https://github.com/DemianLi/nexus-agent/issues/113)）。
      const {
        agent,
        commands,
        dispose,
        attachTelemetry,
        attachInvariants,
        attachSession,
        telemetrySharing,
      } = await createCliAgent(invocation, plugins, options.cwd);
      // **遙測披露印在這裡而不是啟動時，因為啟動的那一刻答案不存在**：`createAgent` 是
      // lazy 的（`wire-handler.ts` 的 `pumpFor` 第一次收到請求才呼叫），plugin 沒跑過
      // `apply` 就沒有人知道有沒有掛後端。在啟動時印「未配置」會是假的。一個 process
      // 只印一次——每個 thread 一個 agent，但掛的是同一份 plugin 清單。
      if (!telemetryDisclosed) {
        telemetryDisclosed = true;
        for (const line of formatTelemetryDisclosure(telemetrySharing)) log(line);
      }
      return {
        agent: agent as unknown as PumpAgent,
        // **`createCliAgent` 一直都回著這個註冊點，這條路以前把它丟掉了。**
        // 撿起來就是 web 那端打得到 `/plan` 的全部
        // （[#123](https://github.com/DemianLi/nexus-agent/issues/123)）；發派面本身在
        // `wire-handler.ts` 的 `threadFor`，一條 thread 一個執行器。
        commands,
        dispose,
        attachTelemetry,
        attachInvariants,
        attachSession,
        // **落盤的答案不在 `createCliAgent` 的回傳值裡**，它來自呼叫方式而不是 plugin
        // 清單，所以在這個閉包裡接（見 `wire-handler.ts` 的 `attachPersistence`）。
        ...(sessionStore === undefined
          ? {}
          : {
              attachPersistence: (sessions: SessionRegistry) =>
                attachSessionPersistence(sessions, sessionStore, {
                  cwd,
                  // CLI 那條走 `Printer` 是為了前綴分得出誰在講話；這裡沒有那個問題，
                  // 伺服器日誌本來就沒有跟誰搶終端機（同不變量那條的理由）。
                  warn: (message) => {
                    log(`[會話日誌] ${message}`);
                  },
                }),
            }),
      };
    },
  });

  let server: WireServer;
  try {
    server = await startWireServer({ handler, port: invocation.port });
  } catch (error) {
    await handler.close();
    throw error;
  }

  log(`nexus-agent 在 ${server.url}`);
  log(`模型：${invocation.live ? LIVE_MODEL_ID : '假模型（ScriptedChatModel）'}`);
  log(`plugin：${plugins.map((plugin) => plugin.name).join('、') || '（空）'}`);
  // **披露，不是設定。** 不講的話，「這台 server 正在把每一條 thread 的對話寫上磁碟」
  // 與「行程結束就沒了」在畫面上一模一樣。
  log(
    sessionStore === undefined
      ? '會話日誌：只在記憶體裡（行程結束就沒了；--session-log <dir> 可以落盤）'
      : `會話日誌：${sessionStore.directory}`,
  );
  for (const line of formatTracingDisclosure(readTracingDisclosure(options.env ?? process.env))) {
    log(line);
  }

  return {
    url: server.url,
    close: async () => {
      await server.close();
      await handler.close();
    },
  };
}

async function main(): Promise<void> {
  try {
    const running = await runServe({ argv: process.argv.slice(2) });
    if (running === undefined) {
      return;
    }
    // Ctrl-C 要走完 dispose：子行程與檔案控制代碼都掛在那裡。
    const stop = () => {
      void running.close().then(() => {
        process.exitCode = 0;
      });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

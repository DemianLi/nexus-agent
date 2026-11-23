/**
 * 一台 stdio MCP server 交給宿主（`native/sandbox-spawner/host`，#2570 D2b-2）的那一段 `connection`。
 *
 * 宿主不算政策、不疊自己的環境，原樣照這裡的成品起子行程（`env_clear` 之後只放 `env`）：
 *
 * - `command`／`args`：呼叫端已經照沙箱政策包好的（`wrapStdio`），這裡不重算。`command` 要是絕對路徑；沒被沙箱包裝的 `npx` 這類要先解析成路徑。
 * - `cwd`：一律交絕對路徑。省略就是對話行程的工作目錄（同 TS 的 `StdioClientTransport`），相對路徑照同一個目錄解。
 * - `env`：{@link scrubbedParentEnv} 清過的父環境在前、設定的 `env`（憑證引用已代入）在後，同 `packages/nexus-plugin-mcp/src/connection.ts` 的 `openClient`。
 * - `credentialEnv`：`env` 裡值來自憑證的名字。**只有這些值進宿主的遮蔽器**；`PATH`、`HOME` 這類不進，否則成功結果會被遮得不能用。
 *   每個值照 {@link assertUsableMcpCredential} 檢查（修頭尾空白、不到 8 個字元拒收），交出去的是修過的。
 *
 * 「哪幾個名字是憑證」由呼叫端給：外掛代入憑證時才知道（`credentials.ts` 的 `substituted`），這裡看不出一個字串是不是憑證。
 *
 * @module
 */

import { resolve } from 'node:path';

import { scrubbedParentEnv } from '@nexus/core';

import type { ResolvedCredential } from './credentials.js';
import { assertUsableMcpCredential } from './mcp-credential.js';

/** 一個環境變數的值來自哪把憑證。 */
export interface McpHostCredentialEnv {
  /** 憑證名，錯誤訊息指名它。 */
  readonly credential: string;
  /** 憑證服務解析到的那一筆；`env` 裡那個名字的值要是它修剪後的值（外掛代入的就是修剪後的）。 */
  readonly hit: ResolvedCredential;
}

/** {@link hostStdioConnection} 的輸入。 */
export interface McpHostStdioInput {
  /** 要執行的程式，絕對路徑；沙箱包過的話是包裝程式。 */
  readonly command: string;
  readonly args: readonly string[];
  /** 省略是 `baseCwd`；相對路徑照 `baseCwd` 解。 */
  readonly cwd?: string | undefined;
  /** 對話行程的工作目錄，省略是 `process.cwd()`（呼叫當下才讀）。測試用。 */
  readonly baseCwd?: string;
  /** 設定的 `env`，憑證引用已代入。 */
  readonly env: Readonly<Record<string, string>>;
  /** `env` 裡值來自憑證的：環境變數名 → 那把憑證。每個名字都要在 `env` 裡。 */
  readonly credentialEnv: Readonly<Record<string, McpHostCredentialEnv>>;
  /** 父環境，省略是 `process.env`（呼叫當下才讀）。測試用。 */
  readonly parentEnv?: Readonly<Record<string, string | undefined>>;
}

/** 交給宿主的 `connection`：宿主 `mcp::config` 的 stdio 那一支。 */
export interface McpHostStdioConnection {
  readonly transport: 'stdio';
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly credentialEnv: readonly string[];
}

/**
 * @param input - 見 {@link McpHostStdioInput}。
 * @returns 宿主收的 `connection`。
 * @throws `command` 不是絕對路徑、`credentialEnv` 的名字不在 `env` 裡、`env` 的值不是那把憑證修剪過的值，或憑證值不合 {@link assertUsableMcpCredential}（`InvalidCredentialError`，訊息不含值）。
 */
export function hostStdioConnection(input: McpHostStdioInput): McpHostStdioConnection {
  if (!input.command.startsWith('/')) {
    throw new Error(
      `stdio 的 command 要是絕對路徑（宿主不查 PATH）：${input.command}。沒有沙箱包裝時，請在設定裡寫程式的絕對路徑`,
    );
  }
  const baseCwd = input.baseCwd ?? process.cwd();
  const env: Record<string, string> = {
    ...(input.parentEnv === undefined ? scrubbedParentEnv() : scrubbedParentEnv(input.parentEnv)),
    ...input.env,
  };
  const credentialEnv: string[] = [];
  for (const [name, { credential, hit }] of Object.entries(input.credentialEnv)) {
    if (!Object.hasOwn(input.env, name)) {
      throw new Error(`credentialEnv 的 ${name} 不在 env 裡`);
    }
    const checked = assertUsableMcpCredential(credential, hit, 'env');
    if (input.env[name] !== checked) {
      throw new Error(`env.${name} 的值與憑證 ${credential} 修剪後的值不同`);
    }
    env[name] = checked;
    credentialEnv.push(name);
  }
  return {
    transport: 'stdio',
    command: input.command,
    args: [...input.args],
    cwd: input.cwd === undefined ? baseCwd : resolve(baseCwd, input.cwd),
    env,
    credentialEnv,
  };
}
